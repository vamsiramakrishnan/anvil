/**
 * Content-derived identity for overlays and contract snapshots. Reuses
 * `@anvil/air`'s canonical (key-sorted) hasher so there is exactly one
 * canonicalizer in the system, and `contractHash` for the AIR portion so a
 * re-lint (which only changes diagnostics) can never change a contract digest.
 *
 * Digests are order-independent: assertions and applied overlays are sorted into
 * a canonical order first, so overlay array order and assertion authoring order
 * never affect identity.
 */
import { type AirDocument, contractHash, hashCanonical } from "@anvil/air";
import type { SourceEntrypoint } from "../source/model.js";
import type { AppliedOverlay, PolicyOverlay, SemanticOverlayAssertion } from "./model.js";

/**
 * The compiler implementation version that participates in a contract digest.
 * Bumped when the compiler's semantics change so a cached pack keyed on the digest
 * is invalidated by a compiler upgrade, not just an input change.
 */
export const CONTRACT_COMPILER_VERSION = "0.1.0";

/** A stable canonical key for one assertion (used for sorting and dedupe). */
export function assertionKey(a: SemanticOverlayAssertion): string {
  return JSON.stringify([a.target.scope, a.target.ref, a.predicate, a.operation, a.value ?? null]);
}

/** Assertions in canonical order — identity is independent of authoring order. */
export function sortAssertions(
  assertions: readonly SemanticOverlayAssertion[],
): SemanticOverlayAssertion[] {
  return [...assertions].sort((a, b) => assertionKey(a).localeCompare(assertionKey(b)));
}

/**
 * The content digest of an overlay: `(origin, assertions, evidence)`. Excludes
 * `id` and `digest` so two overlays with identical content share a digest.
 */
export function overlayDigest(
  overlay: Pick<PolicyOverlay, "origin" | "assertions" | "evidence">,
): string {
  // Duplicate equivalent assertions collapse: identity is the canonical *set*,
  // so authoring order and repetition never change the digest.
  const canonical = sortAssertions(overlay.assertions).map((a) => ({
    target: a.target,
    predicate: a.predicate,
    operation: a.operation,
    value: a.value ?? null,
    evidenceRefs: [...a.evidenceRefs].sort(),
  }));
  const deduped = [...new Map(canonical.map((a) => [JSON.stringify(a), a])).values()];
  return hashCanonical({
    origin: overlay.origin,
    assertions: deduped,
    evidence: [...overlay.evidence].sort((x, y) => x.id.localeCompare(y.id)),
  });
}

export interface ContractDigestInput {
  source: { snapshotId: string; sourceHash: string; entrypoints: readonly SourceEntrypoint[] };
  air: AirDocument;
  appliedOverlays: readonly AppliedOverlay[];
}

/**
 * The content digest of a contract snapshot. Covers the source identity, the
 * effective AIR contract (via `contractHash`, which excludes diagnostics), the
 * applied overlay digests (sorted), and the compiler version. Excludes timestamps
 * and render-only metadata: same source + same overlays → identical digest.
 */
export function contractDigest(input: ContractDigestInput): string {
  return hashCanonical({
    compilerVersion: CONTRACT_COMPILER_VERSION,
    source: {
      snapshotId: input.source.snapshotId,
      sourceHash: input.source.sourceHash,
      entrypoints: [...input.source.entrypoints].sort((a, b) => a.path.localeCompare(b.path)),
    },
    air: contractHash(input.air),
    overlays: [...input.appliedOverlays].map((o) => o.digest).sort(),
  });
}
