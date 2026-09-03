import type { AirDocument, Operation } from "@anvil/air";
import { addEvidence, type CaseRunRef, type Deficiency, openCase } from "@anvil/refinement";
import type { SpooledRecord } from "./records.js";

/**
 * The drift alarm: fold live observations already earned by production
 * traffic (`records.ts`'s `SpooledRecord`, the "recorded_traffic" evidence
 * `runRecords` already turns into claims) against what the compiled AIR
 * document claims about the same operation, and, when a live outcome
 * genuinely contradicts a compiled safety claim, open a refinement CASE
 * through the existing case rails — never patch AIR.
 *
 * This is deliberately NOT a new evidence-gathering subsystem. It reuses:
 *  - `records.ts`'s `SpooledRecord` as its evidence source (no new spool
 *    format, no new probe);
 *  - `@anvil/refinement`'s EXISTING `contested_safety_semantic` deficiency
 *    code and its EXISTING `classify-idempotency` skill (evidence bar:
 *    `minimumStrength: "authoritative"`, `minimumVerification: "verified"`
 *    — the highest bar in the codebase, and the one skill whose evidence
 *    policy already names `"recorded_traffic"` as an admissible source);
 *  - `@anvil/refinement`'s `openCase`/`addEvidence` case rails, unmodified.
 *
 * Every case this opens routes through `classify-idempotency`, which
 * `packages/refinement/src/approval.ts`'s `classifyApproval` NEVER
 * auto-approves (idempotency has no safe "tightening" direction the way
 * `retryable=false` does for errors — see that module's own doc). So even
 * if a later human/agent phase of the case produced a proposal, applying it
 * would still require a person's sign-off; this module goes nowhere near
 * that phase at all — it only opens the case and attaches evidence.
 */

/** One live-vs-compiled contradiction this alarm can name. */
export type DriftContradictionKind = "idempotency_replay_conflict" | "undeclared_error_code";

export interface DriftContradiction {
  operationId: string;
  kind: DriftContradictionKind;
  message: string;
  /** The subset of records that actually evidence the contradiction. */
  records: SpooledRecord[];
}

/**
 * Below this many recorded calls for an operation, a single contradicting
 * response is an anecdote (a transient upstream hiccup), not a pattern —
 * the same statistical floor `records.ts`'s `MIN_SAMPLES_FOR_CLAIM` applies
 * to a traffic-licensed claim, reused here for the same reason.
 */
export const MIN_SAMPLES_FOR_ALARM = 3;

/** Group records by operation id, in first-seen order. */
function groupByOperation(records: readonly SpooledRecord[]): Map<string, SpooledRecord[]> {
  const byOp = new Map<string, SpooledRecord[]>();
  for (const record of records) {
    const list = byOp.get(record.operationId);
    if (list) list.push(record);
    else byOp.set(record.operationId, [record]);
  }
  return byOp;
}

/**
 * "A naturally idempotent read returns 409 on replay": `op.idempotency.mode`
 * says repeat calls converge on the same effect, so an upstream `conflict`
 * (HTTP 409, Anvil's `conflict` error code) on ANY recorded call is a live
 * contradiction of that compiled claim.
 */
function idempotencyContradiction(
  op: Operation,
  opRecords: readonly SpooledRecord[],
): DriftContradiction | undefined {
  if (op.idempotency.mode !== "natural") return undefined;
  const conflicting = opRecords.filter((r) => r.errorCode === "conflict");
  if (conflicting.length === 0) return undefined;
  return {
    operationId: op.id,
    kind: "idempotency_replay_conflict",
    message:
      `'${op.id}' is compiled with idempotency.mode="natural" (repeat calls converge on the ` +
      `same effect), but ${conflicting.length} of ${opRecords.length} recorded call(s) returned ` +
      "a conflict on replay — live traffic contradicts the compiled claim.",
    records: conflicting,
  };
}

/**
 * "A declared error code never appears while an undeclared one does":
 * `op.errors` names the codes the operation is compiled to raise; when
 * traffic names enough of a DIFFERENT one instead — and never once produces
 * a declared one — the compiled error contract has drifted from what the
 * application actually does. Reported as a finding either way; see
 * `runDriftAlarm`'s doc for why this kind does not (yet) open a case.
 */
function undeclaredErrorCodeContradiction(
  op: Operation,
  opRecords: readonly SpooledRecord[],
): DriftContradiction | undefined {
  const declared = new Set<string>(op.errors.map((e) => e.code));
  if (declared.size === 0) return undefined;
  const observedDeclared = opRecords.some(
    (r) => r.errorCode !== undefined && declared.has(r.errorCode),
  );
  if (observedDeclared) return undefined;
  const undeclaredRecords = opRecords.filter(
    (r) => r.errorCode !== undefined && !declared.has(r.errorCode),
  );
  if (undeclaredRecords.length === 0) return undefined;
  const undeclaredCodes = [...new Set(undeclaredRecords.map((r) => r.errorCode))];
  return {
    operationId: op.id,
    kind: "undeclared_error_code",
    message:
      `'${op.id}' declares error code(s) [${[...declared].join(", ")}], but ${opRecords.length} ` +
      `recorded call(s) never produced any of them — instead returning undeclared code(s) ` +
      `[${undeclaredCodes.join(", ")}]. The compiled error contract contradicts live traffic.`,
    records: undeclaredRecords,
  };
}

