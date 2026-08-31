import { createHash } from "node:crypto";
import type { AirDocument, Claim } from "@anvil/air";
import { readRecordSpool, type SpooledRecord } from "./records.js";

/**
 * The observed-capability lane: derive candidate capability groupings from what
 * operations were actually used *together*, instead of from what a vendor's
 * documentation says they are about.
 *
 * Why this exists. `discoverCapabilities` groups by OpenAPI tag, and a tag is a
 * REFERENCE taxonomy: it organises a vendor's API by resource ("Attachments",
 * "Brands", "Custom Object Fields"). A support agent's real jobs — triage an
 * inbound ticket, pull a customer's history — cut across those tags. Grouping by
 * tag therefore does not narrow the served catalog along the axis routing
 * accuracy depends on; it moves the same routing problem up a level.
 *
 * What replaces the guess. `ExecutionRecord` already carries a `traceId`, and
 * the serving path already spools every record it emits (`ANVIL_RECORDS_DIR`,
 * `JsonlRecordSpool`). Operations that appear inside the SAME trace were used to
 * do one thing. That is a task, observed rather than guessed: `recorded_traffic`
 * evidence, the highest-reliability source `SOURCE_RELIABILITY` recognises, and
 * it invents no business rule because nothing is invented — it is a counted fact
 * about usage.
 *
 * What this lane deliberately is not. It never asks a model to look at an
 * operation list and imagine plausible groupings; that produces unfalsifiable
 * business taxonomy, which is what `do_not_invent_business_rules` forbids and is
 * indistinguishable from a good answer until it fails in production. It never
 * writes AIR, never approves, and never builds. Traffic may propose a grouping;
 * a human decides whether it is the right unit of work — the same boundary
 * `anvil capability compose`, `anvil refine run`, and `anvil enrich` stop at.
 */

/* -------------------------------------------------------------------------- */
/* The thresholds                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The ubiquity pre-filter, mirroring `ENVELOPE_SOURCE_FRACTION` /
 * `ENVELOPE_MIN_SOURCES` in `packages/cli/src/capability-composition.ts`.
 *
 * The FLEXCUBE run is the evidenced reason this is a pre-filter and not a
 * smarter evidence bar afterwards: a purely structural signal
 * (`/fcubsWarningResp`, a shared REST response envelope present in all 29
 * sources) produced a single 139-member candidate — 64% of every candidate
 * member in the whole report — pure transport noise drowning three real
 * candidates. The behavioural equivalent is an operation that appears in nearly
 * every trace: an auth call, a health check, a token refresh. It co-occurs with
 * everything, so it would join every grouping and drown the signal in exactly
 * the same way. It is removed statistically, before any grouping is formed.
 *
 * The denominator is distinct trace SHAPES, not trace instances — the same
 * choice the envelope filter makes when it counts sources rather than
 * occurrences. Two failures follow from getting that wrong: one very hot task
 * repeated ten thousand times would make its own members look ubiquitous, and a
 * spool that only ever saw one task would suppress every operation in it and
 * propose nothing at all. Counting shapes is immune to both — a single-shape
 * spool cannot reach `UBIQUITY_MIN_SHAPES`, so where there is nothing to
 * discriminate between, the filter correctly declines to fire.
 */
export const UBIQUITY_SHAPE_FRACTION = 0.8;
export const UBIQUITY_MIN_SHAPES = 3;

/**
 * Below this many traces a repeated shape is an anecdote, not evidence — the
 * same judgement, and deliberately the same number, as `MIN_SAMPLES_FOR_CLAIM`
 * in `records.ts`. Two agents happening to touch the same three operations in
 * one session is a coincidence; the identical operation set arriving whole in
 * five separate traces is a routine somebody runs. Five is also the point at
 * which a shape survives one outlier: at four, a single stray session is a
 * quarter of the evidence.
 */
export const MIN_TRACES_FOR_GROUPING = 5;

