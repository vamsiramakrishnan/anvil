import { Diagnostic, JsonSchema, Operation } from "@anvil/air";
import type { CertificationCheck, ExecutableEvidenceStatus } from "@anvil/generators";
import type { DryRunPlan } from "@anvil/runtime";
import { z } from "zod";

/** Browser-safe schemas; the libraries remain the owners of policy and evidence. */
const zBundleHash = z.string().regex(/^[a-f0-9]{64}$/);
export const zOperationDetail = z.object({
  bundleHash: zBundleHash,
  operation: Operation,
  inputSchema: JsonSchema,
  diagnostics: z.array(Diagnostic),
});

export const zPreviewRequest = z
  .object({
    bundleHash: zBundleHash,
    input: z.record(z.string(), z.unknown()),
    confirm: z.boolean().optional(),
    idempotencyKey: z.string().max(1024).optional(),
  })
  .strict();

const zPlan = z.object({
  operation: z.string(),
  method: z.string(),
  url: z.string(),
  headers: z.record(z.string(), z.string()),
  body: z.unknown().optional(),
  idempotencyKeyPresent: z.boolean(),
  retryPlan: z.object({ enabled: z.boolean(), maxAttempts: z.number() }),
  confirmationRequired: z.boolean(),
}) satisfies z.ZodType<DryRunPlan>;

export const zPreview = z.object({
  bundleHash: zBundleHash,
  outcome: z.literal("dry_run"),
  plan: zPlan,
});

const zCheck = z.object({
  id: z.string(),
  gate: z.enum(["contract", "semantic", "safety", "runtime"]),
  status: z.enum(["passed", "failed", "skipped"]),
  detail: z.string(),
}) satisfies z.ZodType<CertificationCheck>;

const zEvidence = z.object({
  lane: z.enum(["selftest", "conformance", "simulation"]),
  file: z.enum(["selftest.report.json", "conformance.report.json", "simulation.report.json"]),
  state: z.enum(["fresh", "missing", "corrupt", "failed", "stale"]),
  fresh: z.boolean(),
  passed: z.boolean().nullable(),
  bundleHash: z.string().nullable(),
  detail: z.string(),
}) satisfies z.ZodType<ExecutableEvidenceStatus>;

export const zEvidenceView = z.object({
  bundleHash: zBundleHash,
  staticStatus: z.enum(["passed", "failed", "expired"]),
  checks: z.array(zCheck),
  certification: z.object({ valid: z.boolean(), detail: z.string() }),
  execution: z.array(zEvidence),
});

export const zArtifacts = z.object({
  bundleHash: zBundleHash,
  files: z.array(z.object({ path: z.string(), bytes: z.number().int().nonnegative() })),
});
export const zArtifactQuery = z.object({ path: z.string().min(1) });
export const zArtifact = z.object({ path: z.string(), content: z.string(), bytes: z.number() });
export const zRegenerateRequest = z.object({ bundleHash: zBundleHash }).strict();
