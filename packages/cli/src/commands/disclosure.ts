import type {
  CapabilityBom,
  DisclosureBom,
  DisclosureContributor,
  DisclosureFinding,
  OperationBom,
} from "@anvil/compiler";
import { disclosureBom, group, percent } from "@anvil/compiler";
import { readBundleDir } from "@anvil/generators";
import type { Command } from "commander";
import type { CliIO } from "../io.js";
import { loadBundleAir, resolveBundleDir } from "./certify.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";

/**
 * `anvil disclosure <dir>` — the context-cost bill of materials, rendered for
 * the person who can fix it.
 *
 * Anvil already measures what an operation costs an agent to read. That figure
 * has so far only ever been consumed by the platform team: the ladder uses it to
 * decide a serving shape, refinement uses it to raise a deficiency, certification
 * asserts it. None of those put a number in front of the API owner, and "make
 * your API agent-friendly" is not a ticket anyone can close. This command is the
 * hop that closes it — a ranked, attributed report naming the specific fields
 * that spend the budget.
 *
 * ## Two kinds of number, kept apart on the terminal too
 *
 * Tool-surface figures are measured facts about the contract. Response figures
 * are projections: they come from driving the deterministic simulator under a
 * recorded seed over synthetic data, and what a real tenant's page costs may
 * differ. On a terminal both render as digits, so the projected half is labelled
 * everywhere it appears and never shares a column with the measured half —
 * matching how `anvil simulate` marks its simulated-data rows.
 *
 * ## Report, not gate
 *
 * Following `anvil assess`: a report that *completed* exits 0, findings and all.
 * Observing that an API is expensive is not a failure of this command, and an
 * owner running it precisely to learn what to fix should not have their pipeline
 * go red for facts they have not yet been given a chance to act on. Gating is
 * explicit (`--check`) and, deliberately, gates only on the measured half — see
 * the comment on `--check` for why a projection must never fail a build.
 */
export function registerDisclosure(parent: Command, ctx: CommandContext): void {
  annotate(
    parent
      .command("disclosure")
      .summary("Report where an agent's context budget goes, attributed to fields.")
      .description(
        "Read-only. A disclosure bill of materials for a compiled bundle: every operation ranked by the exact tokens its MCP tool surface costs an agent in `tools/list`, with that cost attributed to the specific contributors that produced it — the description, each input schema property, the safety metadata — so the output names the field to fix rather than the service to blame. " +
          "Rolls up per capability and per service, and reports the disclosure ladder's verdict (what laddering already saved, and what remains over the surface budget). " +
          "Tool-surface figures are exact measurements of the bytes the runtime publishes, counted under o200k_base. Response figures are projections from the deterministic simulator under a recorded seed and are labelled as such everywhere; a bundle whose responses were never measured says so rather than reporting zeros. " +
          "A report that completed exits 0; `--check` gates non-zero on operations whose measured tool surface exceeds the per-tool budget.",
      )
      .argument("<dir>", "generated bundle directory (or its air.yaml)")
      .option("--top <n>", "how many operations to detail (default 10; 0 for all)", "10")
      .option("--check", "gate: exit non-zero when a tool surface exceeds its budget")
      .option("--json", "emit the full bill of materials as JSON")
      .action((dir: string, opts: DisclosureOptions) => {
        ctx.code = runDisclosure(dir, opts, ctx.io);
      }),
    { mutates: false },
  );
}

export interface DisclosureOptions {
  top?: string;
  check?: boolean;
  json?: boolean;
}

