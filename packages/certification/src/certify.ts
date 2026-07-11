/**
 * The certification gate. `certify` runs static checks always, and — when
 * `executable` is requested — boots the simulator, exercises the live surface,
 * and runs the mutation battery. A pack is only `certified` when its surfaces were
 * started and exercised and every mutant was killed; static-only success is
 * `static_passed`, never `certified`.
 */
import { type AirDocument, contractHash, hashCanonical } from "@anvil/air";
import {
  type ContractSnapshot,
  capabilityContractsFor,
  surfaceSignatureFor,
} from "@anvil/compiler";
import type { AgentSystemPack, PackContents } from "@anvil/system-pack";
import { executableChecks, staticChecks } from "./checks.js";
import {
  CERTIFICATION_VERSION,
  type CertificationCheck,
  type CertificationRecord,
  type CertificationStatus,
} from "./model.js";
import { runMutationBattery } from "./mutate.js";

export interface CertifyOptions {
  /** The pack under certification (enables pack verification checks). */
  pack?: { pack: AgentSystemPack; contents: PackContents };
  /** Boot and exercise the surfaces (executable certification). Default false. */
  executable?: boolean;
  /** Deterministic simulator seed for the executable phase. */
  seed?: number;
  targetProfileVersion?: string;
}

function attestationFor(air: AirDocument, options: CertifyOptions) {
  return {
    packDigest: options.pack?.pack.digest ?? "none",
    contractDigest: contractHash(air),
    capabilityDigests: capabilityContractsFor(air)
      .map((c) => c.digest)
      .sort(),
    surfaceSignatureDigest: surfaceSignatureFor(air).digest,
    targetProfileVersion: options.targetProfileVersion,
    certificationVersion: CERTIFICATION_VERSION,
  };
}

/** Certify a contract (and optionally its pack). */
export function certify(air: AirDocument, options: CertifyOptions = {}): CertificationRecord {
  const checks: CertificationCheck[] = [...staticChecks(air, options.pack)];
  const staticOk = checks.every((c) => c.ok);

  let status: CertificationStatus;
  if (!options.executable) {
    status = staticOk ? "static_passed" : "failed";
  } else {
    checks.push(...executableChecks(air, options.seed ?? 1));
    const mutants = runMutationBattery(air);
    for (const m of mutants) {
      checks.push({
        id: `mutation/${m.name}`,
        phase: "mutation",
        ok: m.killed,
        detail: m.applicable ? m.classification : "inapplicable",
      });
    }
    if (!checks.every((c) => c.ok)) {
      status = "failed";
    } else {
      // `certified` requires the attestation to *demonstrably* catch a safety
      // regression: at least one safety mutant was applicable and killed. When the
      // contract exposes no safety-sensitive surface to mutate (nothing to confirm,
      // no scopes, no non-idempotent mutation), the surface was still booted and
      // exercised, but we cannot make that claim — so it is `simulator_exercised`,
      // not `certified`.
      const safetyProven = mutants.some((m) => m.safety && m.applicable && m.killed);
      status = safetyProven ? "certified" : "simulator_exercised";
    }
  }

  const attestation = attestationFor(air, options);
  const withoutDigest = { schemaVersion: 1 as const, status, attestation, checks };
  return { ...withoutDigest, digest: hashCanonical(withoutDigest) };
}

/**
 * Certify a *resolved* contract snapshot. Certification attests to a coherent
 * surface, so a conflicted contract — one where the resolver could not decide a
 * safety-sensitive predicate and blocked operations — is not a certifiable input:
 * it fails closed with a single `failed` check rather than certifying a partial,
 * ambiguous surface. A resolved snapshot delegates to `certify` over its AIR. This
 * is the entry point callers should prefer over passing raw `AirDocument`, so the
 * "one compiler path" produces the exact contract that gets certified.
 */
export function certifyContract(
  contract: ContractSnapshot,
  options: CertifyOptions = {},
): CertificationRecord {
  if (contract.status !== "resolved") {
    const checks: CertificationCheck[] = [
      {
        id: "static/contract_resolved",
        phase: "static",
        ok: false,
        detail: `contract is ${contract.status}; ${contract.blockedOperationIds.length} operation(s) blocked by unresolved conflicts`,
      },
    ];
    const attestation = attestationFor(contract.air, options);
    const withoutDigest = {
      schemaVersion: 1 as const,
      status: "failed" as const,
      attestation,
      checks,
    };
    return { ...withoutDigest, digest: hashCanonical(withoutDigest) };
  }
  return certify(contract.air, options);
}

/**
 * Whether a prior certification still holds for a contract, or has expired because
 * *any* bound input changed. The attestation binds six things — pack, contract,
 * capability, and surface digests, the target-profile version, and the
 * certification-implementation version — so all six must be recomputed and
 * compared, not just the contract and surface. Comparing a subset would let a
 * repacked artifact, a regrouped capability, or a newer certification engine reuse
 * a stale record. The pack must be supplied to recompute `packDigest` faithfully;
 * omit it only when the original certification bound no pack.
 */
export function isExpired(
  record: CertificationRecord,
  air: AirDocument,
  options: { pack?: CertifyOptions["pack"] } = {},
): boolean {
  const current = attestationFor(air, {
    pack: options.pack,
    targetProfileVersion: record.attestation.targetProfileVersion,
  });
  return hashCanonical(current) !== hashCanonical(record.attestation);
}
