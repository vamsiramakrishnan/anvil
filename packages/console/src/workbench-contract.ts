import { Operation } from "@anvil/air";
import type { CertificationCheck, ExecutableEvidenceStatus } from "@anvil/generators";
import { z } from "zod";

/** On-demand operation detail; the schema and flags use AIR's shared projection. */
export const zOperationView = z.object({
  operation: Operation,
  inputSchema: z.record(z.string(), z.unknown()),
  cliFlags: z.record(z.string(), z.string()),
  confirmationKey: z.string(),
  served: z.boolean(),
});

const zStaticCheck = z.object({
  id: z.string(),
  gate: z.enum(["contract", "semantic", "safety", "runtime"]),
  status: z.enum(["passed", "failed", "skipped"]),
  detail: z.string(),
}) satisfies z.ZodType<CertificationCheck>;

const zEvidenceStatus = z.object({
  lane: z.enum(["selftest", "conformance", "simulation"]),
  file: z.enum(["selftest.report.json", "conformance.report.json", "simulation.report.json"]),
  state: z.enum(["fresh", "missing", "corrupt", "failed", "stale"]),
  fresh: z.boolean(),
  passed: z.boolean().nullable(),
  bundleHash: z.string().nullable(),
  detail: z.string(),
}) satisfies z.ZodType<ExecutableEvidenceStatus>;

/** Current static checks and recorded evidence are deliberately separate. */
export const zAssuranceView = z.object({
  path: z.string(),
  bundleHash: z.string(),
  status: z.enum(["passed", "failed"]),
  checks: z.array(zStaticCheck),
  certification: z.object({ valid: z.boolean(), detail: z.string() }),
  evidence: z.array(zEvidenceStatus),
});

export const zArtifactQuery = z.object({ path: z.string().min(1).max(1024) });
export const zArtifactsView = z.object({
  files: z.array(z.object({ path: z.string(), bytes: z.number().int().nonnegative() })),
});
export const zArtifactView = z.object({
  path: z.string(),
  content: z.string(),
  bytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
