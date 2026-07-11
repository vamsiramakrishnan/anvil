/**
 * Certification models. A certification is a graded judgement about a pack, not a
 * file-presence check:
 *
 *   failed         — a static or executable check failed.
 *   static_passed  — schemas, digests, and surfaces are internally coherent.
 *   certified      — the generated surfaces were *booted and exercised* and held.
 *   expired        — a prior certification whose bound inputs have changed.
 *
 * A `CertificationRecord` binds to the exact digests it certified, so it cannot be
 * silently reused for a different pack/contract/surface.
 */
import { z } from "zod";

export const CertificationStatus = z.enum(["failed", "static_passed", "certified", "expired"]);
export type CertificationStatus = z.infer<typeof CertificationStatus>;

/** One check's outcome — data, never a throw. */
export const CertificationCheck = z.object({
  id: z.string(),
  phase: z.enum(["static", "executable", "mutation"]),
  ok: z.boolean(),
  detail: z.string().optional(),
});
export type CertificationCheck = z.infer<typeof CertificationCheck>;

/** What a certification is bound to — changing any of these expires it. */
export const CertificationAttestation = z.object({
  packDigest: z.string(),
  contractDigest: z.string(),
  capabilityDigests: z.array(z.string()).default([]),
  surfaceSignatureDigest: z.string(),
  targetProfileVersion: z.string().optional(),
  certificationVersion: z.string(),
});
export type CertificationAttestation = z.infer<typeof CertificationAttestation>;

export const CertificationRecord = z.object({
  schemaVersion: z.literal(1),
  status: CertificationStatus,
  attestation: CertificationAttestation,
  checks: z.array(CertificationCheck).default([]),
  /** The record's own content digest (excludes nothing volatile — it is pure data). */
  digest: z.string(),
});
export type CertificationRecord = z.infer<typeof CertificationRecord>;

/** The certification implementation version, bound into every attestation. */
export const CERTIFICATION_VERSION = "0.1.0";
