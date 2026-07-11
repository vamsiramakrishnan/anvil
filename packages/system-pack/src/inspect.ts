/**
 * A human-facing summary of a pack — the data behind `anvil pack inspect`. Pure:
 * it reads a pack and returns counts, digests, and the artifact/binding/target
 * listing, sorted for stable rendering.
 */
import type { AgentSystemPack, PackArtifactKind } from "./model.js";

export interface PackSummary {
  id: string;
  version: string;
  digest: string;
  contract: { id: string; digest: string };
  sourceRefs: number;
  capabilities: string[];
  artifactCount: number;
  artifactsByKind: Record<string, number>;
  bindings: string[];
  targets: string[];
  certification?: string;
}

export function inspectPack(pack: AgentSystemPack): PackSummary {
  const byKind: Record<string, number> = {};
  for (const a of pack.artifacts.artifacts) {
    byKind[a.kind] = (byKind[a.kind] ?? 0) + 1;
  }
  return {
    id: pack.id,
    version: pack.version,
    digest: pack.digest,
    contract: { id: pack.contractRef.id, digest: pack.contractRef.digest },
    sourceRefs: pack.sourceRefs.length,
    capabilities: pack.capabilities.map((c) => `${c.id}@${c.version}`).sort(),
    artifactCount: pack.artifacts.artifacts.length,
    artifactsByKind: sortKinds(byKind),
    bindings: Object.keys(pack.bindings).sort(),
    targets: pack.targets.map((t) => `${t.id}@${t.version}`).sort(),
    certification: pack.certification?.status,
  };
}

function sortKinds(byKind: Record<string, number>): Record<PackArtifactKind | string, number> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(byKind).sort()) out[key] = byKind[key] as number;
  return out;
}