/** A grouping of one operation is not a grouping; it is an operation. */
const MIN_GROUPING_MEMBERS = 2;

/** Report cap: the pair table is a review aid, not a data export. */
const MAX_COOCCURRENCE_PAIRS = 200;

/* -------------------------------------------------------------------------- */
/* Shapes                                                                     */
/* -------------------------------------------------------------------------- */

/** One observed trace: its operations, deduped, in first-called order. */
export interface ObservedTrace {
  traceId: string;
  /** Operation ids in the order each was first called within this trace. */
  sequence: string[];
  firstAt?: string;
  lastAt?: string;
}

/** How often two operations were used together, and in which order. */
export interface CooccurrencePair {
  /** The lexicographically first of the two operation ids. */
  a: string;
  b: string;
  /** Traces containing both. */
  traces: number;
  /** Traces where `a` was first called before `b`, and the converse. */
  aBeforeB: number;
  bBeforeA: number;
}

/** An operation the pre-filter removed before any grouping was formed. */
export interface SuppressedUbiquitousOperation {
  operationId: string;
  /** Distinct trace shapes containing it, and that as a fraction of all shapes. */
  shapes: number;
  shapeFraction: number;
  /** Trace instances containing it — context for a reviewer, not the threshold. */
  traces: number;
  reason: "ubiquitous_across_trace_shapes";
}

/** A recurring task shape: this exact operation set, whole, in N traces. */
export interface ObservedGrouping {
  /** Deterministic, content-derived id. Not an AIR capability id: this is not in AIR. */
  id: string;
  /** Members, sorted. Never contains a pre-filtered operation. */
  operationIds: string[];
  /** Traces whose post-filter operation set was exactly this. */
  traces: number;
  /** The most frequent call order across those traces, and how many used it. */
  dominantOrder: string[];
  dominantOrderTraces: number;
  /** Distinct orders observed for the same set — many means order is not fixed. */
  distinctOrders: number;
  /** AIR resource nouns the members span (read off AIR; not an invented name). */
  resources: string[];
  /**
   * The existing AIR capabilities the members are scattered across. More than
   * one is the point: it is the tag taxonomy and the observed task disagreeing,
   * measured rather than argued.
   */
  spansCapabilities: string[];
  crossesExistingCapabilities: boolean;
  firstAt?: string;
  lastAt?: string;
  evidence: Claim[];
  /**
   * A ready-to-review manifest snippet: paste it into the estate's anvil.yaml
   * `capabilities:` section to AUTHOR this grouping as a capability
   * (`source: "manifest"`, born `lifecycle: "proposed"`), then recompile and
   * review it through the ordinary gates. Emitting text the operator must copy,
   * read, and compile — instead of writing the manifest file — IS the
   * propose-only boundary: the reviewed bytes are the ones a human placed.
   */
  manifestSnippet: string;
}

export interface TraceCapabilityReport {
  schemaVersion: 1;
  reportType: "anvil.observed-capability-proposal";
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
  summary: {
    traces: number;
    traceShapes: number;
    operationsObserved: number;
    suppressedOperations: number;
    groupings: number;
    minTracesForGrouping: number;
  };
  suppressedUbiquitousOperations: SuppressedUbiquitousOperation[];
  cooccurrence: CooccurrencePair[];
  groupings: ObservedGrouping[];
  /**
   * Baked in, the way `capability compose` bakes it into every report. A
   * traffic-observed grouping is a question for a reviewer, never an answer.
   */
  boundary: {
    mode: "observed_traffic_read_only_proposal";
    autoApproved: false;
    writesAir: false;
    buildReady: false;
    reason: string;
    nextGate: string;
  };
  ok: boolean;
  detail: string;
}

/* -------------------------------------------------------------------------- */
/* Aggregation                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Fold records into traces. The spool is read in write order, which for a
 * serving process is call order, so the first appearance of an operation id
 * within a trace is where it sits in the sequence. A repeat call inside the same
 * trace does not move it: co-occurrence is set membership, and order is reported
 * as first use so a retry cannot rewrite the story.
 */
