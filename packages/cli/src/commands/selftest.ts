import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { bundleHash, readBundleDir, SELFTEST_REPORT_FILE } from "@anvil/generators";
import type { LoopbackCheck, LoopbackReport } from "@anvil/harness";
import type { Command } from "commander";
import type { CliIO } from "../io.js";
import { resolveBundleDir } from "./certify.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";

/**
 * `anvil selftest <dir>` — the loopback self-test. Where `anvil certify` judges
 * the bundle's *files*, this actually executes them: it boots the bundle's
 * generated mock upstream and its generated MCP server pointed at that mock
 * (`ANVIL_BASE_URL`), drives every approved tool over the real MCP transport,
 * and verifies no losses. The report is written into the bundle as a record
 * file (like certification.json, it does not change the bundle's hash).
 */
export function registerSelftest(parent: Command, ctx: CommandContext): void {
  annotate(
    parent
      .command("selftest")
      .summary("Boot the bundle's mock + MCP servers and prove the generated surface end-to-end.")
      .description(
        "Loopback self-test for bundles with no reference server to compare against: starts the generated mock upstream (mock/server.mjs) and the generated MCP server (mcp/server.js) pointed at it via ANVIL_BASE_URL, then invokes every approved tool over the real MCP transport. Checks: the tool surface equals the approved operations (surface), every argument reaches the wire faithfully and the response round-trips (fidelity), confirmation gates refuse before any side effect (confirmation-gate), documented upstream errors surface as structured envelopes (error-mapping), and non-idempotent mutations are never auto-retried (retry checks). Writes selftest.report.json into the bundle. Exit 0 only when no check fails.",
      )
      .argument("<dir>", "generated bundle directory (or its air.yaml)")
      .option("--json", "emit the full report as JSON")
      .action(async (dir: string, opts: SelftestOptions) => {
        ctx.code = await runSelftest(dir, opts, ctx.io);
      }),
    { mutates: true },
  );
}

export interface SelftestOptions {
  json?: boolean;
}

export async function runSelftest(path: string, opts: SelftestOptions, io: CliIO): Promise<number> {
  const dir = resolveBundleDir(path);
  const { runLoopback } = await import("@anvil/harness");
  const report = await runLoopback(dir);
  const boundReport = { ...report, bundleHash: bundleHash(readBundleDir(dir)) };
  writeFileSync(
    join(dir, SELFTEST_REPORT_FILE),
    `${JSON.stringify(boundReport, null, 2)}\n`,
    "utf8",
  );

  if (opts.json === true) io.out(JSON.stringify(boundReport, null, 2));
  else io.out(renderLoopbackSummary(report, dir));
  return report.summary.fail === 0 ? 0 : 1;
}

/** The check-by-check summary `anvil selftest` prints (details behind --json). */
export function renderLoopbackSummary(report: LoopbackReport, dir: string): string {
  const lines: string[] = [`Loopback self-test — ${dir}`];
  if (report.identity.delegatedOperations > 0) {
    lines.push(
      `  identity: ${report.identity.proof}=${report.identity.virtualWiring}; live IdP readiness=UNVERIFIED`,
      "",
    );
  }
  for (const check of report.checks) {
    lines.push(`  ${marker(check)} ${check.id}${check.operationId ? ` ${check.operationId}` : ""}`);
    if (check.status !== "pass" && check.detail) lines.push(`      ${check.detail}`);
    for (const loss of check.losses ?? []) {
      lines.push(
        `      loss at ${loss.path}: sent ${JSON.stringify(loss.sent)}, received ${JSON.stringify(loss.received)}`,
      );
    }
  }
  const { pass, fail, skipped } = report.summary;
  lines.push("");
  lines.push(
    fail === 0
      ? `PASSED — ${pass} check(s) passed, ${skipped} skipped. Wrote ${join(dir, "selftest.report.json")}.`
      : `FAILED — ${fail} check(s) failed (${pass} passed, ${skipped} skipped). Wrote ${join(dir, "selftest.report.json")}.`,
  );
  return lines.join("\n");
}

function marker(check: LoopbackCheck): string {
  if (check.status === "pass") return "✓";
  if (check.status === "fail") return "✗";
  return "–";
}
