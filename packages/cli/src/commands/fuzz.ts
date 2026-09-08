import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { loadAirDocument, operationInputSchema } from "@anvil/air";
import type { CampaignReport, SkillRun } from "@anvil/fuzz";
import {
  bundleHash,
  generateBundle,
  readBundleDir,
  resolveBundleDir,
  writeBundle,
} from "@anvil/generators";
import type { FuzzSurface } from "@anvil/harness";
import { type Command, InvalidArgumentError } from "commander";
import { z } from "zod";
import { emitRefusal } from "../envelope.js";
import type { CliIO } from "../io.js";
import { resolveCliPackageDir } from "./cli-package.js";
import type { CommandContext } from "./context.js";
import { fuzzToolchainHash } from "./fuzz-identity.js";
import { annotate } from "./meta.js";

export interface FuzzOptions {
  example?: string;
  fixture?: string;
  surfaces?: string;
  seed?: number;
  runs?: number;
  budgetMs?: number;
  timeoutMs?: number;
  out?: string;
  replay?: string;
  againstCurrent?: boolean;
  agentConfig?: string;
  json?: boolean;
  case?: string;
  predicate?: string;
  value?: string;
}

function integer(value: string): number {
  if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new InvalidArgumentError("Expected an integer");
  return Number(value);
}

export function registerFuzz(parent: Command, ctx: CommandContext): void {
  annotate(
    parent
      .command("fuzz")
      .summary("Find, shrink, and replay failures across generated tool surfaces.")
      .description(
        "Run seeded campaigns against isolated loopback fixtures. Contract mode checks AIR/wire consistency; the payments example uses an independent stateful ledger. Writes a private report and exact replay under --out. Exit 0 means all evaluated checks passed; 1 means a semantic failure; 2 means unsupported or inconclusive coverage. A passing campaign is bounded test evidence, not release certification. --agent-config runs an explicitly configured NDJSON harness bridge against the payment task and records actual tool calls.",
      )
      .argument("[dir]", "generated bundle directory")
      .option("--example <name>", "generate the owned payments fixture bundle")
      .option("--fixture <name>", "contract or payments", "contract")
      .option(
        "--surfaces <list>",
        "comma-separated mcp,cli,cli-mcp,python (agent mode: one surface)",
      )
      .option("--seed <n>", "deterministic generation seed", integer, 42)
      .option("--runs <n>", "generated scenarios, excluding shrinking", integer, 5)
      .option("--budget-ms <n>", "campaign or agent time budget", integer, 120000)
      .option("--timeout-ms <n>", "per driver open/call deadline", integer, 10000)
      .option("--out <dir>", "root for unique report directories", ".anvil/fuzz")
      .option("--replay <file>", "execute an exact recorded replay JSON")
      .option(
        "--against-current",
        "acknowledge changed bundle/toolchain hashes when replaying a repair",
      )
      .option(
        "--agent-config <file>",
        "explicit process harness configuration; payments fixture only",
      )
      .option(
        "--case <dir>",
        "attach report evidence to an existing case using its admissibility policy",
      )
      .option("--predicate <name>", "explicit claim predicate for --case")
      .option("--value <json>", "explicit claim value for --case")
      .option("--json", "emit the full report and artifact paths")
      .action(async (dir: string | undefined, opts: FuzzOptions) => {
        try {
          ctx.code = await runFuzzCommand(dir, opts, ctx.io);
        } catch (error) {
          ctx.code = emitRefusal(ctx.io, opts.json, {
            reportType: "anvil.fuzz-error",
            code: "fuzz_command_refused",
            message:
              error instanceof SyntaxError || error instanceof z.ZodError
                ? "Invalid fuzz JSON input or configuration"
                : error instanceof Error
                  ? error.message
                  : "Fuzz command failed",
          });
        }
      }),
    { mutates: true },
  );
}

const AgentConfig = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    cwd: z.string().optional(),
    /** Destination environment key -> existing environment variable name. */
    env: z.record(z.string(), z.string()).default({}),
    metadata: z.record(z.string(), z.string()).default({}),
    maxCalls: z.number().int().min(1).max(100).default(20),
  })
  .strict();