export function groupTraces(records: readonly SpooledRecord[]): ObservedTrace[] {
  const byTrace = new Map<string, ObservedTrace & { seen: Set<string> }>();
  for (const record of records) {
    let trace = byTrace.get(record.traceId);
    if (!trace) {
      trace = { traceId: record.traceId, sequence: [], seen: new Set() };
      byTrace.set(record.traceId, trace);
    }
    if (!trace.seen.has(record.operationId)) {
      trace.seen.add(record.operationId);
      trace.sequence.push(record.operationId);
    }
    if (record.at) {
      if (!trace.firstAt || record.at < trace.firstAt) trace.firstAt = record.at;
      if (!trace.lastAt || record.at > trace.lastAt) trace.lastAt = record.at;
    }
  }
  return [...byTrace.values()].map(({ seen: _seen, ...trace }) => trace);
}

/** The canonical key for a set of operations: sorted, newline-joined. */
const shapeKey = (operationIds: readonly string[]): string => [...operationIds].sort().join("\n");

/**
 * The pre-filter. An operation present in at least `UBIQUITY_MIN_SHAPES`
 * distinct trace shapes AND in at least `UBIQUITY_SHAPE_FRACTION` of them
 * carries no information about which task is underway — it is the behavioural
 * transport envelope. It is removed here, before any candidate is generated, and
 * named in the report so the removal is reviewable rather than invisible.
 */
export function detectUbiquitousOperations(
  traces: readonly ObservedTrace[],
): SuppressedUbiquitousOperation[] {
  const totalShapes = new Set(traces.map((trace) => shapeKey(trace.sequence))).size;
  if (totalShapes === 0) return [];

  const shapesWith = new Map<string, Set<string>>();
  const tracesWith = new Map<string, number>();
  for (const trace of traces) {
    const key = shapeKey(trace.sequence);
    for (const operationId of trace.sequence) {
      const seen = shapesWith.get(operationId) ?? new Set<string>();
      seen.add(key);
      shapesWith.set(operationId, seen);
      tracesWith.set(operationId, (tracesWith.get(operationId) ?? 0) + 1);
    }
  }

  const suppressed: SuppressedUbiquitousOperation[] = [];
  for (const [operationId, keys] of shapesWith) {
    const shapes = keys.size;
    const shapeFraction = shapes / totalShapes;
    if (shapes >= UBIQUITY_MIN_SHAPES && shapeFraction >= UBIQUITY_SHAPE_FRACTION) {
      suppressed.push({
        operationId,
        shapes,
        shapeFraction,
        traces: tracesWith.get(operationId) ?? 0,
        reason: "ubiquitous_across_trace_shapes",
      });
    }
  }
  return suppressed.sort((x, y) => x.operationId.localeCompare(y.operationId));
}

/** Unordered pair co-occurrence with first-use ordering counts, over traces. */
export function cooccurrencePairs(traces: readonly ObservedTrace[]): CooccurrencePair[] {
  const pairs = new Map<string, CooccurrencePair>();
  for (const trace of traces) {
    for (let i = 0; i < trace.sequence.length; i++) {
      for (let j = i + 1; j < trace.sequence.length; j++) {
        const earlier = trace.sequence[i] as string;
        const later = trace.sequence[j] as string;
        const forward = earlier < later;
        const a = forward ? earlier : later;
        const b = forward ? later : earlier;
        const key = `${a}\n${b}`;
        const pair = pairs.get(key) ?? { a, b, traces: 0, aBeforeB: 0, bBeforeA: 0 };
        pair.traces++;
        if (forward) pair.aBeforeB++;
        else pair.bBeforeA++;
        pairs.set(key, pair);
      }
    }
  }
  return [...pairs.values()].sort(
    (x, y) => y.traces - x.traces || x.a.localeCompare(y.a) || x.b.localeCompare(y.b),
  );
}

