import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bundleHash,
  CONFORMANCE_REPORT_FILE,
  LIVE_CONFORMANCE_REPORT_FILE,
  readBundleDir,
} from "@anvil/generators";
import type { ConformanceCheck, ConformanceReport, LiveCheck, LiveReport } from "@anvil/harness";
import type { Command } from "commander";
import type { CliIO } from "../io.js";
import { resolveBundleDir } from "./certify.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";

/**
 * `anvil conformance <dir>` — the tri-surface conformance harness. Where
 * `anvil selftest` proves the MCP surface alone, this proves the CLI, MCP, and
 * skill agree: it drives the SAME seeded input through the generated MCP tool
 * transport and the generated CLI entrypoint against the bundle's own mock,
 * asserts they produce an identical wire request and identical safety
 * behaviour, and checks the skill package documents that exact contract. The
 * report is written into the bundle as a record file (it does not change the
 * bundle's hash).
 *
 * `--live <config>` switches to the opt-in real lane: instead of the hermetic
 * mock, it probes a deployed MCP endpoint named in the config file. That lane
 * is production-safe (it lists tools and proves the confirmation gate refuses,
 * but never drives a real mutation) and config-gated — credentials come from
 * the environment, never the file.
 */
export function registerConformance(parent: Command, ctx: CommandContext): void {
  annotate(
    parent
      .command("conformance")
      .summary("Prove the CLI, MCP, and skill surfaces agree on every operation, end-to-end.")
      .description(
        "Tri-surface conformance for a generated bundle. Boots the bundle's mock upstream, then drives every approved operation through BOTH the generated MCP server (mcp/server.js, over the real MCP transport) and the generated CLI entrypoint (cli/<svc>.mjs, as a child process) against that mock. Checks: the skill, CLI catalog, and MCP tool list name the same operations with the same public handles (surface-agreement); the skill documents the exact confirmation/idempotency/retry posture the runtime enforces (skill-claim); the same input reaches the wire identically on both surfaces and matches the AIR contract (wire-agreement); and a confirmation-gated mutation refuses without --confirm, before any side effect, on both surfaces (gate-agreement). Writes conformance.report.json into the bundle. Exit 0 only when no check fails.\n\nWith --live <config.json>, probes a REAL deployed MCP endpoint instead of the mock: it verifies the deployed server serves exactly the certified surface and that its confirmation gate refuses in production, and invokes only the reads the config opts into — it never drives a real mutation. The config names the endpoint (mcpUrl) and auth headers, whose ${VAR} values resolve from the environment; the onus of correct config is on the operator. Writes conformance.live.report.json.",
      )
      .argument("<dir>", "generated bundle directory (or its air.yaml)")
      .option("--live <config>", "probe a real deployed MCP endpoint named in this JSON config")
      .option("--json", "emit the full report as JSON")
      .action(async (dir: string, opts: ConformanceCliOptions) => {
        ctx.code = await runConformanceCommand(dir, opts, ctx.io);
      }),
    { mutates: true },
  );
}

export interface ConformanceCliOptions {
  json?: boolean;
  live?: string;
}

export async function runConformanceCommand(
  path: string,
  opts: ConformanceCliOptions,
  io: CliIO,
): Promise<number> {
  const dir = resolveBundleDir(path);
  if (opts.live !== undefined) return runLiveLane(dir, opts.live, opts, io);

  const { runConformance } = await import("@anvil/harness");
  const report = await runConformance(dir, { cliPackageDir: resolveCliPackageDir() });
  const boundReport = { ...report, bundleHash: bundleHash(readBundleDir(dir)) };
  writeFileSync(
    join(dir, CONFORMANCE_REPORT_FILE),
    `${JSON.stringify(boundReport, null, 2)}\n`,
    "utf8",
  );

  if (opts.json === true) io.out(JSON.stringify(boundReport, null, 2));
  else io.out(renderConformanceSummary(report, dir));
  return report.summary.fail === 0 ? 0 : 1;
}

