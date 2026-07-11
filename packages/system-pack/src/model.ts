/**
 * The Agent System Pack model — the portable, content-addressed result of Anvil.
 *
 * A pack is the deterministic artifact graph a downstream agent platform consumes:
 * a contract, the aligned MCP/CLI/skill/simulator projections, target-platform
 * kits, bindings, and (later) a certification record — every one content-addressed,
 * and every output recording the input digests it was built from. Identity is
 * derived from content only; timestamps and render-only metadata never feed a
 * digest, so the same canonical inputs always produce a byte-identical pack.
 *
 * Zod schemas so the pack doubles as runtime parsing, TypeScript types, and JSON
 * Schema. This package depends only on `@anvil/air`; it never imports the compiler
 * or generators — a pack is assembled from already-produced artifact bytes plus
 * their build provenance, not by running the build.
 */
import { z } from "zod";

/** The kind of a packed artifact — a projection surface or a record. */
export const PackArtifactKind = z.enum([
  "contract",
  "mcp",
  "cli",
  "skill",
  "simulator",
  "target",
  "certification",
  "doc",
  "other",
]);
export type PackArtifactKind = z.infer<typeof PackArtifactKind>;

/** A pack-relative posix path: never absolute, never escaping, never a backslash. */
export const PackPath = z.string().superRefine((path, ctx) => {
  const bad =
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    /(^|\/)\.\.(\/|$)/.test(path) ||
    /^[a-zA-Z]:/.test(path);
  if (bad) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `unsafe pack path: ${JSON.stringify(path)}`,
    });
  }
});

/** The immutable source a pack was compiled from. */
export const PackSourceRef = z.object({ snapshotId: z.string(), sourceHash: z.string() });
export type PackSourceRef = z.infer<typeof PackSourceRef>;

/** A reference to the effective contract (ADR-0012), by id + digest. */
export const ContractRef = z.object({ id: z.string(), digest: z.string() });
export type ContractRef = z.infer<typeof ContractRef>;

/** A reference to one capability contract (Increment 5), by id/version/digest. */
export const CapabilityContractRef = z.object({
  id: z.string(),
  version: z.string(),
  digest: z.string(),
});
export type CapabilityContractRef = z.infer<typeof CapabilityContractRef>;

/** A reference to the cross-surface signature (Increment 5). Optional until then. */
export const SurfaceSignatureRef = z.object({ digest: z.string() });
export type SurfaceSignatureRef = z.infer<typeof SurfaceSignatureRef>;

/** A reference to the certification record (Increment 8). Optional until then. */
export const CertificationRef = z.object({
  status: z.enum(["failed", "static_passed", "certified", "expired"]),
  digest: z.string(),
});
export type CertificationRef = z.infer<typeof CertificationRef>;

/** One packed artifact: an output file with a content digest. */
export const Artifact = z.object({
  id: z.string(),
  kind: PackArtifactKind,
  path: PackPath,
  /** sha256 hex over the verbatim artifact bytes. */
  contentDigest: z.string(),
});
export type Artifact = z.infer<typeof Artifact>;

/**
 * A node in the build graph: how one artifact (or set) was produced. The rebuild
 * planner keys entirely on this — an artifact rebuilds iff its `inputDigests`,
 * `implementationVersion`, or `configurationDigest` changed, so an unrelated
 * projection stays cached.
 */
export const BuildNode = z.object({
  id: z.string(),
  kind: z.string(),
  inputDigests: z.array(z.string()).default([]),
  implementationVersion: z.string(),
  configurationDigest: z.string(),
  outputDigests: z.array(z.string()).default([]),
});
export type BuildNode = z.infer<typeof BuildNode>;

/** The artifacts plus their build graph, with a content digest over both. */
export const ArtifactManifest = z.object({
  artifacts: z.array(Artifact).default([]),
  nodes: z.array(BuildNode).default([]),
  digest: z.string(),
});
export type ArtifactManifest = z.infer<typeof ArtifactManifest>;

/** One deployment binding (Increment 7 binds simulator/staging/production). */
export const Binding = z.object({ kind: z.string(), endpoint: z.string() });
export type Binding = z.infer<typeof Binding>;

/** Named bindings, e.g. { simulator, staging, production }. */
export const BindingManifest = z.record(z.string(), Binding);
export type BindingManifest = z.infer<typeof BindingManifest>;

/** A target-platform kit reference (Increment 9), by id/version + its artifacts. */
export const TargetManifest = z.object({
  id: z.string(),
  version: z.string(),
  artifactIds: z.array(z.string()).default([]),
});
export type TargetManifest = z.infer<typeof TargetManifest>;

/** The portable Agent System Pack. */
export const AgentSystemPack = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  version: z.string(),
  digest: z.string(),
  sourceRefs: z.array(PackSourceRef).default([]),
  contractRef: ContractRef,
  capabilities: z.array(CapabilityContractRef).default([]),
  surfaceSignature: SurfaceSignatureRef.optional(),
  artifacts: ArtifactManifest,
  bindings: BindingManifest.default({}),
  targets: z.array(TargetManifest).default([]),
  certification: CertificationRef.optional(),
});
export type AgentSystemPack = z.infer<typeof AgentSystemPack>;