/* -------------------------------------------------------------------------- */
/* Grouping                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A grouping's id is derived from its members, so the same observed task keeps
 * the same id across runs and two reports can be diffed. The `observed.` prefix
 * says what an AIR capability id would not: this grouping is not in AIR.
 */
function groupingId(operationIds: readonly string[]): string {
  return `observed.${createHash("sha256").update(shapeKey(operationIds)).digest("hex").slice(0, 12)}`;
}

/**
 * The claims a grouping carries.
 *
 * `confidence` is 1 because both claims are counts, and the count is exact: the
 * lane read every record in the spool and added up. It is emphatically NOT a
 * confidence that this is the right unit of work — no number here could defend
 * that, which is why the note states the count and the review boundary states
 * the rest. Weight comes from `SOURCE_RELIABILITY.recorded_traffic` (0.95)
 * discounting it, exactly as `effectiveWeight` does for every other claim.
 */
function groupingEvidence(input: {
  id: string;
  operationIds: readonly string[];
  traces: number;
  totalTraces: number;
  dominantOrder: readonly string[];
  dominantOrderTraces: number;
  distinctOrders: number;
  firstAt?: string;
  lastAt?: string;
  sourceRef: string;
}): Claim[] {
  const window =
    input.firstAt && input.lastAt ? ` between ${input.firstAt} and ${input.lastAt}` : "";
  return [
    {
      subject: input.id,
      predicate: "cooccurrence",
      value: [...input.operationIds],
      source: "recorded_traffic",
      sourceRef: input.sourceRef,
      method: "observed",
      confidence: 1,
      note:
        `Observed as the complete operation set of ${input.traces} of ${input.totalTraces} ` +
        `recorded trace(s)${window}, after ubiquitous operations were filtered out. ` +
        "This is a counted fact about usage, not a judgement that it is the right " +
        "unit of work — that decision is a human's.",
    },
    {
      subject: input.id,
      predicate: "sequence",
      value: [...input.dominantOrder],
      source: "recorded_traffic",
      sourceRef: input.sourceRef,
      method: "observed",
      confidence: 1,
      note:
        `${input.dominantOrderTraces} of ${input.traces} trace(s) called these operations in ` +
        `this order; ${input.distinctOrders} distinct order(s) were observed in total.`,
    },
  ];
}

/**
 * The bridge from an observed grouping to the manifest authoring path
 * (`capabilities:` entries with an `operations` list — see
 * `CapabilityReviewManifest` in `@anvil/compiler`). Every scalar is
 * JSON-quoted, which is valid YAML, so an id or description can never break
 * the snippet's structure. The suggested capability id is deterministic
 * (service + the grouping's content-derived suffix) and the operator is
 * expected to rename it to the task's real name — the placeholder display
 * name says so out loud.
 */
function groupingManifestSnippet(input: {
  serviceId: string;
  groupingId: string;
  operationIds: readonly string[];
  traces: number;
  totalTraces: number;
  firstAt?: string;
  lastAt?: string;
}): string {
  const suffix = input.groupingId.replace(/^observed\./, "observed_");
  const window =
    input.firstAt && input.lastAt ? ` between ${input.firstAt} and ${input.lastAt}` : "";
  const description =
    `Observed as the complete operation set of ${input.traces} of ${input.totalTraces} recorded ` +
    `trace(s)${window}. Rename this capability after the task it accomplishes and review the ` +
    `members before approving.`;
  return [
    "capabilities:",
    `  ${input.serviceId}.${suffix}:`,
    `    display_name: ${JSON.stringify(`Observed task ${suffix}`)}`,
    `    description: ${JSON.stringify(description)}`,
    "    operations:",
    ...input.operationIds.map((id) => `      - ${JSON.stringify(id)}`),
  ].join("\n");
}

