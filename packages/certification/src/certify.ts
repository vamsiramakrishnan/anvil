/**
 * The certification gate. `certify` runs static checks always, and — when
 * `executable` is requested — boots the simulator, exercises the live surface,
 * and runs the mutation battery. A pack is only `certified` when its surfaces were
 * started and exercised and every mutant was killed; static-only success is
 * `static_passed`, never `certified`.
 */
import { type AirDocument, contractHash, hashCanonical } from "@anvil/air";
import { capabilityContractsFor, surfaceSignatureFor } from "@anvil/compiler";
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
    for (const m of runMutationBattery(air)) {
      checks.push({
        id: `mutation/${m.name}`,
        phase: "mutation",
        ok: m.killed,
        detail: m.applicable ? m.classification : "inapplicable",
      });
    }
    status = checks.every((c) => c.ok) ? "certified" : "failed";
  }

  const attestation = attestationFor(air, options);
  const withoutDigest = { schemaVersion: 1 as const, status, attestation, checks };
  return { ...withoutDigest, digest: hashCanonical(withoutDigest) };
}

/**
 * Whether a prior certification still holds for a contract, or has expired because
 * a bound digest changed. Recompute the attestation and compare.
 */
export function isExpired(record: CertificationRecord, air: AirDocument): boolean {
  const current = attestationFor(air, {
    targetProfileVersion: record.attestation.targetProfileVersion,
  });
  return (
    record.attestation.contractDigest !== current.contractDigest ||
    record.attestation.surfaceSignatureDigest !== current.surfaceSignatureDigest
  );
}
