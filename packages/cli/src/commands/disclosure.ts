import type {
  CapabilityBom,
  DisclosureBom,
  DisclosureContributor,
  DisclosureFinding,
  OperationBom,
  ReachProfile,
  SuppliedResponseProjection,
} from "@anvil/compiler";
import {
  disclosureBom,
  group,
  percent,
  responseProjectionsFromSimulationReport,
} from "@anvil/compiler";
import type { ExecutableEvidenceState } from "@anvil/generators";
import {
  executableEvidenceStatuses,
  readBundleDir,
  type SIMULATION_REPORT_FILE,
} from "@anvil/generators";
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
 * ## Where the projections come from, and when they are refused
 *
 * `anvil simulate` computes the response projection to reach its own coverage
 * verdict and leaves it in `simulation.report.json`; it does not write back into
 * AIR, because AIR is the certified contract and a verification command must not
 * move the hash it was verified against. So this command reads that report — but
 * a report is evidence *about* a bundle, and evidence outlives the thing it
 * describes. Showing yesterday's projection against today's surface would be the
 * precise failure this whole report exists to prevent.
 *
 * The freshness question is therefore answered by the machinery that already
 * answers it for `anvil certify` and `anvil publish`:
 * `executableEvidenceStatuses` in `@anvil/generators` compares the report's
 * recorded `bundleHash` against `bundleHash(files)` over the bundle's generated
 * content. Nothing here re-implements that comparison, so there is exactly one
 * notion of "this evidence describes this bundle" in the product. A report that
 * matches may be shown, labelled, with its seed and estimator; one that does not
 * is named as stale and refused, and the command that would refresh it is
 * printed. No report at all keeps the honest `NOT MEASURED`.
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
          "Rolls up per capability and per service, and reports the disclosure ladder's verdict (what laddering already saved, and what remains over the surface budget) alongside tokens-to-reach — what an agent must read, starting cold, before it holds one operation's input schema, with the round trips that cost buys. " +
          "Tool-surface and reach figures are exact measurements of the bytes the runtime publishes, counted under o200k_base. Response figures are projections read from `simulation.report.json` under a recorded seed and are labelled as such everywhere; a report bound to different bundle content is reported as stale and refused rather than used, and a bundle whose responses were never measured says so rather than reporting zeros. " +
          "A report that completed exits 0; `--check` gates non-zero on operations whose measured tool surface exceeds the per-tool budget.",
      )
      .argument("<dir>", "generated bundle directory (or its air.yaml)")
      .option("--top <n>", "how many operations to detail (default 10; 0 for all)", "10")
      .option("--reach", "detail the tokens-to-reach distribution and its round trips")
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
  reach?: boolean;
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
  const files = readBundleDir(dir);
  const air = loadBundleAir(dir, files);
  const { evidence, projections } = simulationEvidence(files);
  const bom = disclosureBom(air, { responseProjections: projections });

  const checking = opts.check === true;
  // The provenance rides along in the JSON too. A machine consumer that reads a
  // projected figure without knowing which bundle content the report behind it
  // was bound to is in exactly the position the terminal renderer refuses to put
  // a human in, and `--json` is how the CI lane reads this command.
  if (opts.json === true) io.out(JSON.stringify({ ...bom, responseEvidence: evidence }, null, 2));
  else io.out(render(bom, dir, top, checking, evidence, opts.reach === true));

  // Only the measured half may gate. A projection depends on a seed and on
  // synthetic data; letting it fail a build would make the exit code move when
  // the simulator's fixtures change, which is a property of Anvil rather than of
  // the API under review — and it would teach owners to distrust the whole
  // report. `anvil refine` owns the response-side deficiency workflow.
  if (!checking) return 0;
  return bom.findings.some((f) => f.kind === "tool_surface_over_budget") ? 1 : 0;
}

/* -------------------------------------------------------------------------- */
/* Response evidence                                                          */
/* -------------------------------------------------------------------------- */

