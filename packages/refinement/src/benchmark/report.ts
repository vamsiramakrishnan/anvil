import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/**
 * The benchmark report as `anvil benchmark` writes it next to a bundle —
 * schemaVersion 2, the first version whose score measures anything (intent
 * routing over the served catalog), plus the deterministic mis-route
 * clustering (`confusion`). This is the one typed, parseable shape of that
 * file: the certify reader in `@anvil/generators` validates only the envelope
 * it needs (digest + summary), the group bridge (`protocol/group.ts`) reads
 * only the cluster slice, and a console or any other reader that wants the
 * whole record parses it here.
 *
 * The zod schemas are the source of truth; the TypeScript types are inferred
 * from them so a field cannot exist in the type without existing in the
 * parser. `clusters.ts` builds its analysis against these types.
 */

/** Where `anvil benchmark` writes deterministic agent-task benchmark results. */
export const BENCHMARK_REPORT_FILE = "benchmark.report.json";

const zRoutingOutcome = z.object({
  routed: z.string().optional(),
  pass: z.boolean(),
});

const zBenchmarkTask = z.object({
  intent: z.string(),
  /** Routing over the catalog the generated MCP server serves. */
  curated: zRoutingOutcome,
  /** Routing over the source document's own names, nothing Anvil authored. */
  bare: zRoutingOutcome,
  /** Required params satisfiable from the surface's own examples. */
  satisfiable: z.boolean(),
  /** curated.pass && satisfiable — the score `--check` gates on. */
  pass: z.boolean(),
  failReason: z.string().optional(),
});
export type BenchmarkTask = z.infer<typeof zBenchmarkTask>;

const zBenchmarkOperationResult = z.object({
  operationId: z.string(),
  toolName: z.string(),
  tasks: z.array(zBenchmarkTask),
  /** passed / total tasks */
  score: z.number(),
});
export type BenchmarkOperationResult = z.infer<typeof zBenchmarkOperationResult>;

/** One directed confusion: tasks belonging to `intended` that the curated
 *  catalog routed to `routed`, with the mis-routed intents verbatim. */
const zConfusionEdge = z.object({
  intended: z.string(),
  routed: z.string(),
  count: z.number(),
  intents: z.array(z.string()),
  /** Routing-token stems the two tool names share — the collision vocabulary.
   *  Tokens carried by half the catalog or more (the service prefix) are
   *  excluded: a word every tool says explains no particular collision. */
  sharedTokens: z.array(z.string()),
});
export type ConfusionEdge = z.infer<typeof zConfusionEdge>;

const zClusterMember = z.object({ operationId: z.string(), toolName: z.string() });

/** K mutually confusable tools, with the evidence that makes them so. */
const zConfusionCluster = z.object({
  /**
   * Deterministic cluster id (`cc_` + 12 hex of the sorted member tool names'
   * canonical hash): the coordinate `anvil refine export-task <dir> group:<id>`
   * uses to hand this cluster to a coding harness. A pure function of the
   * membership, so the same confusions name the same cluster across runs.
   */
  id: z.string(),
  members: z.array(zClusterMember),
  /** Total mis-routed tasks inside the cluster — the evidence weight. */
  taskCount: z.number(),
  edges: z.array(zConfusionEdge),
  /** Union of the per-edge shared vocabulary, sorted. */
  sharedTokens: z.array(z.string()),
});
export type ConfusionCluster = z.infer<typeof zConfusionCluster>;

/** A tool confused with a catalog-scale number of partners — the FLEXCUBE
 *  envelope-noise shape. Reported apart so it cannot weld clusters. */
const zRoutingHub = z.object({
  operationId: z.string(),
  toolName: z.string(),
  /** Distinct tools this one was confused with, in either direction. */
  distinctPartners: z.number(),
  /** Mis-routed tasks touching this tool (into it, or out of it). */
  taskCount: z.number(),
  /** The mis-routed intents, verbatim. */
  intents: z.array(z.string()),
});
export type RoutingHub = z.infer<typeof zRoutingHub>;

const zConfusionAnalysis = z.object({
  /**
   * What this analysis is allowed to mean: each cluster is a CANDIDATE for
   * composition or collapse — worth asking about — never a decision. The
   * literal rides in the report so downstream readers cannot mistake a
   * structural signal for an approved grouping.
   */
  posture: z.literal("candidate"),
  minClusterEvidence: z.number(),
  hubPartnerFraction: z.number(),
  hubMinPartners: z.number(),
  hubs: z.array(zRoutingHub),
  clusters: z.array(zConfusionCluster),
});
export type ConfusionAnalysis = z.infer<typeof zConfusionAnalysis>;

export const zBenchmarkReport = z.object({
  schemaVersion: z.literal(2),
  router: z.string(),
  /** How many tools the router had to choose among — routing 1-of-2 and
   *  1-of-40 are different feats, so the size is part of the result. */
  catalogSize: z.number(),
  operations: z.array(zBenchmarkOperationResult),
  /**
   * Mis-route clustering over the CURATED-catalog failures: confusable tool
   * families with their evidence, and routing hubs reported apart (see
   * clusters.ts). Always a CANDIDATE signal ("worth asking about"), never a
   * decision.
   */
  confusion: zConfusionAnalysis,
  summary: z.object({
    total: z.number(),
    passed: z.number(),
    /** passed/total on the curated surface — what `--check` gates. */
    score: z.number(),
    /** Tasks the curated catalog routed correctly. */
    curatedRouted: z.number(),
    /** Tasks the bare catalog routed correctly — the baseline. */
    bareRouted: z.number(),
    /** curated score minus bare score, in points of task share. */
    upliftPts: z.number(),
  }),
  /** The bundle content digest the report was measured against. */
  bundleHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type BenchmarkReport = z.infer<typeof zBenchmarkReport>;

/** Parse a full benchmark report; the error names the first offending path. */
export function parseBenchmarkReport(value: unknown): BenchmarkReport {
  const result = zBenchmarkReport.safeParse(value);
  if (result.success) return result.data;
  const issues = result.error.issues
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid benchmark report: ${issues}`);
}

/** Read `benchmark.report.json` beside a bundle, or `undefined` when none was written. */
export function readBenchmarkReport(bundleDir: string): BenchmarkReport | undefined {
  const path = join(bundleDir, BENCHMARK_REPORT_FILE);
  if (!existsSync(path)) return undefined;
  return parseBenchmarkReport(JSON.parse(readFileSync(path, "utf8")));
}
