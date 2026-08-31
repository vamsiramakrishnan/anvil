import { existsSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { AirDocument, Capability, Diagnostic } from "@anvil/air";
import { evidenceConfidence } from "@anvil/air";
import {
  approveCapability,
  type CapabilityBudgetCheck,
  CapabilityReviewError,
  capabilityDisclosureBudget,
  diffCapability,
  proposeCapabilities,
  rejectCapability,
} from "@anvil/compiler";
import { runTraceCapabilities, type TraceCapabilityReport } from "@anvil/harness";
import { type Command, Option } from "commander";
import { emitRefusal } from "../../envelope.js";
import type { CliIO } from "../../io.js";
import { reportPreservedStaleArtifacts, reprojectBundleAtomically } from "../approve.js";
import type { CommandContext } from "../context.js";
import { annotate } from "../meta.js";
import { loadAir, resolveAirPath } from "../shared.js";
import { registerCapabilityCompose } from "./capability-compose.js";

/**
 * `anvil capability <subcommand>` — the capability review lifecycle. Discovery
 * proposes groupings; a reviewer approves or rejects them here, and only an
 * approved capability can be compiled into a bundle (`anvil build`).
 *
 * Progressive disclosure: every default output is a small summary; detail
 * sections appear only when asked for (--operations/--auth/--evidence/--json).
 * `propose`, `list`, `show`, and `diff` are read-only; `approve` and `reject`
 * persist the decision to the AIR file — the same pattern as `anvil approve`.
 */
export function registerCapability(parent: Command, ctx: CommandContext): void {
  const capability = annotate(
    parent
      .command("capability")
      .summary("Review capability groupings: propose, inspect, approve, reject, or diff.")
      .description(
        "The capability review lifecycle. `propose` re-runs discovery and prints each grouping with its provenance and tool-budget verdict (read-only); `list` and `show` inspect stored capabilities (small summaries by default; add --operations/--auth/--evidence/--json for detail); `diff` reports drift between a stored capability and fresh discovery. " +
          "`approve`/`reject` persist the review decision to the AIR file. Approval enforces the effective disclosure budget — the surface actually served: direct members plus authored workflow dependencies, minus operations an approved workflow supersedes, plus one tool per approved workflow. More than 20 tools is blocked without --allow-large and an audit note; more than 15 warns. Composing a workflow that supersedes its own steps therefore LOWERS what a capability spends. Only an approved capability can be built with `anvil build`.",
      ),
    { mutates: true },
  );

  capability
    .command("propose")
    .summary("(Re)run discovery; print proposals with provenance and budget findings.")
    .description(
      "Two grounds for a grouping, one at a time. By default this re-runs spec discovery: groupings come from OpenAPI tags and the resource heuristic — a vendor's REFERENCE taxonomy, organised by resource, which real tasks routinely cut across. " +
        "OBSERVED TRAFFIC (--from-records <dir>): instead reads the execution-record spool a deployed server wrote (set ANVIL_RECORDS_DIR on the generated MCP/HTTP server) and groups operations that were used inside the same traceId — a task observed rather than guessed, carried as recorded_traffic evidence stating the trace count rather than a confidence nobody could defend. An operation appearing in nearly every distinct trace shape (auth, health check, token refresh) co-occurs with everything, so it is filtered out statistically before any grouping is formed and named in the report; a shape seen fewer than 5 times is an anecdote and is not proposed. Each grouping carries a ready-to-review manifest snippet (manifestSnippet in the report; --snippet <grouping-id> prints one) — copy it into the estate's anvil.yaml `capabilities:` section to author the grouping as a manifest-sourced capability, then recompile and review it through the ordinary approve gate. Read-only and propose-only: it never writes AIR, a manifest, an approval, or a build, and --out must be outside the bundle.",
    )
    .argument("<path>", "generated bundle directory or air.yaml")
    .option(
      "--from-records <dir>",
      "group by co-occurrence in a serving-path record spool (ANVIL_RECORDS_DIR) instead of by spec",
    )
    .option("--out <file>", "write the observed-capability report here (--from-records only)")
    .addOption(
      new Option(
        "--snippet <grouping-id>",
        "print the chosen grouping's ready-to-review manifest snippet, verbatim (--from-records only)",
      ).conflicts(["json"]),
    )
    .option("--json", "emit the proposals as JSON")
    .action((path: string, opts: ProposeOptions) => {
      ctx.code = runPropose(path, opts, ctx.io);
    });

  capability
    .command("list")
    .summary("List the stored capabilities and their review lifecycle.")
    .argument("<path>", "generated bundle directory or air.yaml")
    .action((path: string) => {
      ctx.code = runList(path, ctx.io);
    });

  capability
    .command("show")
    .summary("Show one capability: small summary by default, sections on request.")
    .argument("<path>", "generated bundle directory or air.yaml")
    .argument("<capability-id>", "the capability to show")
    .option("--operations", "list the member operations")
    .option("--auth", "summarize the members' auth requirements")
    .option("--evidence", "list the evidence claims")
    // --json emits everything at once; the section flags shape the human view.
    // Mixing them is a contradiction, not a preference — refuse it.
    .addOption(
      new Option("--json", "emit the capability and its budget check as JSON").conflicts([
        "operations",
        "auth",
        "evidence",
      ]),
    )
    .action((path: string, id: string, opts: ShowOptions) => {
      ctx.code = runShow(path, id, opts, ctx.io);
    });

  capability
    .command("approve")
    .summary("Record the approval decision; the tool budget gates it.")
    .argument("<path>", "generated bundle directory or air.yaml")
    .argument("<capability-id>", "the capability to approve")
    .option("--allow-large", "waive the >20-tool budget block (requires a non-empty --note)")
    .option("--note <note>", "review note persisted with the decision")
    .action((path: string, id: string, opts: { allowLarge?: boolean; note?: string }) => {
      ctx.code = runApprove(path, id, opts, ctx.io);
    });

  capability
    .command("reject")
    .summary("Record why the grouping is not the right unit.")
    .argument("<path>", "generated bundle directory or air.yaml")
    .argument("<capability-id>", "the capability to reject")
    .option("--reason <reason>", "rejection reason persisted with the decision")
    .action((path: string, id: string, opts: { reason?: string }) => {
      ctx.code = runReject(path, id, opts, ctx.io);
    });

  capability
    .command("diff")
    .summary("Report drift between a stored capability and fresh discovery.")
    .argument("<path>", "generated bundle directory or air.yaml")
    .argument("<capability-id>", "the capability to diff")
    .action((path: string, id: string) => {
      ctx.code = runDiff(path, id, ctx.io);
    });

  registerCapabilityCompose(capability, ctx);
}

interface ShowOptions {
  operations?: boolean;
  auth?: boolean;
  evidence?: boolean;
  json?: boolean;
}

interface ProposeOptions {
  fromRecords?: string;
  out?: string;
  snippet?: string;
  json?: boolean;
}

const PROPOSE_ERROR = "anvil.capability-propose-error";

/** `anvil capability propose` — (re)run discovery; print proposals + budget findings. */
function runPropose(path: string, opts: ProposeOptions, io: CliIO): number {
  if (opts.fromRecords !== undefined) return runProposeFromRecords(path, opts, io);
  if (opts.out !== undefined) {
    return emitRefusal(io, opts.json, {
      reportType: PROPOSE_ERROR,
      code: "capability_propose_out_without_records",
      message:
        "--out writes the observed-capability report and is meaningful only with --from-records. " +
        "Spec discovery's groupings are already stored in AIR; read them with `anvil capability list`.",
    });
  }
  if (opts.snippet !== undefined) {
    return emitRefusal(io, opts.json, {
      reportType: PROPOSE_ERROR,
      code: "capability_propose_snippet_without_records",
      message:
        "--snippet prints an observed grouping's manifest authoring snippet and is meaningful " +
        "only with --from-records. Spec discovery's groupings are already stored in AIR and " +
        "need no authoring entry.",
    });
  }

  const air = loadAir(path);
  const proposals = proposeCapabilities(air);
  if (opts.json === true) {
    io.out(
      JSON.stringify(
        {
          schemaVersion: 1,
          reportType: "anvil.capability-proposals",
          service: air.service.id,
          version: air.service.version,
          basis: "spec_discovery",
          proposals,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  if (proposals.length === 0) {
    io.out("No capabilities discovered — the document has no operations to group.");
    return 0;
  }
  io.out(
    `Capability proposals for ${air.service.id} @ ${air.service.version} — ${proposals.length} grouping(s):`,
  );
  for (const p of proposals) {
    const claim = p.capability.evidence.claims.find((c) => c.predicate === "grouping");
    const provenance = claim
      ? `${claim.note ?? `grouped by ${p.capability.source}`} (confidence ${claim.confidence.toFixed(2)})`
      : `grouped by ${p.capability.source}`;
    const marks = [p.isNew ? "new" : undefined, p.capability.lifecycle].filter(Boolean).join(", ");
    io.out(
      `  ${p.capability.id.padEnd(28)} ${String(p.budget.toolCount).padStart(3)} tool(s)  [${marks}]`,
    );
    io.out(`    ${provenance}`);
    if (p.budget.diagnostic) io.out(`    ${formatDiagnostic(p.budget.diagnostic)}`);
  }
  io.out(
    "\nRead-only. Review with `anvil capability show`, then `anvil capability approve|reject`.",
  );
  return 0;
}

/**
 * `anvil capability propose --from-records` — group by observed co-occurrence.
 *
 * The spec-discovery mode above answers "what does the vendor's documentation
 * say these operations are about". This one answers "what were they actually
 * used together to do", which is the question routing accuracy turns on. Both
 * stop in the same place: a grouping a human reviews.
 */
function runProposeFromRecords(path: string, opts: ProposeOptions, io: CliIO): number {
  const spool = resolve(opts.fromRecords as string);
  if (!existsSync(spool) || !statSync(spool).isDirectory()) {
    return emitRefusal(io, opts.json, {
      reportType: PROPOSE_ERROR,
      code: "capability_propose_records_missing",
      message: `No record spool directory at ${spool}. Point --from-records at the directory ANVIL_RECORDS_DIR wrote to.`,
    });
  }

  let air: AirDocument;
  let bundleDir: string;
  try {
    // The bundle is whatever directory holds the AIR file, whether the operator
    // named the directory or the file inside it.
    bundleDir = resolve(resolveAirPath(path), "..");
    air = loadAir(path);
  } catch (error) {
    return emitRefusal(io, opts.json, {
      reportType: PROPOSE_ERROR,
      code: "capability_propose_air_unreadable",
      message: `Cannot read AIR at '${path}': ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  // A report written inside the bundle would join the bytes that define the
  // bundle's identity hash unless it were registered in DERIVED_RECORD_FILES,
  // silently staling every other lane's hash-bound evidence. That bug has
  // shipped here twice. Refusing the path is the version of the fix that cannot
  // rot: this lane owns no bundle byte at all.
  const out = opts.out === undefined ? undefined : resolve(opts.out);
  if (out !== undefined && within(bundleDir, out)) {
    return emitRefusal(io, opts.json, {
      reportType: PROPOSE_ERROR,
      code: "capability_propose_out_inside_bundle",
      message: `--out '${out}' is inside the bundle '${bundleDir}'. Observation evidence must not contaminate compiler-owned bundle bytes; write it outside.`,
    });
  }

  const report = runTraceCapabilities({ air, dir: spool });
  if (out !== undefined) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  // The copy-paste half of the propose→author bridge: print ONE grouping's
  // authoring snippet, verbatim, and nothing else on stdout — so
  // `anvil capability propose … --snippet observed.xxx >> anvil.yaml` pastes
  // cleanly. Still propose-only: the operator places, reads, and compiles it.
  if (opts.snippet !== undefined) {
    const grouping = report.groupings.find((candidate) => candidate.id === opts.snippet);
    if (!grouping) {
      return emitRefusal(io, opts.json, {
        reportType: PROPOSE_ERROR,
        code: "capability_propose_snippet_unknown_grouping",
        message:
          `No observed grouping '${opts.snippet}' in this spool. ` +
          `Groupings: ${report.groupings.map((candidate) => candidate.id).join(", ") || "(none)"}.`,
      });
    }
    io.out(grouping.manifestSnippet);
    return 0;
  }

  if (opts.json === true) {
    io.out(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  }
  renderObserved(report, out, io);
  return report.ok ? 0 : 1;
}

function renderObserved(report: TraceCapabilityReport, out: string | undefined, io: CliIO): void {
  io.out(`${report.service} — capability groupings observed in traffic from ${report.source}`);
  io.out(
    `  ${report.summary.traces} trace(s), ${report.summary.traceShapes} distinct shape(s), ` +
      `${report.summary.operationsObserved} operation(s) observed.`,
  );
  io.out("");

  if (report.suppressedUbiquitousOperations.length > 0) {
    io.out("Filtered before grouping — present in nearly every trace shape, so they carry no");
    io.out("information about which task is underway:");
    for (const s of report.suppressedUbiquitousOperations) {
      io.out(
        `  ${s.operationId.padEnd(40)} ${s.shapes} shape(s) (${(s.shapeFraction * 100).toFixed(0)}%), ${s.traces} trace(s)`,
      );
    }
    io.out("");
  }

  if (report.groupings.length === 0) {
    io.out(
      `No grouping reached ${report.summary.minTracesForGrouping} trace(s). A shape seen fewer ` +
        "times is an anecdote, not evidence.",
    );
  } else {
    io.out(`${report.groupings.length} observed grouping(s):`);
    for (const g of report.groupings) {
      io.out(`  ${g.id}  ${g.traces} trace(s), ${g.operationIds.length} operation(s)`);
      io.out(`    ${g.dominantOrder.join(" -> ")}`);
      io.out(
        `    order: ${g.dominantOrderTraces}/${g.traces} trace(s) in this order, ` +
          `${g.distinctOrders} distinct order(s)`,
      );
      io.out(
        g.crossesExistingCapabilities
          ? `    CUTS ACROSS ${g.spansCapabilities.length} existing capability(ies): ${g.spansCapabilities.join(", ")}`
          : `    within ${g.spansCapabilities.join(", ") || "no stored capability"}`,
      );
    }
  }

  io.out("");
  if (report.groupings.length > 0) {
    io.out(
      "To adopt a grouping: `--snippet <grouping-id>` prints its ready-to-review manifest " +
        "snippet (also in the report as manifestSnippet). Copy it into the estate's anvil.yaml " +
        "`capabilities:` section, review the members, and recompile.",
    );
  }
  if (report.unknownOperationIds.length > 0) {
    io.out(`In traffic but not in this AIR (ignored): ${report.unknownOperationIds.join(", ")}`);
  }
  io.out(`Propose-only: ${report.boundary.reason}`);
  io.out(`Next: ${report.boundary.nextGate}`);
  if (out !== undefined) io.out(`Wrote ${out}.`);
  io.out(report.detail);
}

/** True when `candidate` is `root` or lives beneath it. */
function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** `anvil capability list` — the stored capabilities and their review lifecycle. */
function runList(path: string, io: CliIO): number {
  const air = loadAir(path);
  if (air.capabilities.length === 0) {
    io.out("No capabilities stored. Run `anvil compile` (discovery) first.");
    return 0;
  }
  io.out(
    `${air.service.id} @ ${air.service.version} — ${air.capabilities.length} capability(ies):`,
  );
  for (const cap of air.capabilities) {
    const budget = capabilityDisclosureBudget(air, cap.id);
    const flag = budget.verdict === "ok" ? "" : `  [${budget.verdict}: ${budget.toolCount} tools]`;
    io.out(
      `  ${cap.id.padEnd(28)} ${cap.lifecycle.padEnd(10)} ${String(cap.operationIds.length).padStart(3)} op(s)  ${cap.source}${flag}`,
    );
  }
  return 0;
}

/** `anvil capability show` — small summary; sections only on request. */
function runShow(path: string, id: string, opts: ShowOptions, io: CliIO): number {
  const air = loadAir(path);
  const cap = air.capabilities.find((c) => c.id === id);
  if (!cap) {
    io.err(`No capability '${id}'. Run \`anvil capability list ${path}\`.`);
    return 1;
  }
  const budget = capabilityDisclosureBudget(air, cap.id);
  if (opts.json === true) {
    io.out(JSON.stringify({ capability: cap, budget }, null, 2));
    return 0;
  }

  io.out(`${cap.id} — ${cap.displayName}`);
  io.out(`  lifecycle: ${cap.lifecycle}   state(derived): ${cap.state}   source: ${cap.source}`);
  io.out(
    `  operations: ${cap.operationIds.length}   workflows: ${cap.workflowIds.length}   resources: ${cap.resources.join(", ") || "—"}`,
  );
  io.out(`  budget: ${budgetLine(budget)}`);
  io.out(`  evidence confidence: ${evidenceConfidence(cap.evidence).toFixed(2)}`);
  if (cap.reviewNote) io.out(`  note: ${cap.reviewNote}`);

  if (opts.operations === true) {
    io.out("\nOperations:");
    for (const opId of cap.operationIds) {
      const op = air.operations.find((o) => o.id === opId);
      if (!op) {
        io.out(`  ${opId.padEnd(36)} (missing from document)`);
        continue;
      }
      const effect = op.effect.kind === "mutation" ? `mutation/${op.effect.risk}` : "read";
      io.out(`  ${op.id.padEnd(36)} ${effect.padEnd(18)} ${op.state}`);
    }
  }
  if (opts.auth === true) {
    io.out("\nAuth:");
    for (const line of authSummary(air, cap)) io.out(`  ${line}`);
  }
  if (opts.evidence === true) {
    io.out("\nEvidence:");
    for (const claim of cap.evidence.claims) {
      io.out(
        `  ${claim.predicate} = ${JSON.stringify(claim.value)} (${claim.source}, ${claim.confidence.toFixed(2)})${claim.note ? ` — ${claim.note}` : ""}`,
      );
    }
    if (cap.evidence.claims.length === 0) io.out("  (no claims)");
  }
  if (opts.operations !== true && opts.auth !== true && opts.evidence !== true) {
    io.out("\nSections: --operations --auth --evidence --json");
  }
  return 0;
}

/** `anvil capability approve` — record the decision; the tool budget gates it. */
function runApprove(
  path: string,
  id: string,
  opts: { allowLarge?: boolean; note?: string },
  io: CliIO,
): number {
  const air = loadAir(path);
  let budget: CapabilityBudgetCheck;
  try {
    budget = approveCapability(air, id, {
      allowLarge: opts.allowLarge === true,
      note: opts.note,
    });
  } catch (err) {
    if (err instanceof CapabilityReviewError) {
      if (err.diagnostic) io.err(formatDiagnostic(err.diagnostic));
      else io.err(`error ${err.code}: ${err.message}`);
      return 1;
    }
    throw err;
  }
  if (budget.diagnostic) io.out(formatDiagnostic(budget.diagnostic));
  const result = reprojectBundleAtomically(path, air);
  io.out(
    `Approved capability '${id}' (${budget.toolCount} tool(s)) and atomically regenerated ${result.generatedFileCount} bundle files in ${result.bundleDir}.`,
  );
  reportPreservedStaleArtifacts(
    io,
    result.existingFiles,
    result.projectionsChanged,
    result.bundleDir,
  );
  if (result.retainedBackup) {
    io.out(
      `  The replaced bundle backup could not be removed; it remains at ${result.retainedBackup}.`,
    );
  }
  io.out(`Build it with \`anvil build ${path} ${id}\`.`);
  return 0;
}

/** `anvil capability reject` — record why the grouping is not the right unit. */
function runReject(path: string, id: string, opts: { reason?: string }, io: CliIO): number {
  const air = loadAir(path);
  try {
    rejectCapability(air, id, opts.reason);
  } catch (err) {
    if (err instanceof CapabilityReviewError) {
      io.err(`error ${err.code}: ${err.message}`);
      return 1;
    }
    throw err;
  }
  const result = reprojectBundleAtomically(path, air);
  io.out(
    `Rejected capability '${id}' and atomically regenerated ${result.generatedFileCount} bundle files in ${result.bundleDir}.`,
  );
  reportPreservedStaleArtifacts(
    io,
    result.existingFiles,
    result.projectionsChanged,
    result.bundleDir,
  );
  if (result.retainedBackup) {
    io.out(
      `  The replaced bundle backup could not be removed; it remains at ${result.retainedBackup}.`,
    );
  }
  return 0;
}

/** `anvil capability diff` — stored capability vs a fresh re-discovery. */
function runDiff(path: string, id: string, io: CliIO): number {
  const air = loadAir(path);
  let diff: ReturnType<typeof diffCapability>;
  try {
    diff = diffCapability(air, id);
  } catch (err) {
    if (err instanceof CapabilityReviewError) {
      io.err(`error ${err.code}: ${err.message}`);
      return 1;
    }
    throw err;
  }
  // A manifest-authored capability has no discovery counterpart BY DEFINITION,
  // so it is never compared against rediscovery — its drift check is whether
  // the declared members still exist in the document. Saying so out loud is
  // the point: silence here would read as "discovery agrees", which it cannot.
  if (diff.authored) {
    if (diff.unchanged) {
      io.out(
        `No drift. '${id}' is manifest-authored (not expected in discovery); ` +
          "every declared member operation is still in the document.",
      );
      return 0;
    }
    io.out(`Capability '${id}' is manifest-authored (not expected in discovery), and has drifted:`);
    for (const op of diff.removedOperations)
      io.out(`  - operation ${op} no longer in the document`);
    io.out("\nRe-review before building: the authored grouping names operations that are gone.");
    return 0;
  }
  if (diff.unchanged) {
    io.out(`No drift. '${id}' matches what discovery proposes today.`);
    return 0;
  }
  io.out(`Capability '${id}' has drifted from fresh discovery:`);
  if (!diff.present) io.out("  ! discovery no longer proposes this grouping at all");
  for (const op of diff.addedOperations) io.out(`  + operation ${op}`);
  for (const op of diff.removedOperations) io.out(`  - operation ${op}`);
  if (diff.sourceChanged)
    io.out(`  ~ source ${diff.sourceChanged.from} → ${diff.sourceChanged.to}`);
  for (const r of diff.addedResources) io.out(`  + resource ${r}`);
  for (const r of diff.removedResources) io.out(`  - resource ${r}`);
  io.out("\nRe-review before building: the approved grouping is not what exists now.");
  return 0;
}

/* --------------------------------- helpers -------------------------------- */

/**
 * One-line rendering of the tool-budget verdict for the summary view. Names what
 * composition took off the count, because a number that dropped for a reason the
 * operator cannot see reads as a bug in the budget rather than a win.
 */
function budgetLine(budget: CapabilityBudgetCheck): string {
  const composed = budget.supersededOperations
    ? `, ${budget.supersededOperations} superseded by workflow`
    : "";
  if (budget.verdict === "ok")
    return `ok (${budget.toolCount} tool(s)${composed}; default disclosure is 5–15)`;
  return `${budget.verdict}${composed} — ${budget.diagnostic?.message ?? ""}`;
}

/** Render a typed diagnostic the same way `anvil lint` does. */
function formatDiagnostic(d: Diagnostic): string {
  return `${d.level.toUpperCase().padEnd(8)} ${d.code.padEnd(32)} ${d.capabilityId ?? d.operationId ?? ""}  ${d.message}`;
}

/** Distinct auth requirements across the capability's member operations. */
function authSummary(air: AirDocument, cap: Capability): string[] {
  const seen = new Map<string, number>();
  for (const opId of cap.operationIds) {
    const op = air.operations.find((o) => o.id === opId);
    if (!op) continue;
    const key = `${op.auth.type} · principal ${op.auth.principal} · scopes [${op.auth.scopes.join(", ")}]`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  if (seen.size === 0) return ["(no member operations)"];
  return [...seen.entries()].map(([key, n]) => `${key} — ${n} op(s)`);
}
