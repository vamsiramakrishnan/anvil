import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AirDocument, Capability, Diagnostic } from "@anvil/air";
import { airFromJson, airFromYaml, airToYaml, evidenceConfidence } from "@anvil/air";
import {
  approveCapability,
  type CapabilityBudgetCheck,
  CapabilityReviewError,
  capabilityToolBudget,
  diffCapability,
  proposeCapabilities,
  rejectCapability,
} from "@anvil/compiler";
import type { CliIO } from "./io.js";

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
export function cmdCapability(
  args: string[],
  flags: Record<string, string | boolean>,
  io: CliIO,
): number {
  const sub = args[0];
  switch (sub) {
    case "propose":
      return cmdPropose(args.slice(1), io);
    case "list":
      return cmdList(args.slice(1), io);
    case "show":
      return cmdShow(args.slice(1), flags, io);
    case "approve":
      return cmdApprove(args.slice(1), flags, io);
    case "reject":
      return cmdReject(args.slice(1), flags, io);
    case "diff":
      return cmdDiff(args.slice(1), io);
    default:
      if (sub && sub !== "help") io.err(`Unknown capability subcommand: '${sub}'.`);
      io.err("Usage: anvil capability propose <dir|air.yaml>");
      io.err("       anvil capability list    <dir|air.yaml>");
      io.err(
        "       anvil capability show    <dir|air.yaml> <capability-id> [--operations] [--auth] [--evidence] [--json]",
      );
      io.err(
        "       anvil capability approve <dir|air.yaml> <capability-id> [--allow-large] [--note ..]",
      );
      io.err("       anvil capability reject  <dir|air.yaml> <capability-id> [--reason ..]");
      io.err("       anvil capability diff    <dir|air.yaml> <capability-id>");
      return sub && sub !== "help" ? 1 : 0;
  }
}

/** `anvil capability propose` — (re)run discovery; print proposals + budget findings. */
function cmdPropose(args: string[], io: CliIO): number {
  const air = loadAirDoc(args[0]);
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
function cmdList(args: string[], io: CliIO): number {
  const air = loadAirDoc(args[0]);
  if (air.capabilities.length === 0) {
    io.out("No capabilities stored. Run `anvil compile` (discovery) first.");
    return 0;
  }
  io.out(
    `${air.service.id} @ ${air.service.version} — ${air.capabilities.length} capability(ies):`,
  );
  for (const cap of air.capabilities) {
    const budget = capabilityToolBudget(cap);
    const flag = budget.verdict === "ok" ? "" : `  [${budget.verdict}: ${budget.toolCount} tools]`;
    io.out(
      `  ${cap.id.padEnd(28)} ${cap.lifecycle.padEnd(10)} ${String(cap.operationIds.length).padStart(3)} op(s)  ${cap.source}${flag}`,
    );
  }
  return 0;
}

/** `anvil capability show` — small summary; sections only on request. */
function cmdShow(args: string[], flags: Record<string, string | boolean>, io: CliIO): number {
  const [path, id] = args;
  if (!path || !id) {
    io.err(
      "Usage: anvil capability show <dir|air.yaml> <capability-id> [--operations] [--auth] [--evidence] [--json]",
    );
    return 1;
  }
  const air = loadAirDoc(path);
  const cap = air.capabilities.find((c) => c.id === id);
  if (!cap) {
    io.err(`No capability '${id}'. Run \`anvil capability list ${path}\`.`);
    return 1;
  }
  const budget = capabilityToolBudget(cap);
  if (flags.json === true) {
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

  if (flags.operations === true) {
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
  if (flags.auth === true) {
    io.out("\nAuth:");
    for (const line of authSummary(air, cap)) io.out(`  ${line}`);
  }
  if (flags.evidence === true) {
    io.out("\nEvidence:");
    for (const claim of cap.evidence.claims) {
      io.out(
        `  ${claim.predicate} = ${JSON.stringify(claim.value)} (${claim.source}, ${claim.confidence.toFixed(2)})${claim.note ? ` — ${claim.note}` : ""}`,
      );
    }
    if (cap.evidence.claims.length === 0) io.out("  (no claims)");
  }
  if (flags.operations !== true && flags.auth !== true && flags.evidence !== true) {
    io.out("\nSections: --operations --auth --evidence --json");
  }
  return 0;
}

/** `anvil capability approve` — record the decision; the tool budget gates it. */
function cmdApprove(args: string[], flags: Record<string, string | boolean>, io: CliIO): number {
  const [path, id] = args;
  if (!path || !id) {
    io.err(
      "Usage: anvil capability approve <dir|air.yaml> <capability-id> [--allow-large] [--note ..]",
    );
    return 1;
  }
  const airPath = resolveAirFile(path);
  const air = loadAirDoc(path);
  let budget: CapabilityBudgetCheck;
  try {
    budget = approveCapability(air, id, {
      allowLarge: flags["allow-large"] === true,
      note: typeof flags.note === "string" ? flags.note : undefined,
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
  writeFileSync(airPath, airToYaml(air), "utf8");
  io.out(`Approved capability '${id}' (${budget.toolCount} tool(s)) in ${airPath}.`);
  io.out(`Build it with \`anvil build ${path} ${id}\`.`);
  return 0;
}

/** `anvil capability reject` — record why the grouping is not the right unit. */
function cmdReject(args: string[], flags: Record<string, string | boolean>, io: CliIO): number {
  const [path, id] = args;
  if (!path || !id) {
    io.err("Usage: anvil capability reject <dir|air.yaml> <capability-id> [--reason ..]");
    return 1;
  }
  const airPath = resolveAirFile(path);
  const air = loadAirDoc(path);
  try {
    rejectCapability(air, id, typeof flags.reason === "string" ? flags.reason : undefined);
  } catch (err) {
    if (err instanceof CapabilityReviewError) {
      io.err(`error ${err.code}: ${err.message}`);
      return 1;
    }
    throw err;
  }
  writeFileSync(airPath, airToYaml(air), "utf8");
  io.out(`Rejected capability '${id}' in ${airPath}.`);
  return 0;
}

/** `anvil capability diff` — stored capability vs a fresh re-discovery. */
function cmdDiff(args: string[], io: CliIO): number {
  const [path, id] = args;
  if (!path || !id) {
    io.err("Usage: anvil capability diff <dir|air.yaml> <capability-id>");
    return 1;
  }
  const air = loadAirDoc(path);
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

/**
 * AIR file resolution shared by the capability and build commands (mirrors the
 * private helpers in anvil-cli.ts, which this new command group must not edit
 * beyond its two dispatch lines).
 */
export function resolveAirFile(path?: string): string {
  if (!path) throw new Error("Provide a path to an AIR file or a generated directory.");
  if (existsSync(path) && statSync(path).isDirectory()) {
    for (const name of ["air.yaml", "air.json"]) {
      const candidate = join(path, name);
      if (existsSync(candidate)) return candidate;
    }
    throw new Error(`No air.yaml or air.json in ${path}.`);
  }
  return path;
}

/** Load and validate the AIR document at a file or generated-directory path. */
export function loadAirDoc(path?: string): AirDocument {
  const resolved = resolveAirFile(path);
  const text = readFileSync(resolved, "utf8");
  return resolved.endsWith(".json") ? airFromJson(text) : airFromYaml(text);
}
