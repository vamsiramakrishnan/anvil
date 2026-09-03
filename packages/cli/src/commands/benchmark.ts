import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AirDocument, Operation } from "@anvil/air";
import { agentPropKey } from "@anvil/air";
import {
  bundleHash,
  exampleInput,
  loadBundleAir,
  readBundleDir,
  resolveBundleDir,
} from "@anvil/generators";
import {
  agentRouter,
  analyzeConfusion,
  BENCHMARK_REPORT_FILE,
  type BenchmarkOperationResult,
  type BenchmarkReport,
  type BenchmarkTask,
  bareCatalog,
  benchmarkOperations,
  type CatalogSummary,
  type CatalogsBlock,
  curatedCatalog,
  type DisclosureCostEstimate,
  ladderedCatalog,
  lexicalRouter,
  NodeAgentProcessRunner,
  type RoutableTool,
  renderConfusionLines,
  routeAndScore,
  stagedRoute,
  type TaskRouter,
} from "@anvil/refinement";
import { type Command, Option } from "commander";
import type { CliIO } from "../io.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";

/** `--catalog` values: which catalog shape(s) `anvil benchmark` routes over. */
const CATALOG_MODES = ["flat", "laddered", "both"] as const;
type CatalogMode = (typeof CATALOG_MODES)[number];

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
          "stdin/stdout. --catalog laddered or --catalog both additionally stages the route over the " +
          "disclosure ladder (@anvil/air's ladderPlan, served by the MCP runtime's lane.ts): stage 1 picks " +
          "a lane, stage 2 routes within it, falling back to the flat catalog when the ladder plan declines. " +
          "--catalog both prints a flat-vs-laddered comparison table and records it (and a disclosure-cost " +
          "estimate in measured tool-surface tokens) in benchmark.report.json's optional catalogs field; the " +
          "top-level score always stays the flat-catalog measurement, so --check and every existing reader " +
          "keep gating on the same number they always have. Writes benchmark.report.json, including " +
          "deterministic mis-route clustering: confusable tool families with their evidence, and routing " +
          "hubs reported apart — candidates for composition or collapse, never decisions. Exit 0 only when " +
          "the score meets --check.",
      )
      .argument("<dir>", "generated bundle directory (or its air.yaml)")
      .option("--check <threshold>", "exit non-zero if score < threshold (0..1)")
      .option(
        "--agent <command>",
        'route with a real model: a command that reads the routing prompt on stdin and prints {"tool": "<name>"}',
      )
      .addOption(
        new Option(
          "--catalog <mode>",
          "which catalog(s) to route over: flat (default, today's behavior), laddered (stage over " +
            "@anvil/air's disclosure ladder), or both (adds a flat-vs-laddered comparison)",
        ).choices(CATALOG_MODES),
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
  catalog?: CatalogMode;
}

