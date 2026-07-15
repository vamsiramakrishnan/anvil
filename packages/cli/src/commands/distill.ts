import { distill, renderDistillation } from "@anvil/refinement";
import type { Command } from "commander";
import type { CliIO } from "../io.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";
import { loadAir } from "./shared.js";

/**
 * `anvil distill` — Stage 1 of stripping a bloated surface to its eigenbasis.
 * Deterministic and read-only: it computes the minimal spanning set of operations
 * (canonical reads + every write), names the reconstructible projections, and
 * flags intents that would be stranded if those were dropped. It proposes; it
 * never mutates AIR or approves anything.
 *
 *   anvil distill <dir>                 the report (basis / reconstructible / review)
 *   anvil distill <dir> --json          the machine artifact — the Stage-2 loop reads this
 *   anvil distill <dir> --check         gate: non-zero if a capability's basis still
 *                                       exceeds the tool budget (grouping is a screen)
 *
 * The Stage-2 half is the coding-harness loop that consumes this and iterates —
 * approve the basis, leave the reconstructible `review_required`, adjudicate the
 * stranded intents, re-distill. See skills/anvil-distill/SKILL.md.
 */
export function registerDistill(parent: Command, ctx: CommandContext): void {
  annotate(
    parent
      .command("distill")
      .summary("Strip a surface to its eigenbasis: the minimal spanning set of operations.")
      .description(
        "Deterministic, read-only whole-surface analysis (a peer of `assess`). Reads collapse by (resource, action) to one canonical, most-general read per cluster; every write is kept as its own basis vector; same-signature mutations are flagged for review, never auto-dropped. Reports the basis, the reconstructible read projections, the redundant clusters, any intents reachable ONLY through reconstructible ops (which a mechanical strip would lose), and capabilities whose basis still exceeds the tool budget. `--json` emits the full artifact for the Stage-2 coding-harness loop; `--check` gates on over-budget capabilities. It proposes only — approval stays an explicit, reviewed step.",
      )
      .argument("<path>", "generated bundle directory or air.yaml")
      .option("--json", "emit the distillation artifact as JSON")
      .option("--check", "gate: exit non-zero if a capability's basis exceeds the tool budget")
      .action((path: string, opts: { json?: boolean; check?: boolean }) => {
        ctx.code = runDistill(path, opts, ctx.io);
      }),
    { mutates: false },
  );
}

function runDistill(path: string, opts: { json?: boolean; check?: boolean }, io: CliIO): number {
  const air = loadAir(path);
  const report = distill(air);
  io.out(opts.json === true ? JSON.stringify(report, null, 2) : renderDistillation(report));
  if (opts.check === true && report.overBudgetCapabilities.length > 0) return 1;
  return 0;
}