/**
 * Group traces by their exact post-filter operation set.
 *
 * Exact-set matching is chosen over any similarity clustering on purpose. A
 * merge rule (absorb a subset, join near-neighbours) is a decision about what
 * counts as the same task, and that decision is precisely the one this lane
 * refuses to make on a human's behalf. An exact set supports one sentence a
 * reviewer can check against the spool — "these operations, all of them, were
 * the whole of N traces" — and a subset shape simply appears as its own,
 * separately counted candidate.
 */
export function deriveGroupings(input: {
  traces: readonly ObservedTrace[];
  suppressed: ReadonlySet<string>;
  air: AirDocument;
  sourceRef: string;
}): ObservedGrouping[] {
  const byOperation = new Map(input.air.operations.map((op) => [op.id, op]));
  const bySet = new Map<
    string,
    {
      operationIds: string[];
      orders: Map<string, number>;
      traces: number;
      firstAt?: string;
      lastAt?: string;
    }
  >();

  for (const trace of input.traces) {
    const kept = trace.sequence.filter((id) => !input.suppressed.has(id));
    if (kept.length < MIN_GROUPING_MEMBERS) continue;
    const key = shapeKey(kept);
    const group = bySet.get(key) ?? {
      operationIds: [...kept].sort(),
      orders: new Map<string, number>(),
      traces: 0,
    };
    group.traces++;
    const orderKey = kept.join("\n");
    group.orders.set(orderKey, (group.orders.get(orderKey) ?? 0) + 1);
    if (trace.firstAt && (!group.firstAt || trace.firstAt < group.firstAt))
      group.firstAt = trace.firstAt;
    if (trace.lastAt && (!group.lastAt || trace.lastAt > group.lastAt)) group.lastAt = trace.lastAt;
    bySet.set(key, group);
  }

  const groupings: ObservedGrouping[] = [];
  for (const group of bySet.values()) {
    if (group.traces < MIN_TRACES_FOR_GROUPING) continue;
    const [dominant, dominantTraces] = [...group.orders.entries()].sort(
      (x, y) => y[1] - x[1] || x[0].localeCompare(y[0]),
    )[0] as [string, number];
    const members = group.operationIds.map((id) => byOperation.get(id));
    const id = groupingId(group.operationIds);
    const spansCapabilities = [
      ...new Set(members.map((op) => op?.capabilityId).filter((c): c is string => Boolean(c))),
    ].sort();
    groupings.push({
      id,
      operationIds: group.operationIds,
      traces: group.traces,
      dominantOrder: dominant.split("\n"),
      dominantOrderTraces: dominantTraces,
      distinctOrders: group.orders.size,
      resources: [
        ...new Set(members.map((op) => op?.effect.resource).filter((r): r is string => Boolean(r))),
      ].sort(),
      spansCapabilities,
      crossesExistingCapabilities: spansCapabilities.length > 1,
      ...(group.firstAt ? { firstAt: group.firstAt } : {}),
      ...(group.lastAt ? { lastAt: group.lastAt } : {}),
      manifestSnippet: groupingManifestSnippet({
        serviceId: input.air.service.id,
        groupingId: id,
        operationIds: group.operationIds,
        traces: group.traces,
        totalTraces: input.traces.length,
        ...(group.firstAt ? { firstAt: group.firstAt } : {}),
        ...(group.lastAt ? { lastAt: group.lastAt } : {}),
      }),
      evidence: groupingEvidence({
        id,
        operationIds: group.operationIds,
        traces: group.traces,
        totalTraces: input.traces.length,
        dominantOrder: dominant.split("\n"),
        dominantOrderTraces: dominantTraces,
        distinctOrders: group.orders.size,
        ...(group.firstAt ? { firstAt: group.firstAt } : {}),
        ...(group.lastAt ? { lastAt: group.lastAt } : {}),
        sourceRef: input.sourceRef,
      }),
    });
  }
  return groupings.sort((x, y) => y.traces - x.traces || x.id.localeCompare(y.id));
}

/* -------------------------------------------------------------------------- */
/* The lane                                                                   */
/* -------------------------------------------------------------------------- */