/** The opt-in real lane: probe a deployed MCP endpoint from an operator config. */
async function runLiveLane(
  dir: string,
  configPath: string,
  opts: ConformanceCliOptions,
  io: CliIO,
): Promise<number> {
  const { loadLiveConfig, runLiveConformance } = await import("@anvil/harness");
  const config = loadLiveConfig(configPath);
  const report = await runLiveConformance(dir, config);
  const boundReport = { ...report, bundleHash: bundleHash(readBundleDir(dir)) };
  writeFileSync(
    join(dir, LIVE_CONFORMANCE_REPORT_FILE),
    `${JSON.stringify(boundReport, null, 2)}\n`,
    "utf8",
  );

  if (opts.json === true) io.out(JSON.stringify(boundReport, null, 2));
  else io.out(renderLiveSummary(report, dir));
  return report.summary.fail === 0 ? 0 : 1;
}

/** The check-by-check summary the live lane prints. */
export function renderLiveSummary(report: LiveReport, dir: string): string {
  const lines: string[] = [`Live conformance — ${report.target}`, ""];
  for (const check of report.checks) {
    const op = check.operationId ? ` ${check.operationId}` : "";
    lines.push(`  ${liveMarker(check)} ${check.id}${op}`);
    if (check.detail) lines.push(`      ${check.detail}`);
  }
  const { pass, fail, skipped } = report.summary;
  lines.push("");
  lines.push(
    fail === 0
      ? `PASSED — ${pass} check(s) passed, ${skipped} skipped. Wrote ${join(dir, LIVE_CONFORMANCE_REPORT_FILE)}.`
      : `FAILED — ${fail} check(s) failed (${pass} passed, ${skipped} skipped). Wrote ${join(dir, LIVE_CONFORMANCE_REPORT_FILE)}.`,
  );
  return lines.join("\n");
}

function liveMarker(check: LiveCheck): string {
  if (check.status === "pass") return "✓";
  if (check.status === "fail") return "✗";
  return "–";
}

/** The check-by-check summary `anvil conformance` prints (details behind --json). */
export function renderConformanceSummary(report: ConformanceReport, dir: string): string {
  const lines: string[] = [
    `Tri-surface conformance — ${dir}`,
    `  surfaces: ${report.surfaces.join(" + ")}`,
    "",
  ];
  for (const check of report.checks) {
    const op = check.operationId ? ` ${check.operationId}` : "";
    lines.push(`  ${marker(check)} ${check.id}${op}  [${check.surfaces.join("↔")}]`);
    if (check.status !== "pass" && check.detail) lines.push(`      ${check.detail}`);
    for (const d of check.divergences ?? []) {
      lines.push(
        `      ${d.path} (${d.between.join(" vs ")}): ${JSON.stringify(d.left)} ≠ ${JSON.stringify(d.right)}`,
      );
    }
  }
  const { pass, fail, skipped } = report.summary;
  lines.push("");
  lines.push(
    fail === 0
      ? `PASSED — ${pass} check(s) passed, ${skipped} skipped. Wrote ${join(dir, CONFORMANCE_REPORT_FILE)}.`
      : `FAILED — ${fail} check(s) failed (${pass} passed, ${skipped} skipped). Wrote ${join(dir, CONFORMANCE_REPORT_FILE)}.`,
  );
  return lines.join("\n");
}

function marker(check: ConformanceCheck): string {
  if (check.status === "pass") return "✓";
  if (check.status === "fail") return "✗";
  return "–";
}

/**
 * The `@anvil/cli` package directory, so the harness can link it into the
 * bundle and spawn `node cli/<svc>.mjs`. The harness cannot depend on
 * `@anvil/cli` (it would cycle), so the CLI resolves its own root here by
 * walking up from this module to the nearest package.json named `@anvil/cli`.
 */
function resolveCliPackageDir(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const manifest = join(current, "package.json");
    if (existsSync(manifest)) {
      try {
        const name = JSON.parse(readFileSync(manifest, "utf8")).name;
        if (name === "@anvil/cli") return current;
      } catch {
        // keep walking
      }
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error("Could not locate the @anvil/cli package root from the conformance command.");
    }
    current = parent;
  }
}
