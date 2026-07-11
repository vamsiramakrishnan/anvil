/**
 * Pack verification: recompute every digest from content and confirm the pack is
 * internally consistent and untampered. Failures are data (a findings list),
 * never throws — a verify is a gate that reports, so `anvil pack verify` can
 * explain exactly what diverged.
 */

import type { PackContents } from "./archive.js";
import { artifactManifestDigest, contentDigest, packDigest } from "./digest.js";
import type { AgentSystemPack } from "./model.js";
import { PackPath } from "./model.js";

export interface VerifyFinding {
  code:
    | "unsafe_path"
    | "missing_content"
    | "content_digest_mismatch"
    | "manifest_digest_mismatch"
    | "pack_digest_mismatch"
    | "dangling_output";
  artifactId?: string;
  path?: string;
  message: string;
}

export interface VerifyResult {
  ok: boolean;
  findings: VerifyFinding[];
}

/**
 * Verify a pack against the bytes it claims. Checks path safety, that every
 * artifact's content hashes to its recorded digest, and that the manifest and
 * pack digests recompute — so an altered artifact, a swapped file, or a tampered
 * manifest all fail closed.
 */
export function verifyPack(pack: AgentSystemPack, contents: PackContents): VerifyResult {
  const findings: VerifyFinding[] = [];
  const artifactDigests = new Set<string>();

  for (const artifact of pack.artifacts.artifacts) {
    if (!PackPath.safeParse(artifact.path).success) {
      findings.push({
        code: "unsafe_path",
        artifactId: artifact.id,
        path: artifact.path,
        message: `Unsafe pack path ${JSON.stringify(artifact.path)}.`,
      });
    }
    const bytes = contents.get(artifact.path);
    if (bytes === undefined) {
      findings.push({
        code: "missing_content",
        artifactId: artifact.id,
        path: artifact.path,
        message: `No bytes supplied for ${artifact.path}.`,
      });
      continue;
    }
    const actual = contentDigest(bytes);
    artifactDigests.add(actual);
    if (actual !== artifact.contentDigest) {
      findings.push({
        code: "content_digest_mismatch",
        artifactId: artifact.id,
        path: artifact.path,
        message: `Content hash ${actual.slice(0, 12)}… ≠ recorded ${artifact.contentDigest.slice(0, 12)}….`,
      });
    }
  }

  // Every node output must correspond to a real artifact digest.
  for (const node of pack.artifacts.nodes) {
    for (const out of node.outputDigests) {
      if (!pack.artifacts.artifacts.some((a) => a.contentDigest === out)) {
        findings.push({
          code: "dangling_output",
          artifactId: node.id,
          message: `Build node ${node.id} claims output ${out.slice(0, 12)}… with no matching artifact.`,
        });
      }
    }
  }

  const manifestDigest = artifactManifestDigest(pack.artifacts);
  if (manifestDigest !== pack.artifacts.digest) {
    findings.push({
      code: "manifest_digest_mismatch",
      message: `Recomputed manifest digest ≠ recorded ${pack.artifacts.digest.slice(0, 12)}….`,
    });
  }

  const { id: _id, digest: _digest, ...rest } = pack;
  if (packDigest(rest) !== pack.digest) {
    findings.push({
      code: "pack_digest_mismatch",
      message: `Recomputed pack digest ≠ recorded ${pack.digest.slice(0, 12)}….`,
    });
  }

  return { ok: findings.length === 0, findings };
}
