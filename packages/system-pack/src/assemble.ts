/**
 * Assemble an Agent System Pack from already-produced artifact bytes plus their
 * build provenance. This is the "real path" entry: a caller (the CLI build, in a
 * later increment) runs the compiler and generators, then hands their outputs
 * here. Assembly is pure and deterministic — content digests, the artifact
 * manifest digest, and the pack digest are all functions of the inputs, so the
 * same canonical inputs produce a byte-identical pack.
 */

import type { PackContents } from "./archive.js";
import { artifactManifestDigest, contentDigest, packDigest } from "./digest.js";
import type {
  AgentSystemPack,
  Artifact,
  ArtifactManifest,
  BindingManifest,
  BuildNode,
  CapabilityContractRef,
  CertificationRef,
  ContractRef,
  PackArtifactKind,
  PackSourceRef,
  SurfaceSignatureRef,
  TargetManifest,
} from "./model.js";
import { AgentSystemPack as AgentSystemPackSchema } from "./model.js";

/** One artifact to pack: its identity, its bytes, and how it was built. */
export interface ArtifactInput {
  id: string;
  kind: PackArtifactKind;
  path: string;
  bytes: Uint8Array;
  build: {
    inputDigests: string[];
    implementationVersion: string;
    configurationDigest: string;
    /** Extra graph inputs that are not themselves packed files (e.g. contract digest). */
    kind?: string;
  };
}

export interface SystemPackInput {
  version: string;
  id?: string;
  sourceRefs?: PackSourceRef[];
  contractRef: ContractRef;
  capabilities?: CapabilityContractRef[];
  surfaceSignature?: SurfaceSignatureRef;
  artifacts: ArtifactInput[];
  bindings?: BindingManifest;
  targets?: TargetManifest[];
  certification?: CertificationRef;
}

export interface AssembledPack {
  pack: AgentSystemPack;
  contents: PackContents;
}

/** Build the artifact manifest (artifacts + build graph) from inputs. */
function buildArtifactManifest(inputs: readonly ArtifactInput[]): {
  manifest: ArtifactManifest;
  contents: Map<string, Uint8Array>;
} {
  const contents = new Map<string, Uint8Array>();
  const artifacts: Artifact[] = [];
  const nodes: BuildNode[] = [];
  const seenPaths = new Set<string>();

  for (const input of inputs) {
    if (seenPaths.has(input.path)) {
      throw new Error(`duplicate pack path: ${input.path}`);
    }
    seenPaths.add(input.path);
    const digest = contentDigest(input.bytes);
    contents.set(input.path, input.bytes);
    artifacts.push({ id: input.id, kind: input.kind, path: input.path, contentDigest: digest });
    nodes.push({
      id: input.id,
      kind: input.build.kind ?? input.kind,
      inputDigests: input.build.inputDigests,
      implementationVersion: input.build.implementationVersion,
      configurationDigest: input.build.configurationDigest,
      outputDigests: [digest],
    });
  }

  const digest = artifactManifestDigest({ artifacts, nodes });
  return { manifest: { artifacts, nodes, digest }, contents };
}

/** Assemble and validate a pack; throws only on malformed structure (bad path, dup). */
export function assembleSystemPack(input: SystemPackInput): AssembledPack {
  const { manifest, contents } = buildArtifactManifest(input.artifacts);

  const withoutIdentity: Omit<AgentSystemPack, "id" | "digest"> = {
    schemaVersion: 1,
    version: input.version,
    sourceRefs: input.sourceRefs ?? [],
    contractRef: input.contractRef,
    capabilities: input.capabilities ?? [],
    surfaceSignature: input.surfaceSignature,
    artifacts: manifest,
    bindings: input.bindings ?? {},
    targets: input.targets ?? [],
    certification: input.certification,
  };
  const digest = packDigest(withoutIdentity);
  const pack = AgentSystemPackSchema.parse({
    ...withoutIdentity,
    id: input.id ?? `pack_${digest.slice(0, 12)}`,
    digest,
  });
  return { pack, contents };
}
