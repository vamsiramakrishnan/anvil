/**
 * `compileContract` — the canonical join the whole pipeline narrows toward:
 *
 *   CompilerSource + PolicyOverlay[] → EffectiveContractResult
 *
 * It compiles the immutable source to AIR, applies the overlays at the compiler's
 * refinement slot (so validation and capability discovery see the effective
 * operations), and wraps the result in a content-addressed `ContractSnapshot`.
 * When a safety-sensitive semantic is contested, the result is `conflicted`, the
 * affected operations are blocked, and the snapshot itself records
 * `status: "conflicted"` + the conflicts so the fact survives serialization.
 */
import { type CompileSourceOptions, compileSourceEffective } from "../compile.js";
import type { CompilerSource } from "../source/compiler-source.js";
import { contractDigest } from "./digest.js";
import type { ContractSnapshot, EffectiveContractResult, PolicyOverlay } from "./model.js";

export interface ContractCompileOptions extends CompileSourceOptions {}

/** Assemble a `ContractSnapshot` from an effective compile result. */
function toContractSnapshot(
  source: CompilerSource,
  result: Awaited<ReturnType<typeof compileSourceEffective>>,
): ContractSnapshot {
  const src = {
    snapshotId: source.snapshotId,
    sourceHash: source.sourceHash,
    entrypoints: [source.entrypoint],
  };
  const digest = contractDigest({
    source: src,
    air: result.air,
    appliedOverlays: result.appliedOverlays,
  });
  const conflicted = result.conflicts.length > 0;
  return {
    schemaVersion: 1,
    id: `contract_${digest.slice(0, 12)}`,
    digest,
    status: conflicted ? "conflicted" : "resolved",
    source: src,
    air: result.air,
    appliedOverlays: result.appliedOverlays,
    conflicts: result.conflicts,
    blockedOperationIds: result.blockedOperationIds,
    diagnostics: result.air.diagnostics,
  };
}

/**
 * Compile a source plus overlays into one evidence-backed effective contract.
 * Deterministic: same source + same overlays → byte-identical `ContractSnapshot`
 * (its digest excludes timestamps and is independent of overlay array order).
 */
export async function compileContract(
  source: CompilerSource,
  overlays: readonly PolicyOverlay[] = [],
  options: ContractCompileOptions = {},
): Promise<EffectiveContractResult> {
  const compileOptions: CompileSourceOptions & { overlays: readonly PolicyOverlay[] } = {
    ...options,
    overlays,
  };
  const result = await compileSourceEffective(source, compileOptions);
  const contract = toContractSnapshot(source, result);
  if (contract.status === "conflicted") {
    return { status: "conflicted", partialContract: contract, conflicts: result.conflicts };
  }
  return { status: "resolved", contract };
}
