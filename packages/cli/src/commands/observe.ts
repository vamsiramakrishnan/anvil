import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadAirDocument } from "@anvil/air";
import {
  OBSERVE_REPORT_FILE,
  ObserveConfig,
  type ObserveReport,
  runObserve,
  runRecords,
  TRAFFIC_REPORT_FILE,
  type TrafficReport,
} from "@anvil/harness";
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
        "Two passes, both propose-only. CONTRACT DRIFT: fetches the contract the application publishes about itself (springdoc /v3/api-docs, Swashbuckle /swagger/v1/swagger.json, a WSDL) and diffs it against the bundle's AIR through the same differ `anvil drift` uses — the app is the authority on its own shape. IMPLEMENTATION DRIFT: drives the operator's opt-in READS against the real application through the bundle's own generated MCP server, so the exact executor path the CLI, MCP server, and SDKs share is what gets exercised, then reports what the app returned against what AIR declares. A mutation is never invoked, whatever the config lists. Findings become an Anvil manifest proposal weighed by the same asymmetric-trust reconciler `anvil enrich` uses: observed traffic may tighten freely, and the one claim a read genuinely earns is that an operation the contract declares is not there. Review the proposal, then `anvil compile --manifest`. Writes observe.report.json. RECORDED TRAFFIC (--from-records <dir>): instead of probing live, folds the execution-record spool a deployed server wrote (set ANVIL_RECORDS_DIR on the generated MCP/HTTP server; records carry outcomes, error codes, retry and ledger behaviour — no secrets, no payloads) into recorded_traffic evidence through the same reconciler. Traffic corroborates freely; the one patch it earns is deprecation, when every one of enough calls answered not_found. Writes traffic.report.json.",
      )
      .argument("<dir>", "generated bundle directory")
      .option("--config <file>", "JSON config naming the running application")
      .option(
        "--from-records <dir>",
        "fold a serving-path record spool (ANVIL_RECORDS_DIR) into evidence instead of probing live",
      )
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
  config?: string;
  fromRecords?: string;
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
  // Two ways to meet reality, one at a time: probe the running application
  // (--config) or fold its spooled traffic back into evidence (--from-records).
  if (opts.fromRecords !== undefined && opts.config !== undefined) {
    return emitRefusal(io, opts.json, {
      reportType: "anvil.observe-error",
      code: "observe_mode_ambiguous",
      message:
        "Pass either --config (probe the live application) or --from-records (read a spool), not both.",
    });
  }
  if (opts.fromRecords !== undefined) {
    return runFromRecords(bundle, opts.fromRecords, opts, io);
  }
  if (opts.config === undefined) {
    return emitRefusal(io, opts.json, {
      reportType: "anvil.observe-error",
      code: "observe_mode_missing",
      message:
        "Pass --config to probe the running application, or --from-records to fold a record spool into evidence.",
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

function runFromRecords(bundle: string, spoolDir: string, opts: ObserveOptions, io: CliIO): number {
  const dir = resolve(spoolDir);
  if (!existsSync(dir)) {
    return emitRefusal(io, opts.json, {
      reportType: "anvil.observe-error",
      code: "observe_records_missing",
      message: `No record spool at ${dir}. Point --from-records at the directory ANVIL_RECORDS_DIR wrote to.`,
    });
  }
  const air = loadAirDocument(JSON.parse(readFileSync(join(bundle, "air.json"), "utf8")));
  const report = runRecords({ air, dir });
  writeFileSync(join(bundle, TRAFFIC_REPORT_FILE), `${JSON.stringify(report, null, 2)}\n`, "utf8");

  if (opts.write !== undefined && report.proposal !== undefined) {
    writeFileSync(
      resolve(opts.write),
      stringifyYaml({ operations: report.proposal.operations }),
      "utf8",
    );
  }
  if (opts.json === true) {
    io.out(JSON.stringify({ reportType: "anvil.traffic-report", ...report }, null, 2));
    return report.ok ? 0 : 1;
  }
  renderTraffic(report, opts, io);
  return report.ok ? 0 : 1;
}

function renderTraffic(report: TrafficReport, opts: ObserveOptions, io: CliIO): void {
  io.out(`${report.service} — recorded traffic from ${report.source}`);
  io.out("");
  for (const s of report.traffic) {
    const codes = Object.entries(s.errorCodes)
      .map(([code, n]) => `${code}×${n}`)
      .join(", ");
    io.out(
      `  ${s.operationId}: ${s.calls} call(s), ${s.successes} ok, ${s.errors} error(s)` +
        `${codes ? ` (${codes})` : ""}, ${s.replays} replay(s), ${s.retriedSuccesses} retried-ok`,
    );
  }
  if (report.unobserved.length > 0) {
    io.out(`  Approved but never observed: ${report.unobserved.join(", ")}`);
  }
  if (report.unknownOperationIds.length > 0) {
    io.out(`  In traffic but not in this AIR: ${report.unknownOperationIds.join(", ")}`);
  }
  io.out("");
  if (report.proposal) {
    const ids = Object.keys(report.proposal.operations);
    io.out(`Proposal: ${ids.length} operation patch(es) — ${ids.join(", ")}.`);
    if (opts.write === undefined) {
      io.out("Re-run with --write <manifest> to save it, review, then `anvil compile --manifest`.");
    }
  } else {
    io.out("No patch proposed: traffic corroborates the model as compiled.");
  }
  io.out(report.detail);
  io.out(`Wrote ${TRAFFIC_REPORT_FILE}.`);
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