/**
 * Pure fold: compiled AIR claims vs. recorded traffic, no case rails, no IO.
 * Every contradiction this returns is a structural finding worth reporting;
 * `runDriftAlarm` decides which kinds have an existing, evidence-compatible
 * skill to open a case through.
 */
export function detectDriftContradictions(
  air: AirDocument,
  records: readonly SpooledRecord[],
): DriftContradiction[] {
  const knownOps = new Map(air.operations.map((op) => [op.id, op]));
  const out: DriftContradiction[] = [];
  for (const [operationId, opRecords] of groupByOperation(records)) {
    const op = knownOps.get(operationId);
    if (!op || opRecords.length < MIN_SAMPLES_FOR_ALARM) continue;
    const idempotency = idempotencyContradiction(op, opRecords);
    if (idempotency) out.push(idempotency);
    const undeclaredError = undeclaredErrorCodeContradiction(op, opRecords);
    if (undeclaredError) out.push(undeclaredError);
  }
  return out;
}

export interface DriftAlarmOptions {
  /** Root the `cases/` dir is created under (default `.refinement`), forwarded to `openCase`. */
  root?: string;
  repositoryRoot?: string;
  repositoryRevision?: string;
  /** Recorded in the case run as who opened it (default `"drift-alarm"`). */
  executor?: string;
  /** Injectable clock (ms), forwarded to `openCase` for reproducible run ids in tests. */
  now?: number;
}

export interface OpenedDriftCase {
  contradiction: DriftContradiction;
  ref: CaseRunRef;
  dir: string;
}

export interface SkippedDriftContradiction {
  contradiction: DriftContradiction;
  reason: string;
}

export interface DriftAlarmResult {
  /** Every structural contradiction found — reported regardless of whether a case opened. */
  contradictions: DriftContradiction[];
  /** Cases actually opened (evidence attached), never an AIR mutation. */
  opened: OpenedDriftCase[];
  /** Contradictions that found no case-eligible, evidence-compatible skill. */
  skipped: SkippedDriftContradiction[];
}

/**
 * Fold live traffic against compiled claims and open a refinement case for
 * every contradiction an EXISTING skill can investigate — proposing only.
 *
 * Only `idempotency_replay_conflict` opens a case today: it routes through
 * `contested_safety_semantic`, whose registered skill (`classify-idempotency`)
 * already names `"recorded_traffic"` as an admissible, authoritative
 * evidence source (see this module's top doc). `undeclared_error_code` is
 * still reported in `contradictions` — an operator sees it in
 * `anvil observe --alarm`'s output — but is not (yet) routed to a case: its
 * closest existing skill (`enrich-errors`, triggered by `undocumented_error`)
 * does not accept `recorded_traffic` in its evidence policy, and this module
 * would rather report a gap honestly than force evidence through a skill
 * whose contract does not admit it. Closing that gap is a `enrich-errors`
 * evidence-policy change for a reviewer to make deliberately, not something
 * this alarm should paper over silently.
 *
 * NEVER calls anything that writes to AIR (`applyPatches`, `writeAir`,
 * `finalize`, …) — the only writes here are `openCase`/`addEvidence`, both
 * scoped to the case directory tree.
 */
export async function runDriftAlarm(
  air: AirDocument,
  records: readonly SpooledRecord[],
  options: DriftAlarmOptions = {},
): Promise<DriftAlarmResult> {
  const contradictions = detectDriftContradictions(air, records);
  const opened: OpenedDriftCase[] = [];
  const skipped: SkippedDriftContradiction[] = [];

  for (const contradiction of contradictions) {
    if (contradiction.kind !== "idempotency_replay_conflict") {
      skipped.push({
        contradiction,
        reason:
          "no existing skill's evidence policy admits recorded_traffic for this contradiction " +
          "kind yet; reported, but no case opened",
      });
      continue;
    }

    const deficiency: Deficiency = {
      code: "contested_safety_semantic",
      category: "safety",
      target: { kind: "operation", operationId: contradiction.operationId },
      severity: "high",
      message: contradiction.message,
      facts: {
        source: "drift-alarm",
        kind: contradiction.kind,
        recordCount: contradiction.records.length,
      },
      suggestedSkill: "classify-idempotency",
    };

    try {
      const materialized = openCase(air, deficiency, {
        root: options.root,
        repositoryRoot: options.repositoryRoot,
        repositoryRevision: options.repositoryRevision,
        executor: options.executor ?? "drift-alarm",
        now: options.now,
      });
      for (const record of contradiction.records) {
        await addEvidence(materialized.dir, {
          predicate: "operation.behavior",
          value: `errorCode=${record.errorCode ?? "unknown"} ledger=${record.ledger ?? "none"}`,
          source: "recorded_traffic",
          uri: `records:${contradiction.operationId}:${record.traceId}`,
          excerpt: JSON.stringify(record),
          note: contradiction.message,
          confidence: 0.9,
          now: options.now,
        });
      }
      opened.push({ contradiction, ref: materialized.ref, dir: materialized.dir });
    } catch (error) {
      skipped.push({
        contradiction,
        reason: error instanceof Error ? error.message : "could not open a case",
      });
    }
  }

  return { contradictions, opened, skipped };
}
