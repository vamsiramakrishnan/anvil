/**
 * The compile-time posture for a `service.source.kind === "har"` document —
 * this is the module `compile.ts` calls to keep a traffic capture from ever
 * being treated as a declared contract, no matter what the generic
 * normalize/validate pipeline (protocol-agnostic by design) concluded.
 *
 * A HAR capture proves what a client actually sent and what came back; it
 * proves NOTHING about intent — whether a mutation is idempotent, what a
 * missing status code means, whether the shape observed is the whole shape.
 * Two things enforce that, applied to every operation compiled from a `har`
 * source:
 *
 *   1. `state` is capped at `review_required`. The generic pipeline may
 *      already have produced `review_required` or `blocked` for its own
 *      reasons (an unresolved auth scheme, a composite requirement); this
 *      only ever pulls `generated`/`approved` DOWN to `review_required` — a
 *      tightening, never a loosening (`safety-invariants.md`'s asymmetric
 *      rule) — and never touches an already-`blocked` operation.
 *   2. Every safety-relevant claim already on the operation (effect kind,
 *      idempotency mode, long-running, confirmation, retries, auth
 *      principal — never `exists`/`name.quality`, which carry no safety
 *      weight) has its `source` rewritten to `recorded_traffic` — AIR's own
 *      vocabulary for "sanitized recorded traffic" (`schema.ts`'s
 *      `EvidenceKind`; reliability 0.95, the highest source-reliability in
 *      the table) — and its `confidence` capped at 0.5: real reliability in
 *      what was captured, but low confidence that ONE capture proves a
 *      general safety semantic. `confidenceFor`/`resolveSemantic` compose
 *      confidence × reliability, so a capped, high-reliability claim still
 *      lands well under the review threshold rather than masquerading as
 *      near-certain.
 *
 * A `reviewNotes` entry is added naming exactly how many captured requests
 * backed the operation (from the adapter's own `x-anvil-observed` extension,
 * matched back to the operation's `sourceRef.path`/`method` against the
 * pre-normalize document — the one place that count still exists once
 * normalize has thrown the raw extension away).
 */
import type { Operation } from "@anvil/air";
import type { OpenApiDocument } from "./parse.js";

/** Safety-relevant claim predicates; `exists`/`name.quality` carry no safety weight. */
const SAFETY_CLAIM_PREDICATES: ReadonlySet<string> = new Set([
  "effect.kind",
  "effect.stateImpact",
  "idempotency.mode",
  "longRunning",
  "confirmation.required",
  "retries.mode",
  "auth.principal",
]);

/** The compiler's own ceiling on a claim's confidence once a HAR posture applies. */
const HAR_MAX_CLAIM_CONFIDENCE = 0.5;

interface HarObserved {
  samples?: number;
  firstSeen?: string;
  lastSeen?: string;
}

function observedFor(doc: OpenApiDocument, op: Operation): HarObserved | undefined {
  const path = op.sourceRef.path;
  const method = op.sourceRef.method;
  if (!path || !method) return undefined;
  const pathItem = doc.paths?.[path] as Record<string, unknown> | undefined;
  const raw = pathItem?.[method] as Record<string, unknown> | undefined;
  const observed = raw?.["x-anvil-observed"];
  return observed && typeof observed === "object" ? (observed as HarObserved) : undefined;
}

/**
 * Apply the HAR review posture in place. Mutates `operations`; called from
 * `compile.ts` only when `service.source.kind === "har"`.
 */
export function applyHarObservedPosture(operations: Operation[], doc: OpenApiDocument): void {
  for (const op of operations) {
    // 1. State ceiling — tightening only, never touches `blocked`.
    if (op.state === "generated" || op.state === "approved") {
      op.state = "review_required";
    }

    // 2. Safety claims: reattribute to recorded-traffic evidence, capped.
    for (const claim of op.evidence.claims) {
      if (!SAFETY_CLAIM_PREDICATES.has(claim.predicate)) continue;
      claim.source = "recorded_traffic";
      claim.confidence = Math.min(claim.confidence, HAR_MAX_CLAIM_CONFIDENCE);
    }

    // 3. Review note citing exactly how many captured requests backed this.
    const observed = observedFor(doc, op);
    const samples = observed?.samples;
    const note =
      samples !== undefined
        ? `Derived from ${samples} captured HTTP request${samples === 1 ? "" : "s"} in a HAR ` +
          `capture${observed?.firstSeen ? ` (first seen ${observed.firstSeen}` : ""}` +
          `${observed?.lastSeen ? `, last seen ${observed.lastSeen})` : observed?.firstSeen ? ")" : ""}` +
          "; every claim here is an observation, not a specification — review before approving."
        : "Derived from a HAR capture; every claim here is an observation, not a specification — " +
          "review before approving.";
    if (!op.reviewNotes.includes(note)) op.reviewNotes.push(note);
  }
}
