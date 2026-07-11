/**
 * Capability contracts, disclosure plans, and surface signatures — the
 * agent-facing layer over the effective contract.
 *
 *   EffectiveContract ─▶ CapabilityContract ─▶ DisclosurePlan
 *                                          └─▶ SurfaceSignature
 *
 * A `CapabilityContract` is the reviewable business boundary an agent reasons
 * about ("Refunds"), editable without touching AIR. A `DisclosurePlan` is the
 * single owner of progressive disclosure that the CLI, MCP resources, and skill
 * all project from. A `SurfaceSignature` is the cross-surface compatibility
 * fingerprint shared by MCP, CLI, skill, simulator, and target packaging — so
 * "does the simulator match production?" is one digest comparison.
 *
 * Zod schemas: runtime parsing + types + JSON Schema. Digests reuse
 * `@anvil/air`'s canonical hasher.
 */
import { Evidence } from "@anvil/air";
import { z } from "zod";

/** The aggregate authentication posture of a capability's operations. */
export const AuthProfile = z.object({
  types: z.array(z.string()).default([]),
  principals: z.array(z.string()).default([]),
  scopes: z.array(z.string()).default([]),
  secretSources: z.array(z.string()).default([]),
});
export type AuthProfile = z.infer<typeof AuthProfile>;

/** The aggregate safety posture of a capability's operations. */
export const SafetyProfile = z.object({
  /** Member ops that require human confirmation. */
  confirmationRequiredOps: z.array(z.string()).default([]),
  /** Member mutations that are not idempotent (never auto-retried). */
  nonIdempotentMutationOps: z.array(z.string()).default([]),
  /** The highest blast-radius risk across members. */
  highestRisk: z
    .enum(["none", "low", "medium", "high", "financial", "destructive"])
    .default("none"),
});
export type SafetyProfile = z.infer<typeof SafetyProfile>;

/** Who owns a capability (for review routing). */
export const OwnerRef = z.object({
  id: z.string(),
  kind: z.enum(["team", "person"]).default("team"),
});
export type OwnerRef = z.infer<typeof OwnerRef>;

/** What a disclosure node is about — the progressive-disclosure taxonomy. */
export const DisclosureKind = z.enum([
  "overview",
  "operation",
  "schema",
  "examples",
  "errors",
  "policy",
  "procedure",
]);
export type DisclosureKind = z.infer<typeof DisclosureKind>;

/** One unit of progressive disclosure: a titled summary plus a content pointer. */
export const DisclosureNode = z.object({
  id: z.string(),
  kind: DisclosureKind,
  title: z.string(),
  summary: z.string(),
  /** Pointer to the full content (a resource URI / file path), resolved per surface. */
  contentRef: z.string(),
});
export type DisclosureNode = z.infer<typeof DisclosureNode>;

/**
 * The single owner of progressive disclosure. The CLI (`--help`/`--schema`/…),
 * MCP (concise tools + detailed resources), and skill (concise SKILL.md +
 * reference files) all derive from these nodes — no per-surface duplication.
 */
export const DisclosurePlan = z.object({
  summary: z.array(DisclosureNode).default([]),
  operations: z.record(z.string(), z.array(DisclosureNode)).default({}),
});
export type DisclosurePlan = z.infer<typeof DisclosurePlan>;

/** The compatibility fingerprint of one operation's public surface. */
export const SurfaceOperationSignature = z.object({
  id: z.string(),
  publicName: z.string(),
  inputSchemaDigest: z.string(),
  outputSchemaDigest: z.string(),
  errorSchemaDigest: z.string(),
  /** Effect + idempotency + retries + confirmation — the safety posture. */
  effectDigest: z.string(),
  authDigest: z.string(),
});
export type SurfaceOperationSignature = z.infer<typeof SurfaceOperationSignature>;

/** The cross-surface compatibility contract for a capability. */
export const SurfaceSignature = z.object({
  schemaVersion: z.literal(1),
  capabilityId: z.string(),
  version: z.string(),
  operations: z.array(SurfaceOperationSignature).default([]),
  digest: z.string(),
});
export type SurfaceSignature = z.infer<typeof SurfaceSignature>;

/** The agent-facing business boundary — reviewable and declaratively editable. */
export const CapabilityContract = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  version: z.string(),
  displayName: z.string(),
  description: z.string().default(""),
  intents: z.array(z.string()).default([]),
  counterIntents: z.array(z.string()).default([]),
  operationIds: z.array(z.string()).default([]),
  procedureRefs: z.array(z.string()).default([]),
  authProfile: AuthProfile,
  safetyProfile: SafetyProfile,
  disclosure: DisclosurePlan,
  lifecycle: z.enum(["proposed", "approved", "deprecated"]).default("proposed"),
  owner: OwnerRef.optional(),
  evidence: Evidence.default({ claims: [] }),
  digest: z.string(),
});
export type CapabilityContract = z.infer<typeof CapabilityContract>;

/** How a surface change is classified, worst-first. */
export const CompatibilityClass = z.enum([
  "safety-sensitive",
  "breaking",
  "additive",
  "compatible",
]);
export type CompatibilityClass = z.infer<typeof CompatibilityClass>;

/** One classified difference between two surface signatures. */
export interface SurfaceChange {
  operationId: string;
  change: "added" | "removed" | "changed";
  fields: string[];
  classification: CompatibilityClass;
}

/** The result of comparing two surface signatures. */
export interface CompatibilityReport {
  classification: CompatibilityClass;
  changes: SurfaceChange[];
}
