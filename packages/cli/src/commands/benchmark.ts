import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AirDocument, Operation } from "@anvil/air";
import { agentPropKey } from "@anvil/air";
import { BENCHMARK_REPORT_FILE, bundleHash, exampleInput, readBundleDir } from "@anvil/generators";
import { NodeAgentProcessRunner } from "@anvil/refinement";
import type { Command } from "commander";
import type { CliIO } from "../io.js";
import {
  analyzeConfusion,
  type ConfusionAnalysis,
  renderConfusionLines,
} from "./benchmark-clusters.js";
import {
  agentRouter,
  bareCatalog,
  benchmarkOperations,
  curatedCatalog,
  lexicalRouter,
  type RoutableTool,
  type RoutingOutcome,
  routeAndScore,
  type TaskRouter,
} from "./benchmark-routing.js";
import { loadBundleAir, resolveBundleDir } from "./certify.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";

/**
 * `anvil benchmark <dir>` — the demand-side measurement.
 *
 * Every other gate in this repository proves the SUPPLY side: the bundle is
 * faithful to AIR, the surfaces agree, the safety posture holds. None of them
 * ask whether an agent handed this surface actually reaches the right tool.
 * This lane asks exactly that: each approved operation's intent examples are
 * routed — intent in, tool name out — over the catalog the generated MCP
 * server serves, and over the bare catalog the source document supplies on its
 * own. A task passes when the curated surface routes it to the right tool AND
 * its required parameters are satisfiable from the surface's own examples.
 *
 * The bare-catalog score is the baseline that makes the curated score mean
 * something: the difference is what compilation bought. Routed by the
 * deterministic lexical router by default (a floor — an agent that can only
 * read), or by a real model via `--agent <command>`.
 */
export function registerBenchmark(parent: Command, ctx: CommandContext): void {
  annotate(
    parent
      .command("benchmark")
      .summary(
        "Route each intent example over the served tool catalog and score whether the agent reaches the right tool.",
      )
      .description(
        "Agent-task benchmark. For each approved operation's skill.intentExamples entry, routes the " +
          "intent over (a) the curated catalog the generated MCP server serves and (b) the bare catalog " +
          "the source document supplies on its own, then checks required parameters are satisfiable from " +
          "surface examples. A task passes when the curated route reaches the right tool and its params " +
          "are satisfiable; the bare score is the baseline that shows what compilation bought. Routing is " +
          "deterministic (lexical) by default; pass --agent <command> to route with a real model over " +
          "stdin/stdout. Writes benchmark.report.json, including deterministic mis-route clustering: " +
          "confusable tool families with their evidence, and routing hubs reported apart — candidates " +
          "for composition or collapse, never decisions. Exit 0 only when the score meets --check.",
      )
      .argument("<dir>", "generated bundle directory (or its air.yaml)")
      .option("--check <threshold>", "exit non-zero if score < threshold (0..1)")
      .option(
        "--agent <command>",
        'route with a real model: a command that reads the routing prompt on stdin and prints {"tool": "<name>"}',
      )
      .action(async (dir: string, opts: BenchmarkCliOptions) => {
        ctx.code = await runBenchmarkCommand(dir, opts, ctx.io);
      }),
    { mutates: false },
  );
}

export interface BenchmarkCliOptions {
  check?: string;
  agent?: string;
}

export interface BenchmarkTask {
  intent: string;
  /** Routing over the catalog the generated MCP server serves. */
  curated: RoutingOutcome;
  /** Routing over the source document's own names, nothing Anvil authored. */
  bare: RoutingOutcome;
  /** Required params satisfiable from the surface's own examples. */
  satisfiable: boolean;
  /** curated.pass && satisfiable — the score `--check` gates on. */
  pass: boolean;
  failReason?: string;
}

export interface BenchmarkOperationResult {
  operationId: string;
  toolName: string;
  tasks: BenchmarkTask[];
  score: number; // passed / total tasks
}

export interface BenchmarkReport {
  schemaVersion: 2;
  router: string;
  /** How many tools the router had to choose among — routing 1-of-2 and
   *  1-of-40 are different feats, so the size is part of the result. */
  catalogSize: number;
  operations: BenchmarkOperationResult[];
  /**
   * Mis-route clustering over the CURATED-catalog failures: confusable tool
   * families with their evidence, and routing hubs reported apart (see
   * benchmark-clusters.ts). An additive field within schemaVersion 2 — the
   * certify reader (`BenchmarkEvidenceReport` in @anvil/generators) validates
   * only the envelope it names, so extending the report does not break it.
   * Always a CANDIDATE signal ("worth asking about"), never a decision.
   */
  confusion: ConfusionAnalysis;
  summary: {
    total: number;
    passed: number;
    /** passed/total on the curated surface — what `--check` gates. */
    score: number;
    /** Tasks the curated catalog routed correctly. */
    curatedRouted: number;
    /** Tasks the bare catalog routed correctly — the baseline. */
    bareRouted: number;
    /** curated score minus bare score, in points of task share. */
    upliftPts: number;
  };
  bundleHash: string;
}

