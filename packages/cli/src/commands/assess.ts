import { resolveOperation } from "@anvil/air";
import {
  assessReadiness,
  type Disposition,
  renderOperationReadiness,
  SEVERITIES,
  type Severity,
  summarizeAssessment,
  viewAssessment,
} from "@anvil/refinement";
import { type Command, Option } from "commander";
import type { CliIO } from "../io.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";
import { loadAir } from "./shared.js";

/** The `--fail-on` thresholds, each naming the dispositions that fail the check. */
const FAIL_ON: Record<string, readonly Disposition[]> = {
  blocked: ["blocked"],
  "human-decision": ["blocked", "humanDecisionRequired"],
  "refinement-required": ["blocked", "humanDecisionRequired", "refinementRequired"],
};

/**
 * `anvil assess` — the agent-readiness triage (Layer 2). Read-only: for every
 * operation it reports whether it can safely become an agent capability, and if
 * not, the gap that stands in the way. Reuses the deterministic detectors, so it
 * never disagrees with `anvil refine plan`; it only frames them per operation.
 *
 *   anvil assess <dir|air.yaml>                    the whole-service report
 *   anvil assess <dir> <operation>                 drill into one operation
 *   anvil assess <dir> operation <operation>       (same, plan-style spelling)
 *   anvil assess <dir> --severity blocking         narrow to a minimum severity
 *   anvil assess <dir> --check [--fail-on D]       gate: non-zero at/past the threshold
 *   anvil assess <dir> --json                      the versioned artifact (or the view)
 *
 * Report vs check: a report that *completed* exits 0, blockers and all —
 * observing a problem is not a failure. Gating is opt-in via `--check`, whose
 * `--fail-on` threshold (blocked | human-decision | refinement-required,
 * default blocked) fails when the overall or any operation disposition meets
 * it. Parse/internal errors exit non-zero on their own path regardless.
 */
export function registerAssess(parent: Command, ctx: CommandContext): void {
  annotate(
    parent
      .command("assess")
      .summary("Report which operations are agent-ready; gate a pipeline with --check.")
      .description(
        "Read-only. Runs Anvil's deterministic detectors and projects every operation's readiness disposition — ready, refinementRequired, humanDecisionRequired, blocked, or excluded — from the deficiency catalog's per-code policy plus the lifecycle state, with each gap's agent impact and an honest remediation (a suggested skill that is not implemented says so). " +
          "The result is a versioned artifact (schemaVersion, contractHash of the assessed AIR, overallDisposition, readyPercent); `--json` emits it whole, and `--severity` narrows the detail into a view without touching the totals. " +
          "A report that completed exits 0 even with blockers; gating is explicit: `--check [--fail-on blocked|human-decision|refinement-required]` (default blocked) exits non-zero when the overall or any operation disposition meets the threshold. " +
          "Drill into one operation with `anvil assess <dir> <operation>` (or the plan-style `... operation <name>`). Reuses the same detectors as `anvil refine plan`, so the per-operation triage never disagrees with the deficiency list.",
      )
      .argument("<path>", "generated bundle directory or air.yaml")
      .argument("[operation...]", "drill into one operation (id, canonical name, or command tail)")
      .addOption(
        new Option("--severity <severity>", "narrow the report to a minimum severity").choices(
          SEVERITIES,
        ),
      )
      .option("--check", "gate: exit non-zero at/past the --fail-on threshold")
      .addOption(
        new Option(
          "--fail-on <disposition>",
          "the disposition threshold --check fails at (default blocked)",
        ).choices(Object.keys(FAIL_ON)),
      )
      .option("--json", "emit the versioned artifact (or the filtered view) as JSON")
      .action((path: string, operation: string[], opts: AssessOptions) => {
        ctx.code = runAssess(path, operation, opts, ctx.io);
      }),
    { mutates: false },
  );
}

interface AssessOptions {
  severity?: Severity;
  check?: boolean;
  failOn?: string;
  json?: boolean;
}

function runAssess(path: string, operation: string[], opts: AssessOptions, io: CliIO): number {
  const checking = opts.check === true;
  if (opts.failOn !== undefined && !checking) {
    io.err("--fail-on only applies with --check (a report never gates).");
    return 1;
  }
  const failing = FAIL_ON[opts.failOn ?? "blocked"] as readonly Disposition[];
  const air = loadAir(path);
  const assessment = assessReadiness(air);

  // Plan-style `... operation <name>` and the terse `... <name>` both drill in.
  const selector = operation[0] === "operation" ? operation[1] : operation[0];
  if (selector) {
    const resolution = resolveOperation(air.operations, selector);
    if (resolution.status === "not_found") {
      io.err(`No operation matches '${selector}' in ${air.service.id}.`);
      return 1;
    }
    if (resolution.status === "ambiguous") {
      // A suffix like `create` often matches several resources; drilling into
      // the wrong operation's readiness silently would be worse than stopping.
      io.err(`'${selector}' is ambiguous in ${air.service.id}. Did you mean:`);
      for (const m of resolution.candidates) io.err(`  ${m.id}  (${m.cli.command})`);
      return 1;
    }
    const readiness = assessment.operations.find((o) => o.operationId === resolution.operation.id);
    if (!readiness) return 1;
    io.out(
      opts.json === true ? JSON.stringify(readiness, null, 2) : renderOperationReadiness(readiness),
    );
    return checking && failing.includes(readiness.disposition) ? 1 : 0;
  }

  const filtered = opts.severity !== undefined;
  const view = viewAssessment(assessment, filtered ? { minimumSeverity: opts.severity } : {});

  // JSON: the complete versioned artifact; with a filter, the view object whose
  // `assessment` carries the complete totals and whose matching* rows are the
  // narrowed detail — the two are never mixed into one ambiguous shape.
  io.out(
    opts.json === true
      ? JSON.stringify(filtered ? view : assessment, null, 2)
      : summarizeAssessment(view),
  );

  if (!checking) return 0;
  const fails =
    failing.includes(assessment.overallDisposition) ||
    assessment.operations.some((o) => failing.includes(o.disposition));
  return fails ? 1 : 0;
}
