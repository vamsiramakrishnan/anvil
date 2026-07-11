/**
 * Content-derived identity for packs and artifacts. Reuses `@anvil/air`'s
 * canonical (key-sorted) hasher for JSON structures — one canonicalizer in the
 * system — and `node:crypto` for verbatim byte content. Digests are
 * order-independent (artifacts/nodes are sorted first) and exclude the digest
 * fields themselves, so identity is a pure function of content.
 */
import { createHash } from "node:crypto";
import { hashCanonical } from "@anvil/air";
import type { AgentSystemPack, Artifact, ArtifactManifest, BuildNode } from "./model.js";

/**
 * The pack builder implementation version that participates in a pack digest, so
 * a pack cached on its digest is invalidated by a builder upgrade, not only by an
 * input change.
 */
export const PACK_BUILDER_VERSION = "0.1.0";

/** sha256 hex over verbatim artifact bytes. */
export function contentDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const byId = <T extends { id: string }>(items: readonly T[]): T[] =>
  [...items].sort((a, b) => a.id.localeCompare(b.id));

/** Canonical shape of one artifact for hashing. */
function artifactShape(a: Artifact) {
  return { id: a.id, kind: a.kind, path: a.path, contentDigest: a.contentDigest };
}

/** Canonical shape of one build node for hashing (input/output digests sorted). */
function nodeShape(n: BuildNode) {
  return {
    id: n.id,
    kind: n.kind,
    inputDigests: [...n.inputDigests].sort(),
    implementationVersion: n.implementationVersion,
    configurationDigest: n.configurationDigest,
    outputDigests: [...n.outputDigests].sort(),
  };
}

/** The content digest of an artifact manifest (order-independent). */
export function artifactManifestDigest(
  manifest: Pick<ArtifactManifest, "artifacts" | "nodes">,
): string {
  return hashCanonical({
    artifacts: byId(manifest.artifacts).map(artifactShape),
    nodes: byId(manifest.nodes).map(nodeShape),
  });
}

/**
 * Everything about a pack that determines identity, minus derived id/digest.
 * `certification` is intentionally excluded: it is a downstream attestation that
 * references the pack digest, so folding it in would make the record circularly
 * invalidate the pack. Attaching or removing certification never changes identity.
 */
function packShape(pack: Omit<AgentSystemPack, "id" | "digest">) {
  return {
    builderVersion: PACK_BUILDER_VERSION,
    schemaVersion: pack.schemaVersion,
    version: pack.version,
    sourceRefs: [...pack.sourceRefs].sort((a, b) => a.snapshotId.localeCompare(b.snapshotId)),
    contractRef: pack.contractRef,
    capabilities: byId(pack.capabilities),
    surfaceSignature: pack.surfaceSignature ?? null,
    artifacts: pack.artifacts.digest,
    bindings: pack.bindings,
    targets: byId(pack.targets),
  };
}

/** The content digest of a pack: covers every input, excludes timestamps. */
export function packDigest(pack: Omit<AgentSystemPack, "id" | "digest">): string {
  return hashCanonical(packShape(pack));
}