export async function runBenchmarkCommand(
  path: string,
  opts: BenchmarkCliOptions,
  io: CliIO,
): Promise<number> {
  const dir = resolveBundleDir(path);

  // Load the canonical AIR the same way every other bundle command does:
  // air.yaml first (the file `refine apply` mutates), then air.json. Reading
  // json-first here made the benchmark score a stale projection after apply.
  const files = readBundleDir(dir);
  const air = loadBundleAir(dir, files);

  const router: TaskRouter = opts.agent
    ? agentRouter(new NodeAgentProcessRunner(), opts.agent)
    : lexicalRouter();

  const report = await runBenchmark(air, router);
  const boundReport: BenchmarkReport = {
    ...report,
    bundleHash: bundleHash(files),
  };

  writeFileSync(
    join(dir, BENCHMARK_REPORT_FILE),
    `${JSON.stringify(boundReport, null, 2)}\n`,
    "utf8",
  );

  io.out(renderBenchmarkSummary(boundReport, dir));

  if (opts.check !== undefined) {
    const threshold = parseFloat(opts.check);
    if (Number.isNaN(threshold) || threshold < 0 || threshold > 1) {
      throw new Error(`Invalid threshold: ${opts.check}. Must be a number between 0 and 1.`);
    }
    if (boundReport.summary.score < threshold) {
      return 1;
    }
  }

  return 0;
}

async function runBenchmark(
  air: AirDocument,
  router: TaskRouter,
): Promise<Omit<BenchmarkReport, "bundleHash">> {
  const ops = benchmarkOperations(air);
  const curated = curatedCatalog(ops);
  const bare = bareCatalog(ops);

  const operations: BenchmarkOperationResult[] = [];
  let total = 0;
  let passed = 0;
  let curatedRouted = 0;
  let bareRouted = 0;

  for (const op of ops) {
    const tasks: BenchmarkTask[] = [];
    for (const intent of op.skill.intentExamples) {
      const task = await scoreTask(op, intent, router, curated, bare);
      total++;
      if (task.pass) passed++;
      if (task.curated.pass) curatedRouted++;
      if (task.bare.pass) bareRouted++;
      tasks.push(task);
    }
    operations.push({
      operationId: op.id,
      toolName: op.mcp.toolName,
      tasks,
      score: tasks.length > 0 ? tasks.filter((t) => t.pass).length / tasks.length : 0,
    });
  }

  const score = total > 0 ? passed / total : 0;
  const bareScore = total > 0 ? bareRouted / total : 0;
  const curatedScore = total > 0 ? curatedRouted / total : 0;
  return {
    schemaVersion: 2,
    router: router.name,
    catalogSize: curated.length,
    operations,
    confusion: analyzeConfusion(operations),
    summary: {
      total,
      passed,
      score,
      curatedRouted,
      bareRouted,
      upliftPts: Math.round((curatedScore - bareScore) * 1000) / 10,
    },
  };
}

async function scoreTask(
  op: Operation,
  intent: string,
  router: TaskRouter,
  curated: readonly RoutableTool[],
  bare: readonly RoutableTool[],
): Promise<BenchmarkTask> {
  const curatedOutcome = await routeAndScore(router, intent, curated, op.id);
  const bareOutcome = await routeAndScore(router, intent, bare, op.id);

  let satisfiable = true;
  let failReason: string | undefined;
  try {
    validateExampleInput(op, exampleInput(op));
  } catch (err) {
    satisfiable = false;
    failReason = err instanceof Error ? err.message : String(err);
  }
  if (!curatedOutcome.pass && failReason === undefined) {
    failReason = curatedOutcome.routed
      ? `routed to '${curatedOutcome.routed}' instead of '${op.mcp.toolName}'`
      : "no tool routed — the intent matches nothing in the served catalog";
  }

  return {
    intent,
    curated: curatedOutcome,
    bare: bareOutcome,
    satisfiable,
    pass: curatedOutcome.pass && satisfiable,
    ...(failReason !== undefined ? { failReason } : {}),
  };
}

function validateExampleInput(op: Operation, exampleParams: Record<string, unknown>): void {
  // `input.params` is an ARRAY, and `exampleInput` keys by the *surface* name
  // (`propKey`, e.g. snake_case) — compare on those, not array indices.
  for (const p of op.input.params) {
    if (p.required && !(agentPropKey(p) in exampleParams)) {
      throw new Error(
        `Required parameter '${p.name}' not satisfiable from example for operation ${op.id}`,
      );
    }
  }
}

function renderBenchmarkSummary(report: BenchmarkReport, dir: string): string {
  const lines: string[] = [
    `Agent-task benchmark — ${dir}`,
    `Router: ${report.router} over ${report.catalogSize} tools`,
    "",
  ];

  for (const opResult of report.operations) {
    const taskCount = opResult.tasks.length;
    if (taskCount === 0) {
      lines.push(
        `  – ${opResult.operationId} (${opResult.toolName}): no tasks derivable (no intentExamples)`,
      );
    } else {
      const passCount = opResult.tasks.filter((t) => t.pass).length;
      const scoreStr = (opResult.score * 100).toFixed(0);
      lines.push(
        `  ${passCount === taskCount ? "✓" : "✗"} ${opResult.operationId} (${opResult.toolName}): ${passCount}/${taskCount} tasks (${scoreStr}%)`,
      );
      for (const task of opResult.tasks) {
        if (!task.pass && task.failReason) {
          lines.push(`      ${task.intent}: ${task.failReason}`);
        }
      }
    }
  }

  lines.push(...renderConfusionLines(report.confusion));

  lines.push("");
  const { total, passed, score, curatedRouted, bareRouted, upliftPts } = report.summary;
  const scorePercent = (score * 100).toFixed(1);
  lines.push(
    `Routing: curated ${curatedRouted}/${total}, bare ${bareRouted}/${total} ` +
      `(${upliftPts >= 0 ? "+" : ""}${upliftPts.toFixed(1)} pts from compilation).`,
  );
  lines.push(
    `${passed === total ? "PASSED — " : ""}${passed}/${total} tasks passed (${scorePercent}%). ` +
      `Wrote ${join(dir, BENCHMARK_REPORT_FILE)}.`,
  );

  return lines.join("\n");
}
