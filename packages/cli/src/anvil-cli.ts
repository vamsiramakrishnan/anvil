import { CapabilityReviewError } from "@anvil/compiler";
import { CommanderError } from "commander";
import type { AnvilCliDeps } from "./commands/context.js";
import { processIO } from "./io.js";
import { createAnvilProgram, programExitCode } from "./program.js";

export type { AnvilCliDeps } from "./commands/context.js";

/**
 * The top-level `anvil` command (spec §17, §20). A thin embedding shell over
 * the Commander tree in program.ts: build the program, parse, and map every
 * outcome — action exit codes, help, version, and Commander's own usage
 * errors — to a deterministic return code. Never terminates the process; all
 * text flows through the injected CliIO.
 */
export async function runAnvilCli(argv: string[], deps: AnvilCliDeps = {}): Promise<number> {
  const io = deps.io ?? processIO;
  const program = createAnvilProgram({ ...deps, io });

  // Bare `anvil` orients rather than errors: root help on stdout, exit 0.
  if (argv.length === 0) {
    io.out(program.helpInformation().trimEnd());
    return 0;
  }

  try {
    await program.parseAsync(argv, { from: "user" });
    return programExitCode(program);
  } catch (err) {
    if (err instanceof CommanderError) {
      // --help / help <cmd> (helpDisplayed), --version, and a bare parent
      // command showing its subcommand usage (help) all succeed; every real
      // usage error — unknown command/option, missing argument, invalid
      // choice, conflict — was already written through CliIO and fails.
      const benign = ["commander.helpDisplayed", "commander.version", "commander.help"];
      return benign.includes(err.code) ? 0 : 1;
    }
    if (err instanceof CapabilityReviewError) {
      io.err(`error ${err.code}: ${err.message}`);
      return 1;
    }
    io.err(`anvil: ${(err as Error).message}`);
    return 1;
  }
}
