import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AirDocument, Claim } from "@anvil/air";
import type { AnvilManifest, OperationManifest } from "@anvil/compiler";
import { z } from "zod";
import type { HarnessFinding, OperationClaim } from "./agent.js";
import { type ReconcileDecision, reconcile } from "./reconcile.js";

/**
 * The recorded-traffic lane: fold a deployed bundle's execution-record spool
 * back into evidence.
 *
 * `observe` meets the running application by appointment — an operator runs a
 * command, opt-in reads are driven, a snapshot is taken. This lane closes the
 * loop the other way round: the serving path spools every execution record it
 * emits (`ANVIL_RECORDS_DIR`, `JsonlRecordSpool`), and this reads the spool
 * and turns what production traffic already proved into `recorded_traffic`
 * claims — the highest-reliability evidence the trust model recognizes,
 * produced by normal operation instead of ceremony.
 *
 * The licensing discipline is `observe`'s, verbatim in spirit: traffic may
 * corroborate freely and may tighten, and the one safety claim it earns is the
 * one it genuinely proves — an operation whose every observed call the
 * application answered with `not_found` is an operation the application says
 * is gone. Nothing here loosens anything, nothing writes AIR, and the output
 * is the same reviewable manifest proposal every other enrichment lane emits.
 */

/**
 * One spooled line: `ExecutionRecord` plus the `at` stamp the spool adds.
 * Parsed tolerantly — unknown fields from a newer runtime are stripped, and a
 * line that does not parse is counted, never fatal: a spool is written by a
 * live process and the last line may be half a record.
 */
export const SpooledRecord = z.object({
  at: z.string().optional(),
  traceId: z.string(),
  operationId: z.string(),
  effect: z.enum(["read", "mutation"]),
  outcome: z.enum(["success", "error", "dry_run"]),
  latencyMs: z.number(),
  retryCount: z.number().int().nonnegative(),
  idempotencyKeyPresent: z.boolean(),
  errorCode: z.string().optional(),
  requestBytes: z.number(),
  responseBytes: z.number(),
  policyDecisions: z.array(z.string()).default([]),
  confirmationRequired: z.boolean(),
  confirmed: z.boolean(),
  ledger: z.enum(["reserved", "replay", "in_progress", "conflict", "none"]).optional(),
});
export type SpooledRecord = z.infer<typeof SpooledRecord>;

/** Per-operation traffic aggregate — the sensor reading. */
export interface TrafficSummary {
  operationId: string;
  calls: number;
  successes: number;
  errors: number;
  dryRuns: number;
  /** Idempotency-ledger replays observed — the dedup path exercised for real. */
  replays: number;
  /** Calls that succeeded after at least one retry. */
  retriedSuccesses: number;
  errorCodes: Record<string, number>;
  firstAt?: string;
  lastAt?: string;
}

export interface TrafficReport {
  schemaVersion: 1;
  startedAt: string;
  finishedAt: string;
  service: string;
  /** The spool directory the records came from. */
  source: string;
  filesRead: number;
  recordsParsed: number;
  malformedLines: number;
  /** Records naming an operation this AIR does not carry (renamed, retired). */
  unknownOperationIds: string[];
  traffic: TrafficSummary[];
  /** Approved operations the spool never saw — the surface nobody uses. */
  unobserved: string[];
  proposal?: AnvilManifest;
  decisions: ReconcileDecision[];
  ok: boolean;
  detail: string;
}

/** Below this many observations a pattern is an anecdote, not evidence: a
 *  single 404 is a typo'd id; the same answer to every one of five calls with
 *  none succeeding is the application answering consistently. */
const MIN_SAMPLES_FOR_CLAIM = 5;

/** Read every *.jsonl file in the spool directory, tolerantly. */
export function readRecordSpool(dir: string): {
  records: SpooledRecord[];
  filesRead: number;
  malformedLines: number;
} {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .sort();
  const records: SpooledRecord[] = [];
  let malformedLines = 0;
  for (const name of files) {
    for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        records.push(SpooledRecord.parse(JSON.parse(line)));
      } catch {
        malformedLines++;
      }
    }
  }
  return { records, filesRead: files.length, malformedLines };
}

/** Aggregate a spool into per-operation summaries, in first-seen order. */
export function summarizeTraffic(records: readonly SpooledRecord[]): TrafficSummary[] {
  const byOp = new Map<string, TrafficSummary>();
  for (const record of records) {
    let s = byOp.get(record.operationId);
    if (!s) {
      s = {
        operationId: record.operationId,
        calls: 0,
        successes: 0,
        errors: 0,
        dryRuns: 0,
        replays: 0,
        retriedSuccesses: 0,
        errorCodes: {},
      };
      byOp.set(record.operationId, s);
    }
    s.calls++;
    if (record.outcome === "success") s.successes++;
    if (record.outcome === "error") s.errors++;
    if (record.outcome === "dry_run") s.dryRuns++;
    if (record.ledger === "replay") s.replays++;
    if (record.outcome === "success" && record.retryCount > 0) s.retriedSuccesses++;
    if (record.errorCode) {
      s.errorCodes[record.errorCode] = (s.errorCodes[record.errorCode] ?? 0) + 1;
    }
    if (record.at) {
      if (!s.firstAt || record.at < s.firstAt) s.firstAt = record.at;
      if (!s.lastAt || record.at > s.lastAt) s.lastAt = record.at;
    }
  }
  return [...byOp.values()];
}