export async function runFuzzCommand(
  path: string | undefined,
  opts: FuzzOptions,
  io: CliIO,
): Promise<number> {
  if ((!path && !opts.example) || (path && opts.example))
    throw new Error("Supply a bundle directory or --example payments");
  if (opts.example && opts.example !== "payments")
    throw new Error("The supported example is payments");
  const fixture = opts.example ? "payments" : (opts.fixture ?? "contract");
  if (!["contract", "payments"].includes(fixture))
    throw new Error("The fixture must be contract or payments");
  if (opts.againstCurrent && !opts.replay) throw new Error("--against-current requires --replay");
  if (opts.agentConfig && (opts.replay || fixture !== "payments"))
    throw new Error("Agent execution requires the payments fixture and cannot resample a replay");
  if (
    opts.case
      ? !opts.predicate || opts.value === undefined
      : opts.predicate || opts.value !== undefined
  )
    throw new Error("Evidence attachment requires --case, --predicate, and --value together");
  const claim = opts.value === undefined ? undefined : z.json().parse(JSON.parse(opts.value));
  const surfaces = (opts.surfaces ?? (opts.agentConfig ? "cli" : "mcp,cli,python")).split(
    ",",
  ) as FuzzSurface[];
  if (
    !surfaces.length ||
    new Set(surfaces).size !== surfaces.length ||
    surfaces.some((s) => !["mcp", "cli", "cli-mcp", "python"].includes(s))
  )
    throw new Error("Choose distinct supported surfaces: mcp,cli,cli-mcp,python");
  if (opts.agentConfig && surfaces.length !== 1)
    throw new Error("Agent execution requires exactly one surface");
  const seed = opts.seed ?? 42;
  const runs = opts.runs ?? 5;
  const budgetMs = opts.budgetMs ?? 120000;
  const timeoutMs = opts.timeoutMs ?? 10000;
  if (
    !Number.isInteger(seed) ||
    seed < -2147483648 ||
    seed > 2147483647 ||
    !Number.isInteger(runs) ||
    runs < 1 ||
    runs > 10000 ||
    !Number.isInteger(budgetMs) ||
    budgetMs < 1 ||
    budgetMs > 3600000 ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 3600000
  )
    throw new Error("Invalid seed, runs (1–10000), or time budget (1–3600000 ms)");
  const core = await import("@anvil/fuzz");
  const harness = await import("@anvil/harness");
  const root = resolve(opts.out ?? ".anvil/fuzz");
  if (path) {
    const rel = relative(resolveBundleDir(path), root);
    if (!rel || (!rel.startsWith("..") && !isAbsolute(rel)))
      throw new Error(
        "--out must be outside the source bundle so reports do not change its identity",
      );
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const output = mkdtempSync(join(root, "run-"));
  let dir: string;
  if (opts.example) {
    dir = join(output, "bundle");
    writeBundle(dir, generateBundle(await harness.compilePaymentFuzzFixture()));
  } else {
    dir = resolveBundleDir(path as string);
  }
  const files = readBundleDir(dir);
  const air = loadAirDocument(JSON.parse(files["air.json"] ?? "null"));
  if (
    fixture === "payments" &&
    JSON.stringify(air) !== JSON.stringify(await harness.compilePaymentFuzzFixture())
  )
    throw new Error(
      "The payments fixture requires its owned example AIR; use --example payments or that generated bundle",
    );
  const cliPackageDir = resolveCliPackageDir();
  const identity = {
    bundle: bundleHash(files),
    toolchain: fuzzToolchainHash(cliPackageDir, harness.packageDirOf),
    adapter: "anvil-fuzz/v1",
    fixture: `${fixture}/v1`,
    oracle: `${fixture}/v1`,
  };
  const drivers = harness.bundleFuzzDrivers(files, {
    surfaces,
    cliPackageDir,
    ...(fixture === "payments" ? { fixture: harness.paymentFuzzFixture } : {}),
  });
  const properties = [
    fixture === "payments" ? harness.paymentProperties(air) : harness.contractProperties(air),
  ];
  const replay = opts.replay
    ? core.Replay.parse(JSON.parse(readFileSync(resolve(opts.replay), "utf8")))
    : undefined;
  // A captured skill trajectory is replayed as exact tool calls, with its goal oracle.
  if (replay?.identity.task === "payment-refund-17/v1")
    properties.push(harness.paymentTaskGoal(17));
  if (replay?.identity.task) identityWithTask(identity, replay.identity.task);
  let report: CampaignReport | SkillRun;
  if (opts.agentConfig) {
    identityWithTask(identity, "payment-refund-17/v1");
    const configPath = resolve(opts.agentConfig);
    const config = AgentConfig.parse(JSON.parse(readFileSync(configPath, "utf8")));
    const env: Record<string, string> = {};
    for (const [key, variable] of Object.entries(config.env)) {
      const value = process.env[variable];
      if (value === undefined)
        throw new Error(`Agent environment variable is unavailable: ${variable}`);
      env[key] = value;
    }
    const driver = drivers[0];
    if (!driver) throw new Error("Missing agent surface");
    report = await core.runSkillTask({
      agent: core.processAgent(
        {
          command: config.command,
          args: config.args,
          cwd: resolve(dirname(configPath), config.cwd ?? "."),
          env,
        },
        config.metadata,
      ),
      driver,
      properties: [...properties, harness.paymentTaskGoal(17)],
      seed,
      timeoutMs: budgetMs,
      maxCalls: config.maxCalls,
      identity,
      task: {
        task: "Refund exactly 17 units from payment p1 once. The user explicitly authorizes this refund. Use the supplied skill and preserve a stable idempotency key across any repeat. Tool invocations use catalog operation IDs; the host executes the selected generated surface.",
        skill: files["skill/SKILL.md"] ?? "",
        references: Object.fromEntries(
          Object.entries(files).filter(([name]) => name.startsWith("skill/reference/")),
        ),
        catalog: air.operations
          .filter((op) => op.state === "approved")
          .map((op) => ({
            operation: op.id,
            description: op.description,
            inputSchema: operationInputSchema(op),
          })),
      },
    });
  } else {
    const options = { drivers, properties, timeoutMs, budgetMs, identity };
    report = replay
      ? await core.replayCampaign(replay, {
          ...options,
          allowIdentityChanges: opts.againstCurrent ? ["bundle", "toolchain"] : [],
        })
      : await core.runCampaign({
          ...options,
          arbitrary:
            fixture === "payments" ? harness.paymentScenarios(air) : harness.contractScenarios(air),
          seed,
          runs,
        });
  }
  const reportPath = join(output, "report.json");
  writePrivate(reportPath, { ...report, schemaVersion: 1, reportType: "anvil.fuzz", identity });
  const replayPath = report.replay ? join(output, "replay.json") : undefined;
  if (replayPath) writePrivate(replayPath, report.replay);
  let evidence: string | undefined;
  if (opts.case) {
    const { caseService, hashJson, loadCaseDocument } = await import("@anvil/refinement");
    const caseDoc = loadCaseDocument(resolve(opts.case));
    if (caseDoc.identity.airHash !== hashJson(air).slice(0, 16))
      throw new Error(
        `Report saved at ${reportPath}; case AIR identity differs from the tested AIR`,
      );
    const observed =
      "coverage" in report
        ? report.coverage.operations
        : report.scenario.steps.map((step) => step.operation);
    if (caseDoc.target.operationId && !observed.includes(caseDoc.target.operationId))
      throw new Error(`Report saved at ${reportPath}; the case operation was not exercised`);
    evidence = await caseService.addEvidence(resolve(opts.case), {
      predicate: opts.predicate as string,
      value: claim,
      source: fixture === "payments" ? "test_fixture" : "generated_mock",
      path: reportPath,
      note: `Bounded fuzz campaign: ${report.status}; bundle ${identity.bundle}. Fixture evidence does not prove live upstream behavior.`,
    });
  }
  if (opts.json)
    io.out(
      JSON.stringify(
        {
          ...report,
          schemaVersion: 1,
          reportType: "anvil.fuzz",
          identity,
          artifacts: { report: reportPath, replay: replayPath, bundle: dir },
          evidence,
        },
        null,
        2,
      ),
    );
  else {
    const checks =
      "coverage" in report
        ? report.coverage.checks
        : report.checks.reduce(
            (counts, c) => {
              counts[c.status]++;
              return counts;
            },
            { passed: 0, failed: 0, unsupported: 0, inconclusive: 0 },
          );
    io.out(
      `Fuzz ${report.status} — ${surfaces.join(" + ")}\n${checks.passed} passed, ${checks.failed} failed, ${checks.unsupported} unsupported, ${checks.inconclusive} inconclusive checks\nReport: ${reportPath}${replayPath ? `\nReplay: ${replayPath}` : ""}${evidence ? `\n${evidence}` : ""}`,
    );
  }
  return report.status === "passed" ? 0 : report.status === "failed" ? 1 : 2;
}

function identityWithTask(identity: Record<string, string>, task: string): void {
  if (task !== "payment-refund-17/v1") throw new Error("Replay task oracle is unavailable");
  identity.task = task;
}
function writePrivate(path: string, data: unknown): void {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
}