export function runDisclosure(path: string, opts: DisclosureOptions, io: CliIO): number {
  let top = 10;
  if (opts.top !== undefined) {
    const parsed = Number.parseInt(opts.top, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      io.err(`Invalid --top '${opts.top}': expected a non-negative integer (0 for all).`);
      return 1;
    }
    top = parsed;
  }

  const dir = resolveBundleDir(path);
  const bom = disclosureBom(loadBundleAir(dir, readBundleDir(dir)));

  const checking = opts.check === true;
  if (opts.json === true) io.out(JSON.stringify(bom, null, 2));
  else io.out(render(bom, dir, top, checking));

  // Only the measured half may gate. A projection depends on a seed and on
  // synthetic data; letting it fail a build would make the exit code move when
  // the simulator's fixtures change, which is a property of Anvil rather than of
  // the API under review — and it would teach owners to distrust the whole
  // report. `anvil refine` owns the response-side deficiency workflow.
  if (!checking) return 0;
  return bom.findings.some((f) => f.kind === "tool_surface_over_budget") ? 1 : 0;
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

function render(bom: DisclosureBom, dir: string, top: number, checking: boolean): string {
  const lines: string[] = [];
  const { service, measurement, budgets } = bom;

  lines.push(
    `Disclosure BOM — ${service.serviceId} ${service.version}  (tokens: ${bom.estimator})`,
    "",
  );

  if (service.operations === 0) {
    lines.push("  No operations in this bundle — nothing to disclose.");
    return lines.join("\n");
  }

  lines.push(
    `  Tool surface   ${group(service.toolTokens)} tokens across ${service.operations} operation(s)`,
  );
  // Approval is what decides whether a cost is paid by anyone, so the served
  // figure is stated separately rather than folded into the total — a report
  // that shows only the total makes an unapproved surface look already shipped.
  lines.push(
    `  Served         ${group(service.servedToolTokens)} tokens across ${service.servedOperations} approved operation(s)`,
  );
  lines.push(
    `  Budgets        ${group(budgets.toolTokens)}/tool · ${group(budgets.responseTokens)}/response · ${group(budgets.surfaceTokens)}/surface`,
  );
  lines.push(`  Ladder         ${ladderLine(bom)}`);
  // A bundle with no recorded measurement is not a broken bundle — the tool half
  // is a pure function of the contract, so it is derived here on the spot. Saying
  // so keeps the figures from being read as certified evidence the bundle carries.
  if (measurement.recordedOperations === 0) {
    lines.push(
      "  Note           this bundle records no measurement; tool figures were derived from the contract just now.",
    );
  } else if (measurement.recordedEstimators.length > 1) {
    lines.push(
      `  Note           mixed tokenizers in recorded figures (${measurement.recordedEstimators.join(", ")}) — recompile to make them comparable.`,
    );
  }
  lines.push("");

  lines.push("  Most expensive operations (measured tool surface):");
  const shown = top === 0 ? bom.operations : bom.operations.slice(0, top);
  for (const [index, row] of shown.entries()) lines.push(...operationLines(row, index));
  if (shown.length < bom.operations.length) {
    lines.push(
      `    … ${bom.operations.length - shown.length} more (--top 0 for all, --json for everything).`,
    );
  }
  lines.push("");

  lines.push("  By capability:");
  for (const capability of bom.capabilities) lines.push(capabilityLine(capability));
  lines.push("");

  lines.push(...responseSection(bom, dir));
  lines.push("");

  lines.push(...findingsSection(bom, checking));
  return lines.join("\n");
}

function ladderLine(bom: DisclosureBom): string {
  const { ladder } = bom;
  const head = `${ladder.mode} (${ladder.reason})`;
  if (ladder.mode === "flat") {
    // `restTokens === flatTokens` when served flat, so there is no saving to
    // report; the useful number is how much headroom is left against the budget.
    const over =
      ladder.remainingOverBudgetTokens > 0
        ? `${group(ladder.remainingOverBudgetTokens)} OVER the surface budget`
        : `within the ${group(ladder.surfaceBudgetTokens)}-token surface budget`;
    return `${head} — ${group(ladder.restTokens)} tokens at rest, ${over}`;
  }
  const remaining =
    ladder.remainingOverBudgetTokens > 0
      ? `still ${group(ladder.remainingOverBudgetTokens)} over budget`
      : `within the ${group(ladder.surfaceBudgetTokens)}-token surface budget`;
  return (
    `${head} — ${ladder.lanes} lane(s) cut ${group(ladder.flatTokens)} to ${group(ladder.restTokens)} ` +
    `at rest (saved ${group(ladder.savedTokens)}), ${remaining}`
  );
}

function operationLines(row: OperationBom, index: number): string[] {
  const rank = `${index + 1}.`.padStart(4);
  const verdict =
    row.overBudgetTokens > 0 ? `  ✗ ${group(row.overBudgetTokens)} over budget` : "  ✓";
  // An unapproved operation costs a served agent nothing today, so its cost is
  // reported without being counted against the surface it is not part of.
  const state = row.served ? "" : `  [${row.state}, not served]`;
  const lines = [
    `  ${rank} ${group(row.toolTokens).padStart(8)}  ${row.operationId}${verdict}${state}`,
  ];
  // Three contributors is the whole point of the report and also its limit: a
  // large surface is almost always a couple of pathological fields, and printing
  // the long tail would bury the two names an owner needs.
  for (const part of row.contributors.slice(0, 3)) lines.push(contributorLine(part));
  return lines;
}

function contributorLine(part: DisclosureContributor): string {
  const label = `${kindPrefix(part.kind)}${part.label}`;
  const note = part.note ? `  ${part.note}` : "";
  return `       ${group(part.tokens).padStart(8)}  ${percent(part.share).padStart(4)}  ${label}${note}`;
}

/** Enough prefix to tell a schema property from a JSON key with the same name. */
function kindPrefix(kind: DisclosureContributor["kind"]): string {
  switch (kind) {
    case "input_property":
      return "input.";
    case "input_envelope":
      return "schema:";
    case "safety_meta":
      return "meta:";
    default:
      return "";
  }
}

function capabilityLine(capability: CapabilityBom): string {
  const over =
    capability.overBudgetOperations > 0 ? `, ${capability.overBudgetOperations} over budget` : "";
  return (
    `    ${group(capability.toolTokens).padStart(8)}  ${percent(capability.share).padStart(4)}  ` +
    `${capability.displayName} (${capability.operations} op(s)${over})`
  );
}

/**
 * The projected half, fenced off from the measured half above it. When nothing
 * was measured this prints an absence and a way to fix it — never a zero, which
 * on a cost report reads as "free" and is the one number here that would be a lie.
 */
function responseSection(bom: DisclosureBom, dir: string): string[] {
  const { measurement } = bom;
  if (measurement.projectedOperations === 0) {
    return [
      "  Response cost: NOT MEASURED.",
      `    Response size depends on a tenant's data, so it is projected by driving the simulator,`,
      `    not derived from the contract. Run \`anvil simulate ${dir}\` to record projections.`,
    ];
  }
  const seeds = measurement.seeds.length > 0 ? measurement.seeds.join(", ") : "unrecorded";
  const lines = [
    `  Response cost: PROJECTED from simulated data under seed ${seeds} — an estimate, not a`,
    `    measurement of live traffic (${measurement.projectedOperations}/${measurement.operations} operation(s) measured).`,
  ];
  // The costliest projected responses and, next to each, whether a caller can do
  // anything about it. The *deficiency* is the findings section's job; this is
  // the cost picture, so it lists expensive responses whether or not they are
  // over budget — including the ones that are fine, which is information too.
  const heavy = [...bom.operations]
    .filter((row) => row.response.projected)
    .sort((a, b) => (b.response.responseTokens ?? 0) - (a.response.responseTokens ?? 0))
    .slice(0, 5);
  for (const row of heavy) {
    const knob = row.response.hasPageSizeParam
      ? `page size: ${row.response.pageSize.size ?? "?"} (${row.response.pageSize.basis})`
      : `no page-size parameter (${row.response.pageSize.basis})`;
    lines.push(
      `    ~${group(row.response.responseTokens ?? 0)} tokens  ${row.operationId}  — ${knob}`,
    );
  }
  return lines;
}

function findingsSection(bom: DisclosureBom, checking: boolean): string[] {
  const gating = bom.findings.filter((f) => f.kind === "tool_surface_over_budget").length;
  if (bom.findings.length === 0) {
    return ["  No findings — every tool surface fits its budget and no response is unbounded."];
  }
  const lines = [`  Findings (${bom.findings.length}):`];
  for (const finding of bom.findings) lines.push(`    ${findingLine(finding)}`);
  lines.push("");
  if (!checking) {
    lines.push(
      "  Report only — exits 0. Use --check to gate a pipeline on measured over-budget tool surfaces.",
    );
  } else if (gating > 0) {
    lines.push(
      `  --check: FAILED — ${gating} operation(s) exceed the per-tool budget. Projected findings never gate.`,
    );
  } else {
    lines.push("  --check: passed — every measured tool surface fits its budget.");
  }
  return lines;
}

function findingLine(finding: DisclosureFinding): string {
  // The basis tag is the load-bearing part of this line. Without it a projected
  // response overage and a measured surface overage read identically, and the
  // report launders an estimate into a certified fact at the very last hop.
  const mark = finding.basis === "measured" ? "✗ [measured] " : "~ [projected]";
  return `${mark} ${finding.detail}`;
}
