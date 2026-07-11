/**
 * Canonical models for the contract layer — the join between an immutable
 * `SourceSnapshot` and the effective, callable semantics an agent surface is
 * generated from:
 *
 *   SourceSnapshot → (compile) → AIR
 *                 + PolicyOverlay[] → (resolve) → EffectiveContract
 *
 * A `PolicyOverlay` is the one refinement channel: gateway policy, operator
 * configuration, investigation findings, observed traffic, and the supplemental
 * Anvil manifest all become overlays. The mutation language is *semantic* — an
 * assertion names an AIR predicate coordinate and an operation (set / restrict /
 * remove / assert), never a raw JSON Patch — so restrictions can be combined and
 * safety-sensitive contradictions can be detected rather than last-write-wins.
 *
 * These are Zod schemas so they double as runtime parsing, TypeScript types, and
 * JSON Schema. Digests are content-derived (see `digest.ts`) and never include
 * timestamps or render-only metadata.
 */
import { AirDocument, Diagnostic, type EvidenceKind } from "@anvil/air";
import { z } from "zod";
import type { SourceEntrypoint } from "../source/model.js";

/** Where an overlay's refinements came from. Ranked for authority in resolution. */
export const OverlayOrigin = z.enum([
  "manifest",
  "gateway",
  "investigation",
  "operator",
  "observed_traffic",
]);
export type OverlayOrigin = z.infer<typeof OverlayOrigin>;

/** What an assertion targets: one operation, the service, or a capability. */
export const SemanticScope = z.enum(["service", "operation", "capability"]);
export type SemanticScope = z.infer<typeof SemanticScope>;

/**
 * A semantic coordinate. For `operation` scope, `ref` is an operation selector
 * (AIR id / canonical name / source operationId) resolved with the same rule the
 * manifest uses. For `service`/`capability` scope, `ref` names the service or
 * capability id.
 */
export const SemanticTarget = z.object({
  scope: SemanticScope,
  ref: z.string(),
});
export type SemanticTarget = z.infer<typeof SemanticTarget>;

/**
 * The AIR predicate an assertion refines. This is the shared vocabulary between
 * overlays, the resolver, and the projection back onto an operation — it maps
 * one-to-one onto the fields the classifier and manifest already own, so no new
 * semantics are invented here.
 */
export const SemanticPredicate = z.enum([
  // effect
  "effect.kind",
  "effect.risk",
  "effect.reversible",
  "effect.action",
  // identity / description
  "displayName",
  "description",
  "state",
  // auth
  "auth.principal",
  "auth.audience",
  "auth.secretSource",
  "auth.tenant",
  "auth.actor",
  "auth.subject",
  "auth.scopes",
  // idempotency
  "idempotency.mode",
  "idempotency.mechanism",
  "idempotency.key",
  // confirmation
  "confirmation.required",
  "confirmation.risk",
  "confirmation.reason",
  // retries
  "retries.mode",
  "retries.maxAttempts",
  "retries.retryOn",
]);
export type SemanticPredicate = z.infer<typeof SemanticPredicate>;

/**
 * How an assertion changes the effective value:
 *   set      — authoritative replacement (operator/gateway/manifest intent).
 *   restrict — tighten only; combines commutatively (scope union, safety toward
 *              the safer pole). Never loosens.
 *   remove   — subtract from a set-valued predicate (e.g. drop a scope).
 *   assert   — an evidence-backed claim of a value; participates in conflict
 *              detection and wins only when nothing more authoritative disagrees.
 */
export const OverlayOperationKind = z.enum(["set", "restrict", "remove", "assert"]);
export type OverlayOperationKind = z.infer<typeof OverlayOperationKind>;

/** Any JSON value an assertion may carry. */
export const JsonValue: z.ZodType<unknown> = z.unknown();

/**
 * A piece of evidence an overlay carries, referenced by assertions via id. Kept
 * deliberately light — the AIR evidence graph remains the rich store; this binds
 * an overlay's assertions to where they came from so a conflict can cite them.
 */
export const EvidenceArtifact = z.object({
  id: z.string(),
  kind: z.custom<EvidenceKind>(),
  ref: z.string().optional(),
  note: z.string().optional(),
  /** Source reliability 0..1; falls back to the per-kind default when unset. */
  reliability: z.number().min(0).max(1).optional(),
});
export type EvidenceArtifact = z.infer<typeof EvidenceArtifact>;

/** One semantic refinement. */
export const SemanticOverlayAssertion = z.object({
  target: SemanticTarget,
  predicate: SemanticPredicate,
  operation: OverlayOperationKind,
  value: JsonValue,
  evidenceRefs: z.array(z.string()).default([]),
});
export type SemanticOverlayAssertion = z.infer<typeof SemanticOverlayAssertion>;

/**
 * A policy overlay: an ordered, content-addressed set of semantic assertions
 * from one origin. `digest` is derived from `(origin, assertions, evidence)` —
 * not `id` — so two overlays with identical content share a digest.
 */
export const PolicyOverlay = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  origin: OverlayOrigin,
  assertions: z.array(SemanticOverlayAssertion).default([]),
  evidence: z.array(EvidenceArtifact).default([]),
  digest: z.string(),
});
export type PolicyOverlay = z.infer<typeof PolicyOverlay>;

/** One overlay as recorded on a resolved contract (identity, not full content). */
export const AppliedOverlay = z.object({
  id: z.string(),
  digest: z.string(),
  origin: OverlayOrigin,
});
export type AppliedOverlay = z.infer<typeof AppliedOverlay>;

/**
 * The normalized, overlay-resolved contract. Wraps the effective `AirDocument`
 * and records which overlays produced it plus a content digest that covers the
 * source, the effective AIR, the applied overlay digests, and the compiler
 * version — everything and nothing more that determines the callable semantics.
 */
export const ContractSnapshot = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  digest: z.string(),
  source: z.object({
    snapshotId: z.string(),
    sourceHash: z.string(),
    entrypoints: z.array(z.custom<SourceEntrypoint>()),
  }),
  air: AirDocument,
  appliedOverlays: z.array(AppliedOverlay).default([]),
  diagnostics: z.array(Diagnostic).default([]),
});
export type ContractSnapshot = z.infer<typeof ContractSnapshot>;

/** One value in contention for a predicate, with who asserted it and how strongly. */
export interface ConflictSide {
  value: unknown;
  origins: OverlayOrigin[];
  operation: OverlayOperationKind;
  authority: number;
  evidenceReliability: number;
  evidenceRefs: string[];
}

/**
 * A contested semantic that resolution refused to silently decide. Safety-sensitive
 * contradictions (auth, confirmation, idempotency, retry, effect kind) surface here
 * rather than picking a winner, and drive the overall result to `conflicted`.
 */
export interface SemanticConflict {
  target: SemanticTarget;
  predicate: SemanticPredicate;
  safetySensitive: boolean;
  sides: ConflictSide[];
  /** What a reviewer may do to resolve it. */
  allowedResolutions: ("set" | "restrict" | "remove" | "block" | "escalate")[];
  message: string;
}

/**
 * The outcome of `compileContract`. `resolved` when no safety-sensitive semantic
 * is contested; `conflicted` when one or more are — the partial contract still
 * carries the safer value for each contested predicate so a caller can inspect it,
 * but it must not be certified until the conflicts are resolved.
 */
export type EffectiveContractResult =
  | { status: "resolved"; contract: ContractSnapshot }
  | { status: "conflicted"; partialContract: ContractSnapshot; conflicts: SemanticConflict[] };
