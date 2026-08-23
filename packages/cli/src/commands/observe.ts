import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { OBSERVE_REPORT_FILE, ObserveConfig, type ObserveReport, runObserve } from "@anvil/harness";
import type { Command } from "commander";
import { stringify as stringifyYaml } from "yaml";
import { emitRefusal } from "../envelope.js";
import type { CliIO } from "../io.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";

/**
 * `anvil observe <dir> --config <file>` — the only lane that meets the running
 * application.
 *
 * `selftest`, `conformance`, and `simulate` prove the bundle is faithful to
 * AIR. None of them can prove AIR is faithful to the system, because none of
 * them ever talk to it. This one does: it asks the application for its own
 * contract and diffs it, then drives the operator's opt-in reads against it and
 * compares what came back to what AIR claims. Reads only, opt-in only, and the
 * output is a proposal — nothing here edits AIR.
 */
export function registerObserve(parent: Command, ctx: CommandContext): void {
  annotate(
    parent
      .command("observe")
      .summary("Compare a bundle against the running application it was compiled from.")
      .description(
        "Two passes, both propose-only. CONTRACT DRIFT: fetches the contract the application publishes about itself (springdoc /v3/api-docs, Swashbuckle /swagger/v1/swagger.json, a WSDL) and diffs it against the bundle's AIR through the same differ `anvil drift` uses — the app is the authority on its own shape. IMPLEMENTATION DRIFT: drives the operator's opt-in READS against the real application through the bundle's own generated MCP server, so the exact executor path the CLI, MCP server, and SDKs share is what gets exercised, then reports what the app returned against what AIR declares. A mutation is never invoked, whatever the config lists. Findings become an Anvil manifest proposal weighed by the same asymmetric-trust reconciler `anvil enrich` uses: observed traffic may tighten freely, and the one claim a read genuinely earns is that an operation the contract declares is not there. Review the proposal, then `anvil compile --manifest`. Writes observe.report.json.",
      )
      .argument("<dir>", "generated bundle directory")
      .requiredOption("--config <file>", "JSON config naming the running application")
      .option("--write <manifest>", "write the proposed manifest here instead of printing it")
      .option(
        "--capture <file>",
        "save the contract the application served, to re-capture with `anvil source add`",
      )
      .option("--json", "emit the full report as JSON")
      .action(async (dir: string, opts: ObserveOptions) => {
        ctx.code = await runObserveCommand(dir, opts, ctx.io);
      }),
    { mutates: false },
  );
}

interface ObserveOptions {
  config: string;
  write?: string;
  capture?: string;
  json?: boolean;
}

async function runObserveCommand(dir: string, opts: ObserveOptions, io: CliIO): Promise<number> {
  const bundle = resolve(dir);
  if (!existsSync(join(bundle, "air.json"))) {
    return emitRefusal(io, opts.json, {
      reportType: "anvil.observe-error",
      code: "observe_bundle_missing",
      message: `No generated bundle at ${bundle}: air.json is not there. Compile first.`,
    });
  }
  let config: ObserveConfig;
  try {
    config = ObserveConfig.parse(JSON.parse(readFileSync(resolve(opts.config), "utf8")));
  } catch (error) {
    return emitRefusal(io, opts.json, {
      reportType: "anvil.observe-error",
      code: "observe_config_invalid",
      message: `Could not read --config ${opts.config}: ${error instanceof Error ? error.message : "unreadable"}.`,
    });
  }

  let report: ObserveReport;
  let captured = false;
  try {
    report = await runObserve(bundle, config, {
      // Writing the served bytes is the operator's deliberate act, not a hidden
      // second ingestion path: Layer 0 still only ever reads local files.
      ...(opts.capture !== undefined
        ? {
            onContract: ({ text }: { text: string }) => {
              writeFileSync(resolve(opts.capture as string), text, "utf8");
              captured = true;
            },
          }
        : {}),
    });
  } catch (error) {
    return emitRefusal(io, opts.json, {
      reportType: "anvil.observe-error",
      code: "observe_failed",
      message: `The observation could not run: ${error instanceof Error ? error.message : "unknown error"}.`,
    });
  }

  writeFileSync(join(bundle, OBSERVE_REPORT_FILE), `${JSON.stringify(report, null, 2)}\n`, "utf8");

  if (captured) {
    io.out(
      `Saved the application's own contract to ${opts.capture} (sha256 ${report.contract.sha256?.slice(0, 12)}…). ` +
        "Re-capture it with `anvil source add` to recompile against what the app actually publishes.",
    );
  }

  if (opts.write !== undefined && report.proposal !== undefined) {
    writeFileSync(resolve(opts.write), proposalYaml(report), "utf8");
  }

  if (opts.json === true) {
    io.out(JSON.stringify({ reportType: "anvil.observe-report", ...report }, null, 2));
    return report.ok ? 0 : 1;
  }

  render(report, opts, io);
  return report.ok ? 0 : 1;
}

/**
 * The proposal as an operator would paste it. Only the sections this lane can
 * actually populate — the manifest's other records default to empty, and
 * printing them is scaffolding a reader has to delete before using the output.
 */
function proposalYaml(report: ObserveReport): string {
  return stringifyYaml({ operations: report.proposal?.operations ?? {} });
}

function render(report: ObserveReport, opts: ObserveOptions, io: CliIO): void {
  io.out(`${report.service} observed against ${report.target}`);
  io.out("");
  io.out(
    report.contract.attempted
      ? `Contract: ${report.contract.ok ? "" : "NOT READ — "}${report.contract.detail}`
      : `Contract: ${report.contract.detail}`,
  );
  if (report.drift.length > 0) {
    io.out(`  ${report.drift.length} difference(s) between the app's contract and this bundle:`);
    for (const item of report.drift.slice(0, 12)) {
      io.out(`  - [${item.severity}] ${item.kind} ${item.operationId}: ${item.message}`);
    }
    if (report.drift.length > 12)
      io.out(`  … and ${report.drift.length - 12} more (see the report).`);
  }

  io.out("");
  if (report.observations.length === 0) {
    io.out("No operations were probed. Add operation ids to `probeReads` to exercise real reads.");
  }
  for (const observation of report.observations) {
    io.out(`${observation.operationId} — ${observation.outcome}`);
    io.out(`  ${observation.detail}`);
    if (observation.undeclaredFields.length > 0) {
      io.out(`  undeclared in the contract: ${observation.undeclaredFields.join(", ")}`);
    }
    if (observation.absentFields.length > 0) {
      io.out(`  declared but not returned: ${observation.absentFields.join(", ")}`);
    }
  }

  io.out("");
  if (report.proposal === undefined) {
    io.out(
      "No manifest change is proposed — a read proves an endpoint exists, not that a write is safe.",
    );
  } else if (opts.write !== undefined) {
    io.out(
      `Proposed manifest written to ${opts.write}. Review it, then \`anvil compile --manifest\`.`,
    );
  } else {
    io.out("Proposed manifest (review, then `anvil compile --manifest`):");
    io.out(proposalYaml(report).trimEnd());
  }
  for (const decision of report.decisions) {
    io.out(`  ${decision.accepted ? "accepted" : "rejected"}: ${decision.reason}`);
  }

  io.out("");
  io.out(
    report.ok
      ? `OK — ${report.summary.probed} operation(s) probed, ${report.summary.contractGaps} with a contract gap.`
      : `FAILED — ${report.summary.unreachable} operation(s) the contract declares are not served, and ${report.summary.driftItems} contract difference(s) were found.`,
  );
}
