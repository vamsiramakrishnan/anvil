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
import { type Command, Option } from "commander";
import type { CliIO } from "../io.js";
import { reportPreservedStaleArtifacts, reprojectBundleAtomically } from "./approve.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";
import { loadAir } from "./shared.js";

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
          "`approve`/`reject` persist the review decision to the AIR file. Approval enforces the effective disclosure budget (direct members plus authored workflow dependencies): more than 20 tools is blocked without --allow-large and an audit note; more than 15 warns. Only an approved capability can be built with `anvil build`.",
      ),
    { mutates: true },
  );

  capability
    .command("propose")
    .summary("(Re)run discovery; print proposals with provenance and budget findings.")
    .argument("<path>", "generated bundle directory or air.yaml")
    .action((path: string) => {
      ctx.code = runPropose(path, ctx.io);
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
}

interface ShowOptions {
  operations?: boolean;
  auth?: boolean;
  evidence?: boolean;
  json?: boolean;
}

/** `anvil capability propose` — (re)run discovery; print proposals + budget findings. */
function runPropose(path: string, io: CliIO): number {
  const air = loadAir(path);
  const proposals = proposeCapabilities(air);
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
  const result = reprojectBundleAtomically(
    path,
    air,
    `Capability approval for '${id}' regenerated executable bundle projections after the immutable gateway import receipt was issued.`,
  );
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
  const result = reprojectBundleAtomically(
    path,
    air,
    `Capability rejection for '${id}' regenerated executable bundle projections after the immutable gateway import receipt was issued.`,
  );
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

/** One-line rendering of the tool-budget verdict for the summary view. */
function budgetLine(budget: CapabilityBudgetCheck): string {
  if (budget.verdict === "ok")
    return `ok (${budget.toolCount} tool(s); default disclosure is 5–15)`;
  return `${budget.verdict} — ${budget.diagnostic?.message ?? ""}`;
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