export interface TraceCapabilityOptions {
  air: AirDocument;
  /** The spool directory `ANVIL_RECORDS_DIR` pointed at. */
  dir: string;
}

/** Run the observed-capability lane: spool in, review-bound proposal out. */
export function runTraceCapabilities({ air, dir }: TraceCapabilityOptions): TraceCapabilityReport {
  const startedAt = new Date().toISOString();
  const { records, filesRead, malformedLines } = readRecordSpool(dir);

  // Traffic naming an operation this AIR does not carry is dropped before any
  // shape is computed, not after: a grouping whose member AIR has never heard of
  // could not be reviewed against anything, and a phantom id would also shift
  // every shape fraction the pre-filter depends on.
  const known = new Set(air.operations.map((op) => op.id));
  const unknownOperationIds = [
    ...new Set(records.map((r) => r.operationId).filter((id) => !known.has(id))),
  ].sort();
  const traces = groupTraces(records.filter((record) => known.has(record.operationId))).filter(
    (trace) => trace.sequence.length > 0,
  );

  const suppressedUbiquitousOperations = detectUbiquitousOperations(traces);
  const suppressed = new Set(suppressedUbiquitousOperations.map((s) => s.operationId));
  const filtered = traces.map((trace) => ({
    ...trace,
    sequence: trace.sequence.filter((id) => !suppressed.has(id)),
  }));

  const groupings = deriveGroupings({
    traces,
    suppressed,
    air,
    sourceRef: `records:${dir}`,
  });
  const operationsObserved = new Set(traces.flatMap((trace) => trace.sequence)).size;

  // An empty spool where the operator pointed at one is a misconfiguration, not
  // a quiet success — the same judgement `runRecords` makes, for the same
  // reason: reporting ok would be automation told a question was answered when
  // it was never asked.
  const ok = records.length > 0;
  return {
    schemaVersion: 1,
    reportType: "anvil.observed-capability-proposal",
    startedAt,
    finishedAt: new Date().toISOString(),
    service: air.service.id,
    source: dir,
    filesRead,
    recordsParsed: records.length,
    malformedLines,
    unknownOperationIds,
    summary: {
      traces: traces.length,
      traceShapes: new Set(traces.map((trace) => shapeKey(trace.sequence))).size,
      operationsObserved,
      suppressedOperations: suppressedUbiquitousOperations.length,
      groupings: groupings.length,
      minTracesForGrouping: MIN_TRACES_FOR_GROUPING,
    },
    suppressedUbiquitousOperations,
    cooccurrence: cooccurrencePairs(filtered).slice(0, MAX_COOCCURRENCE_PAIRS),
    groupings,
    boundary: {
      mode: "observed_traffic_read_only_proposal",
      autoApproved: false,
      writesAir: false,
      buildReady: false,
      reason:
        "Co-occurrence proves operations were used together. It does not prove they are one " +
        "unit of work, which is a business judgement Anvil does not make from usage alone.",
      nextGate:
        "Review each grouping against the estate. To adopt one, copy its manifestSnippet into " +
        "the estate's anvil.yaml `capabilities:` section (authoring — the capability compiles " +
        'in with source "manifest", born proposed), recompile, then review it through the ' +
        "existing grouping-review gates (`anvil capability show`, `approve`), never from this " +
        "report.",
    },
    ok,
    detail: ok
      ? `${records.length} record(s) across ${filesRead} spool file(s); ${traces.length} trace(s), ` +
        `${suppressedUbiquitousOperations.length} ubiquitous operation(s) filtered before review, ` +
        `${groupings.length} grouping(s) at or above ${MIN_TRACES_FOR_GROUPING} trace(s).`
      : `No records parsed from ${dir} (${filesRead} file(s), ${malformedLines} malformed ` +
        `line(s)). Point --from-records at the directory ANVIL_RECORDS_DIR wrote to.`,
  };
}