// The report shape (`BenchmarkReport`, `BenchmarkTask`, `BenchmarkOperationResult`)
// is declared once, as zod, in `@anvil/refinement` — the same schema any reader
// of `benchmark.report.json` parses. This command only fills it in.

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

  // The flat-catalog run is unconditional and every top-level field below is
  // always ITS numbers — `--catalog` only controls whether the additive
  // `catalogs` comparison is computed alongside it, so `--check` and every
  // existing reader (the console contract, the certify reader) keep gating on
  // exactly the score they always have, whichever mode was asked for.
  const report = await runBenchmark(air, router);

  // Defaulted here, not on the commander option, so this line is the one
  // place "no --catalog flag" is decided — mutant
  // benchmark-ladder/flat-default-unchanged pins it staying "flat".
  const catalog: CatalogMode = opts.catalog ?? "flat";
  const catalogs =
    catalog === "flat" ? undefined : await runCatalogsComparison(air, router, catalog, report);

  const boundReport: BenchmarkReport = {
    ...report,
    ...(catalogs ? { catalogs } : {}),
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

/**
 * The `--catalog laddered`/`both` measurement: stage every intent over the
 * disclosure ladder (`ladderedCatalog`/`stagedRoute`, `@anvil/refinement`'s
 * projection of `@anvil/air`'s `ladderPlan`) and, for `both`, the flat
 * catalog's own routing-only accuracy beside it — the same `curatedRouted`
 * figure the top-level `report` already computed, read back rather than
 * re-routed, so the two numbers can never drift from what actually ran.
 *
 * The disclosure-cost estimate is read entirely from `ladderPlan`'s own
 * measured token totals (`flatTokens`, `restTokens`, per-lane `laneTokens`) —
 * the same figures the compiler's capability-review budget sums as
 * `disclosureTokens` — never recomputed here. "The opened lane" is scored
 * per task: `avgOpenedLaneTokens` averages the entered lane's measured cost
 * over every task that actually opened one, which is 0 (and the estimate
 * collapses to `ladderRestTokens`) when the plan declined or no task in this
 * bundle ever opened a lane.
 */
async function runCatalogsComparison(
  air: AirDocument,
  router: TaskRouter,
  mode: CatalogMode,
  flatReport: Omit<BenchmarkReport, "bundleHash">,
): Promise<CatalogsBlock> {
  const ops = benchmarkOperations(air);
  const ladder = ladderedCatalog(air);
  const laneTokensByEntry = new Map(
    ladder.plan.lanes.map((lane) => [lane.entryToolName, lane.laneTokens]),
  );

  let total = 0;
  let passed = 0;
  const openedLaneTokens: number[] = [];

  for (const op of ops) {
    for (const intent of op.skill.intentExamples) {
      const outcome = await stagedRoute(router, intent, ladder, op.id);
      total++;
      if (outcome.pass) passed++;
      if (outcome.enteredLane !== undefined) {
        const tokens = laneTokensByEntry.get(outcome.enteredLane);
        if (tokens !== undefined) openedLaneTokens.push(tokens);
      }
    }
  }

  const flatTotal = flatReport.summary.total;
  const bareScore = flatTotal > 0 ? flatReport.summary.bareRouted / flatTotal : 0;
  const ladderedAccuracy = total > 0 ? passed / total : 0;
  const laddered: CatalogSummary = {
    total,
    passed,
    accuracy: ladderedAccuracy,
    upliftPts: Math.round((ladderedAccuracy - bareScore) * 1000) / 10,
  };

  const avgOpenedLaneTokens =
    openedLaneTokens.length > 0
      ? Math.round(openedLaneTokens.reduce((a, b) => a + b, 0) / openedLaneTokens.length)
      : 0;
  const disclosureCost: DisclosureCostEstimate = {
    flatTokens: ladder.plan.flatTokens,
    ladderRestTokens: ladder.plan.restTokens,
    avgOpenedLaneTokens,
    estimatedLadderedTokens: ladder.plan.restTokens + avgOpenedLaneTokens,
  };

  if (mode !== "both") return { laddered, disclosureCost };

  const flat: CatalogSummary = {
    total: flatTotal,
    passed: flatReport.summary.curatedRouted,
    accuracy: flatTotal > 0 ? flatReport.summary.curatedRouted / flatTotal : 0,
    upliftPts: flatReport.summary.upliftPts,
  };
  return { flat, laddered, disclosureCost };
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

function renderCatalogsLines(catalogs: CatalogsBlock): string[] {
  const lines: string[] = ["Catalog comparison:"];
  const row = (label: string, s: CatalogSummary) =>
    lines.push(
      `  ${label}: ${s.passed}/${s.total} routed (${(s.accuracy * 100).toFixed(1)}%, ` +
        `${s.upliftPts >= 0 ? "+" : ""}${s.upliftPts.toFixed(1)} pts vs bare)`,
    );
  if (catalogs.flat) row("flat    ", catalogs.flat);
  if (catalogs.laddered) row("laddered", catalogs.laddered);
  if (catalogs.disclosureCost) {
    const c = catalogs.disclosureCost;
    lines.push(
      `  Disclosure cost (measured tool-surface tokens): flat ${c.flatTokens} at rest; ` +
        `laddered ~${c.estimatedLadderedTokens}/task (${c.ladderRestTokens} rest + ` +
        `${c.avgOpenedLaneTokens} avg opened lane).`,
    );
  }
  return lines;
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

  if (report.catalogs) lines.push("", ...renderCatalogsLines(report.catalogs));

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
