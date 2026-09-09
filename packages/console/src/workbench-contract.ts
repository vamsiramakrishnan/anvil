import { Diagnostic, Operation } from "@anvil/air";
import type { CertificationCheck, ExecutableEvidenceStatus } from "@anvil/generators";
import type { DryRunPlan } from "@anvil/runtime";
import { z } from "zod";

/** On-demand operation detail; the schema and flags use AIR's shared projection. */
export const zOperationView = z.object({
  bundleHash: z.string().regex(/^[a-f0-9]{64}$/),
  diagnostics: z.array(Diagnostic),
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

/** Relative POSIX paths, shared by source uploads and artifact selection. */
const zRelativeFile = z
  .string()
  .min(1)
  .max(240)
  .refine(
    (value) =>
      !/[\\:]/.test(value) &&
      Array.from(value).every((char) => char.charCodeAt(0) >= 32) &&
      value
        .split("/")
        .every((part) => part.length > 0 && part !== "." && part !== ".." && !part.startsWith(".")),
    "Use a relative file path without hidden, parent, or empty segments.",
  );

const zCreateBundleRequest = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  input: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("upload"),
      entrypoint: zRelativeFile,
      files: z
        .array(z.object({ path: zRelativeFile, content: z.string().max(800_000) }))
        .min(1)
        .max(100),
    }),
    z.object({
      kind: z.literal("workspace"),
      path: z.string().min(1),
      entrypoint: zRelativeFile.optional(),
    }),
  ]),
  manifest: z.string().max(100_000).optional(),
  humanApproval: z.enum(["unsafe", "all"]).default("unsafe"),
});

export const WORKBENCH_ROUTES = {
  createBundle: {
    method: "POST",
    path: "/api/bundles",
    mutates: true,
    request: zCreateBundleRequest,
    response: z.object({
      id: z.string(),
      snapshotId: z.string(),
      generatedFiles: z.number(),
      operations: z.number(),
      diagnostics: z.array(Diagnostic),
    }),
  },
  evidence: {
    method: "GET",
    path: "/api/bundles/:id/evidence",
    mutates: false,
    response: z.object({
      bundleHash: z.string(),
      staticChecks: z.array(
        z.object({
          id: z.string(),
          gate: z.enum(["contract", "semantic", "safety", "runtime"]),
          status: z.enum(["passed", "failed", "skipped"]),
          detail: z.string(),
        }),
      ),
      certification: z.object({ valid: z.boolean(), detail: z.string() }),
      executable: z.array(zEvidenceStatus),
    }),
  },
} as const;

const zBundleHash = z.string().regex(/^[a-f0-9]{64}$/);
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

export const zRegenerateRequest = z.object({ bundleHash: zBundleHash }).strict();