/**
 * `simulation.report.json`'s standing as a source of response projections for
 * *this* bundle. A restatement of `@anvil/generators`' evidence status plus how
 * much of it this command actually consumed — never a second opinion about
 * freshness, which has exactly one implementation and it is not here.
 */
interface ResponseEvidence {
  file: typeof SIMULATION_REPORT_FILE;
  state: ExecutableEvidenceState;
  /** Whether the report was recorded against this bundle's current content. */
  fresh: boolean;
  /** The content digest the report was taken against; null when unreadable. */
  bundleHash: string | null;
  /** Projections taken from it. Zero whenever the report was not usable. */
  used: number;
  /** The evidence machinery's own sentence about it, verbatim. */
  detail: string;
}

function simulationEvidence(files: Record<string, string>): {
  evidence: ResponseEvidence;
  projections: SuppliedResponseProjection[];
} {
  // The same call `anvil certify` and `anvil publish` make. It hashes the
  // bundle's generated content (records about the bundle, this report included,
  // are excluded from that identity) and compares it to the digest the report
  // recorded, so "fresh" here means precisely what it means on a release gate.
  const status = executableEvidenceStatuses(files).simulation;
  // `fresh` is the digest question and only the digest question — deliberately,
  // per its contract in `@anvil/generators`. A run that went red still measured
  // *this* content, so its figures describe the surface in front of the reader
  // and are usable; that the run failed is a separate fact, and the renderer
  // says it rather than suppressing numbers that are not wrong.
  const projections = status.fresh
    ? responseProjectionsFromSimulationReport(parseJson(files[status.file]))
    : [];
  return {
    evidence: {
      file: status.file,
      state: status.state,
      fresh: status.fresh,
      bundleHash: status.bundleHash,
      used: projections.length,
      detail: status.detail,
    },
    projections,
  };
}

