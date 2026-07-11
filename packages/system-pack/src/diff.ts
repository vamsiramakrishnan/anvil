/**
 * Semantic diff between two packs — the data behind `anvil pack diff`. It reports
 * what actually changed (which artifacts, the contract, capabilities, bindings,
 * targets), keyed by id and compared by digest, so a review sees "the skill and
 * one target changed" rather than a line-level file diff.
 */
import type { AgentSystemPack, PackArtifactKind } from "./model.js";

export interface ArtifactChange {
  id: string;
  kind: PackArtifactKind;
  change: "added" | "removed" | "changed";
}

export interface PackDiff {
  identical: boolean;
  contractChanged: boolean;
  capabilitiesChanged: boolean;
  bindingsChanged: boolean;
  targetsChanged: boolean;
  artifacts: ArtifactChange[];
}

/** Diff two packs. `a` is the baseline, `b` the candidate. */
export function diffPacks(a: AgentSystemPack, b: AgentSystemPack): PackDiff {
  const aArtifacts = new Map(a.artifacts.artifacts.map((x) => [x.id, x]));
  const bArtifacts = new Map(b.artifacts.artifacts.map((x) => [x.id, x]));
  const artifacts: ArtifactChange[] = [];

  for (const [id, art] of bArtifacts) {
    const prior = aArtifacts.get(id);
    if (!prior) artifacts.push({ id, kind: art.kind, change: "added" });
    else if (prior.contentDigest !== art.contentDigest) {
      artifacts.push({ id, kind: art.kind, change: "changed" });
    }
  }
  for (const [id, art] of aArtifacts) {
    if (!bArtifacts.has(id)) artifacts.push({ id, kind: art.kind, change: "removed" });
  }
  artifacts.sort((x, y) => x.id.localeCompare(y.id));

  const contractChanged = a.contractRef.digest !== b.contractRef.digest;
  const capabilitiesChanged = JSON.stringify(capabilityKey(a)) !== JSON.stringify(capabilityKey(b));
  const bindingsChanged = JSON.stringify(a.bindings) !== JSON.stringify(b.bindings);
  const targetsChanged = JSON.stringify(targetKey(a)) !== JSON.stringify(targetKey(b));

  return {
    identical: a.digest === b.digest,
    contractChanged,
    capabilitiesChanged,
    bindingsChanged,
    targetsChanged,
    artifacts,
  };
}

const capabilityKey = (p: AgentSystemPack) =>
  [...p.capabilities].map((c) => [c.id, c.version, c.digest]).sort();

const targetKey = (p: AgentSystemPack) =>
  [...p.targets].map((t) => [t.id, t.version, [...t.artifactIds].sort()]).sort();
