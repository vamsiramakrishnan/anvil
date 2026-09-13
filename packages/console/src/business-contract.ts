import { BusinessJournalRecord, BusinessProject } from "@anvil/air";
import { z } from "zod";

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Impact = z.object({
  action: z.string(),
  changes: z.array(
    z.enum([
      "added",
      "removed",
      "input",
      "output",
      "guidance",
      "effects",
      "authority",
      "policy",
      "execution",
    ]),
  ),
  sourceOperations: z.array(z.string()),
  evaluations: z.array(z.string()),
  approvalRenewal: z.boolean(),
  compatibility: z.enum(["unchanged", "review_required"]),
});
const ProjectView = z.object({
  digest: Digest,
  project: BusinessProject,
  planDigest: Digest,
  public: z.unknown(),
  impact: z.array(Impact).nullable(),
});
const Agent = z.object({ id: z.string(), metadata: z.record(z.string(), z.string()) });
const Lane = z.enum(["raw", "business", "business-skill"]);
const Run = z
  .object({
    status: z.enum(["passed", "failed", "inconclusive", "unsupported"]),
    traces: z.array(z.unknown()),
    checks: z.array(z.unknown()),
    replay: z.unknown().optional(),
  })
  .passthrough();
const Report = z.object({
  schemaVersion: z.literal(1),
  projectDigest: Digest,
  planDigest: Digest,
  evaluator: z.object({ id: z.string(), version: z.string() }),
  agent: Agent,
  configuration: z.object({
    repeats: z.number(),
    seed: z.number(),
    maxCalls: z.number(),
    timeoutMs: z.number(),
  }),
  status: z.enum(["completed", "cancelled"]),
  trials: z.array(
    z.object({
      task: z.string(),
      lane: Lane,
      seed: z.number(),
      elapsedMs: z.number(),
      calls: z.number(),
      run: Run,
    }),
  ),
  summary: z.array(
    z.object({
      lane: Lane,
      passed: z.number(),
      failed: z.number(),
      inconclusive: z.number(),
      total: z.number(),
      successInterval95: z.tuple([z.number(), z.number()]).nullable(),
      meanCalls: z.number().nullable(),
      meanLatencyMs: z.number().nullable(),
    }),
  ),
  tokens: z.null(),
});
const Job = z.object({
  id: z.string(),
  project: z.string(),
  projectDigest: Digest,
  owner: z.string(),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled", "interrupted"]),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  completedTrials: z.number(),
  trials: Report.shape.trials,
  report: Report.optional(),
  message: z.string().optional(),
});
export const BUSINESS_ROUTES = {
  businessExecutions: {
    method: "GET",
    path: "/api/business/projects/:id/executions",
    mutates: false,
    response: z.array(z.object({ trace: z.string(), records: z.array(BusinessJournalRecord) })),
  },
  businessProjects: {
    method: "GET",
    path: "/api/business/projects",
    mutates: false,
    response: z.object({
      enabled: z.boolean(),
      projects: z.array(
        z.object({ id: z.string(), name: z.string(), digest: Digest, actions: z.number() }),
      ),
    }),
  },
  businessProject: {
    method: "GET",
    path: "/api/business/projects/:id",
    mutates: false,
    response: ProjectView,
  },
  saveBusinessProject: {
    method: "POST",
    path: "/api/business/projects",
    mutates: true,
    request: z.strictObject({ project: BusinessProject, expectedDigest: Digest.nullable() }),
    response: ProjectView,
  },
  previewBusinessProject: {
    method: "POST",
    path: "/api/business/projects/preview",
    mutates: true,
    request: z.strictObject({ project: BusinessProject, against: Digest.optional() }),
    response: ProjectView,
  },
  buildBusinessProject: {
    method: "POST",
    path: "/api/business/projects/:id/build",
    mutates: true,
    request: z.strictObject({ expectedDigest: Digest }),
    response: z.object({ bundleId: z.string(), digest: Digest, planDigest: Digest }),
  },
  businessJobs: {
    method: "GET",
    path: "/api/business/projects/:id/jobs",
    mutates: false,
    response: z.array(Job),
  },
  evaluateBusinessProject: {
    method: "POST",
    path: "/api/business/projects/:id/evaluate",
    mutates: true,
    request: z.strictObject({ expectedDigest: Digest, repeats: z.number().int().min(1).max(20) }),
    response: Job,
  },
  cancelBusinessJob: {
    method: "POST",
    path: "/api/business/projects/:id/jobs/:jobId/cancel",
    mutates: true,
    request: z.strictObject({}),
    response: Job,
  },
} as const;