/**
 * What a traffic aggregate licenses. Deliberately as short as `observe`'s
 * list, and for the same reason: recorded traffic's 0.95 reliability must
 * never launder an unrelated loosening through the reconciler. Success traffic
 * corroborates existence (evidence, no patch); the single patch-bearing claim
 * is deprecation, and only when the application answered `not_found` to every
 * one of enough calls that it stopped being an anecdote.
 */
export function trafficLicenses(summary: TrafficSummary): OperationClaim | undefined {
  const notFound = summary.errorCodes.not_found ?? 0;
  // Unanimity is two comparisons: every recorded call errored, and every error
  // was not_found. An earlier spelling also restated `successes === 0`, and
  // the mutation gate proved the restatement dead — errors === calls already
  // forbids a success, and a check that cannot fail is a check that cannot
  // protect anything.
  if (
    summary.calls >= MIN_SAMPLES_FOR_CLAIM &&
    summary.errors === summary.calls &&
    notFound === summary.errors
  ) {
    return { type: "deprecated", value: true, direction: "tighten" };
  }
  return undefined;
}

function evidenceFor(summary: TrafficSummary, source: string): Claim {
  const window =
    summary.firstAt && summary.lastAt ? ` between ${summary.firstAt} and ${summary.lastAt}` : "";
  const codes = Object.entries(summary.errorCodes)
    .map(([code, n]) => `${code}×${n}`)
    .join(", ");
  return {
    subject: summary.operationId,
    predicate: "exists",
    source: "recorded_traffic",
    sourceRef: source,
    method: "observed",
    confidence: 0.95,
    note:
      `${summary.calls} recorded call(s)${window}: ${summary.successes} succeeded, ` +
      `${summary.errors} errored${codes ? ` (${codes})` : ""}, ${summary.replays} idempotency ` +
      `replay(s), ${summary.retriedSuccesses} succeeded after retry.`,
  };
}

export interface RecordsOptions {
  air: AirDocument;
  /** The spool directory `ANVIL_RECORDS_DIR` pointed at. */
  dir: string;
}

/** Run the recorded-traffic lane: spool in, report + proposal out. */
export function runRecords({ air, dir }: RecordsOptions): TrafficReport {
  const startedAt = new Date().toISOString();
  const { records, filesRead, malformedLines } = readRecordSpool(dir);
  const traffic = summarizeTraffic(records);

  const known = new Map(air.operations.map((op) => [op.id, op]));
  const unknownOperationIds = traffic
    .map((s) => s.operationId)
    .filter((id) => !known.has(id))
    .sort();
  const observedIds = new Set(traffic.map((s) => s.operationId));
  const unobserved = air.operations
    .filter((op) => op.state === "approved" && !observedIds.has(op.id))
    .map((op) => op.id);

  const findings: HarnessFinding[] = [];
  for (const summary of traffic) {
    if (!known.has(summary.operationId)) continue;
    const claim = trafficLicenses(summary);
    findings.push({
      operationId: summary.operationId,
      sourceId: "records",
      evidence: evidenceFor(summary, `records:${dir}`),
      ...(claim ? { claim } : {}),
    });
  }

  // The same reconciler `anvil enrich` and `anvil observe` use, so traffic
  // evidence is weighed by the one asymmetric-trust gate rather than a second
  // one that could drift.
  const operations: Record<string, OperationManifest> = {};
  const decisions: ReconcileDecision[] = [];
  for (const op of air.operations) {
    const mine = findings.filter((finding) => finding.operationId === op.id);
    if (mine.length === 0) continue;
    const result = reconcile(op, mine);
    decisions.push(...result.decisions);
    if (Object.keys(result.patch).length > 0) operations[op.id] = result.patch;
  }
  const proposal: AnvilManifest | undefined =
    Object.keys(operations).length > 0
      ? { operations, workflows: {}, capabilities: {}, query_templates: {} }
      : undefined;

  // An empty spool where the operator pointed at one is a misconfiguration,
  // not a quiet success: either the dir is wrong or nothing ever spooled, and
  // reporting ok for it would be automation told a question was answered when
  // it was never asked.
  const ok = records.length > 0;
  return {
    schemaVersion: 1,
    startedAt,
    finishedAt: new Date().toISOString(),
    service: air.service.id,
    source: dir,
    filesRead,
    recordsParsed: records.length,
    malformedLines,
    unknownOperationIds,
    traffic,
    unobserved,
    ...(proposal ? { proposal } : {}),
    decisions,
    ok,
    detail: ok
      ? `${records.length} record(s) across ${filesRead} spool file(s); ` +
        `${traffic.length} operation(s) observed, ${unobserved.length} approved but unobserved.`
      : `No records parsed from ${dir} (${filesRead} file(s), ${malformedLines} malformed ` +
        `line(s)). Point --from-records at the directory ANVIL_RECORDS_DIR wrote to.`,
  };
}

// Re-exported from the identity boundary's own module: the report is written
// into the bundle directory, so the name MUST be in DERIVED_RECORD_FILES or
// writing it would silently stale every evidence lane — the exact bug the
// benchmark report once had.
export { GENERATED_TRAFFIC_REPORT_FILE as TRAFFIC_REPORT_FILE } from "@anvil/generators";
