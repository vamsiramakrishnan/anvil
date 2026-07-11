import type { Command } from "commander";
import type { CliIO } from "../io.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";
import { loadAir } from "./shared.js";

/** `anvil lint` — print safety diagnostics; exit non-zero on errors. */
export function registerLint(parent: Command, ctx: CommandContext): void {
  annotate(
    parent
      .command("lint")
      .summary("Show safety diagnostics; exit non-zero if there are errors.")
      .description(
        "Surfaces unproven idempotency, missing confirmation, duplicate names, and incoherent retry policy.",
      )
      .argument("<path>", "generated bundle directory or air.yaml")
      .action((path: string) => {
        ctx.code = runLint(path, ctx.io);
      }),
    { mutates: false },
  );
}

function runLint(path: string, io: CliIO): number {
  const air = loadAir(path);
  if (air.diagnostics.length === 0) {
    io.out("No diagnostics. Every operation is coherent.");
    return 0;
  }
  for (const d of air.diagnostics) {
    io.out(
      `${d.level.toUpperCase().padEnd(8)} ${d.code.padEnd(24)} ${d.operationId ?? ""}  ${d.message}`,
    );
  }
  const errors = air.diagnostics.filter((d) => d.level === "error").length;
  return errors > 0 ? 1 : 0;
}