/** Re-read what the evidence check already validated; unreadable stays absent. */
function parseJson(raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

function render(
  bom: DisclosureBom,
  dir: string,
  top: number,
  checking: boolean,
  evidence: ResponseEvidence,
  detailReach: boolean,
): string {
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
  // One line, in the header block, next to the ladder verdict it is the other
  // half of. Reach is the project's headline claim and the whole point of
  // surfacing it is that an owner can reproduce it on their own bundle — putting
  // it behind a flag would leave the claim exactly as unreproducible as it was.
  // But the default output is already dense, and the distribution behind the
  // headline (best, worst, which operations, the flat denominator) is detail an
  // owner wants only once they have decided to argue with the number. So the
  // figure is default and the distribution is `--reach`.
  lines.push(`  Reach          ${reachLine(bom.reach)}`);
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

  // Above the projected fence, because every figure in it is measured: reach is
  // a pure function of the contract and the ladder plan, with no seed and no
  // synthetic data anywhere in it.
  if (detailReach) {
    lines.push(...reachSection(bom.reach));
    lines.push("");
  }

  lines.push(...responseSection(bom, dir, evidence));
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

/* -------------------------------------------------------------------------- */
/* Reach                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Round trips, always stated. The ladder does not make context free — it trades
 * hops for tokens — so a line that shows the saving without the round trip that
 * bought it is selling half the trade, and the half it hides is the latency.
 */
function hopsPhrase(hops: ReachProfile["hops"]): string {
  if (hops.min === hops.max) return `${hops.min} hop${hops.min === 1 ? "" : "s"}`;
  return `${hops.min}–${hops.max} hops`;
}

/**
 * One decimal, because that is the precision at which a ratio like this is
 * quoted and argued about, and because `improvementRatio` is already rounded to
 * three places upstream — printing all of them would imply a resolution the
 * underlying token counts do not support.
 */
function ratioText(value: number | undefined): string {
  return value === undefined ? "—" : `${value.toFixed(1)}×`;
}

function reachLine(reach: ReachProfile): string {
  if (reach.operations === 0) {
    return "no approved operation on the served surface — nothing for an agent to reach.";
  }
  if (reach.median === undefined || reach.flatBaseline === undefined) {
    return `${reach.operations} approved operation(s), none measured — no reach figure to report.`;
  }
  // A floor that can only grow is not a total, and the ladder claim is a
  // comparison of two totals; saying so inline stops the ratio being quoted.
  const floor = reach.lowerBound
    ? ` [lower bound: ${reach.operations - reach.measured} served op(s) unmeasured]`
    : "";
  return (
    `median ${group(reach.median)} tokens · ${hopsPhrase(reach.hops)} to hold one operation's schema ` +
    `(flat baseline ${group(reach.flatBaseline)} — ${ratioText(reach.improvementRatio)} typical, ` +
    `${ratioText(reach.worstCaseRatio)} worst case)${floor}`
  );
}

/**
 * The distribution behind the headline. Every figure is measured, and the two
 * ratios are printed side by side on purpose: the median is the advertisement
 * and the worst case is the guarantee, and a ladder whose median looks excellent
 * while one lane is nearly the whole estate has not solved the problem for an
 * agent that needs that lane.
 */
function reachSection(reach: ReachProfile): string[] {
  const lines = [
    "  Reach — tokens an agent must read, starting cold, before it holds one operation's input schema:",
    `    Basis          ${reach.mode} (${reach.reason}) over ${reach.operations} approved operation(s), ${reach.measured} measured`,
  ];
  if (reach.median === undefined || reach.flatBaseline === undefined) {
    lines.push(
      "    No measured served operation — a reach figure would be a confident zero, so there is none.",
    );
    return lines;
  }
  lines.push(
    `    Flat listing   ${group(reach.flatBaseline)} tokens, 1 hop — what reaching ANY operation costs unladdered`,
  );
  lines.push(`    Best           ${group(reach.best ?? 0)} tokens  (${reach.bestOperationId})`);
  lines.push(`    Median         ${group(reach.median)} tokens`);
  lines.push(`    Worst          ${group(reach.worst ?? 0)} tokens  (${reach.worstOperationId})`);
  lines.push(`    Round trips    ${hopsPhrase(reach.hops)} before the schema is in context`);
  lines.push(
    `    Ratio          ${ratioText(reach.improvementRatio)} typical (flat ÷ median) · ${ratioText(reach.worstCaseRatio)} worst case (flat ÷ worst)`,
  );
  if (reach.mode === "flat") {
    // Otherwise a row of 1.0× reads as a ladder that underperformed, when in
    // fact no ladder was served: the surface fit, so the baseline and the served
    // surface are the same surface and the ratio is 1 by construction.
    lines.push(
      "    Served flat, so the baseline IS the served surface — the ratios are 1 by construction, not a ladder that failed.",
    );
  }
  if (reach.lowerBound) {
    lines.push(
      `    ${reach.operations - reach.measured} served operation(s) carry no measurement, so every figure above is a floor that can only grow.`,
    );
  }
  return lines;
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
 *
 * The projections themselves come from `simulation.report.json`, so this section
 * is also where that report's standing is disclosed: which bundle content it was
 * bound to, and — when it was bound to different content — that it exists, that
 * it was refused, and what would refresh it. An unusable report is worth naming
 * rather than silently collapsing into "not measured": "nobody has measured
 * this" and "somebody measured a surface you have since changed" are different
 * situations with different next actions.
 */
function responseSection(bom: DisclosureBom, dir: string, evidence: ResponseEvidence): string[] {
  const { measurement } = bom;
  if (measurement.projectedOperations === 0) {
    return [
      "  Response cost: NOT MEASURED.",
      `    Response size depends on a tenant's data, so it is projected by driving the`,
      `    simulator, not derived from the contract.`,
      ...absentProjectionReason(evidence, dir).map((line) => `    ${line}`),
    ];
  }
  const seeds = measurement.seeds.length > 0 ? measurement.seeds.join(", ") : "unrecorded";
  const units =
    measurement.projectedEstimators.length > 0
      ? ` (${measurement.projectedEstimators.join(", ")})`
      : "";
  const lines = [
    `  Response cost: PROJECTED from simulated data under seed ${seeds}${units} — an estimate, not a`,
    `    measurement of live traffic (${measurement.projectedOperations}/${measurement.operations} operation(s) measured).`,
    ...projectionProvenance(bom, evidence).map((line) => `    ${line}`),
  ];
  // A response figure counted with a different tokenizer than the tool figures
  // above it is a number in another unit sitting in the same report. It is not
  // wrong, but it cannot be added to or compared with anything else on the page.
  if (measurement.projectedEstimators.some((estimator) => estimator !== bom.estimator)) {
    lines.push(
      `    ⚠ These projections were counted under ${measurement.projectedEstimators.join(", ")}, not ${bom.estimator} —`,
      `      they are not comparable with the tool-surface figures above. Re-run \`anvil simulate ${dir}\`.`,
    );
  }
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

/**
 * Why there are no figures, in terms of the specific report on disk. The state
 * comes from `@anvil/generators`' evidence check, so every branch below is a
 * state that check can actually produce and none of them is a guess.
 */
function absentProjectionReason(evidence: ResponseEvidence, dir: string): string[] {
  const refresh = `Re-run \`anvil simulate ${dir}\` to measure the bundle as it stands.`;
  switch (evidence.state) {
    case "missing":
      return [
        `No ${evidence.file} in this bundle. \`anvil simulate ${dir}\` records the`,
        `projections there — it does not write them into AIR, because AIR is the certified`,
        `contract and a verification command must not move the hash it was verified against.`,
      ];
    case "stale":
      // The one branch that must never quietly fall through to "not measured".
      // Figures exist and are being deliberately refused; a reader who is not
      // told that will re-run nothing and wonder why simulate did not help.
      return [
        `NOT USED — ${evidence.detail}`,
        `Those projections describe a surface this bundle has moved off, and presenting them`,
        `as current is the failure this report exists to prevent. ${refresh}`,
      ];
    case "corrupt":
      return [`NOT USED — ${evidence.detail} ${refresh}`];
    default:
      // Fresh (or fresh-but-failed) yet nothing to take: the run matched this
      // bundle but sampled no populated page for any operation, so there is
      // genuinely no projection — not a staleness problem, and saying "re-run
      // simulate" here would send the reader in a circle.
      return [
        `${evidence.file} matches this bundle but records no response projection —`,
        `the simulator sampled no populated page to price (${evidence.detail}).`,
      ];
  }
}

/** Name the evidence behind every figure shown, per source that contributed. */
function projectionProvenance(bom: DisclosureBom, evidence: ResponseEvidence): string[] {
  const lines: string[] = [];
  if (bom.measurement.projectionSources.includes("recorded")) {
    lines.push("Evidence: recorded on this bundle's AIR (`disclosureCost`).");
  }
  if (bom.measurement.projectionSources.includes("simulation-report")) {
    lines.push(
      `Evidence: ${evidence.file}, bound to this bundle's content ` +
        `${evidence.bundleHash?.slice(0, 12) ?? "?"}… (${evidence.used} projection(s) read).`,
    );
    // Freshness and outcome are orthogonal, and the evidence machinery keeps
    // them so on purpose. The figures below were taken against this exact
    // content and are usable; that the run they came from went red is a
    // separate fact the reader is entitled to before quoting them.
    if (evidence.state === "failed") {
      lines.push(
        `⚠ That simulation run did not pass its own gates: ${evidence.detail}`,
        `  The figures still describe this bundle's content; the run reporting them did not pass.`,
      );
    }
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
