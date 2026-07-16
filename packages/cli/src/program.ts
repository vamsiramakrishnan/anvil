import { Command } from "commander";
import { registerAgentify } from "./commands/agentify.js";
import { registerApprove } from "./commands/approve.js";
import { registerAssess } from "./commands/assess.js";
import { registerBuild } from "./commands/build.js";
import { registerCapability } from "./commands/capability.js";
import { registerCase } from "./commands/case.js";
import { registerCertify } from "./commands/certify.js";
import { registerCompile } from "./commands/compile.js";
import { registerConformance } from "./commands/conformance.js";
import type { AnvilCliDeps, CommandContext } from "./commands/context.js";
import { registerDeploy } from "./commands/deploy.js";
import { registerDistill } from "./commands/distill.js";
import { registerDrift } from "./commands/drift.js";
import { registerEnrich } from "./commands/enrich.js";
import { registerEstate } from "./commands/estate.js";
import { registerInspect } from "./commands/inspect.js";
import { registerLint } from "./commands/lint.js";
import { registerPackage } from "./commands/package.js";
import { registerPublish } from "./commands/publish.js";
import { registerRefine } from "./commands/refine.js";
import { registerReview } from "./commands/review.js";
import { registerRun } from "./commands/run.js";
import { registerSelftest } from "./commands/selftest.js";
import { registerServe } from "./commands/serve.js";
import { registerSimulate } from "./commands/simulate.js";
import { registerSkill } from "./commands/skill.js";
import { registerSource } from "./commands/source.js";
import { registerSources } from "./commands/sources.js";
import { registerSync } from "./commands/sync.js";
import { processIO } from "./io.js";

export const VERSION = "0.1.0";

/** The per-program context, so `runAnvilCli` can read the exit code back after parsing. */
const CONTEXTS = new WeakMap<Command, CommandContext>();

/**
 * Build the `anvil` command tree. Commander is the single owner of every
 * command's path, arguments, options, summary, long description, and help;
 * actions carry only business logic and record their exit code in the
 * program's context — nothing here ever calls process.exit (exitOverride), and
 * all output flows through the injected CliIO (configureOutput).
 *
 * Commands register in lifecycle order — the order an operator meets them —
 * and root help lists them the same way.
 */
export function createAnvilProgram(deps: AnvilCliDeps = {}): Command {
  const io = deps.io ?? processIO;
  const ctx: CommandContext = { io, deps, code: 0 };

  const program = new Command("anvil");
  program
    .description("anvil — an agent toolchain compiler")
    .version(VERSION)
    // Positional options let `anvil run` pass its tool flags through untouched.
    .enablePositionalOptions()
    .exitOverride()
    .showSuggestionAfterError(true)
    .configureOutput({
      writeOut: (s) => io.out(trimTrailingNewline(s)),
      writeErr: (s) => io.err(trimTrailingNewline(s)),
    })
    .addHelpText(
      "after",
      "\nRun `anvil <command> --help` for usage. The CLI, MCP server, and skill\nare all generated from one AIR model. No drift.",
    );

  // Lifecycle order: discovery → review → quality → gates → operations.
  registerSource(program, ctx);
  registerAgentify(program, ctx);
  registerCompile(program, ctx);
  registerInspect(program, ctx);
  registerAssess(program, ctx);
  registerDistill(program, ctx);
  registerCapability(program, ctx);
  registerRefine(program, ctx);
  registerCase(program, ctx);
  registerEnrich(program, ctx);
  registerEstate(program, ctx);
  registerSources(program, ctx);
  registerApprove(program, ctx);
  registerLint(program, ctx);
  registerBuild(program, ctx);
  registerReview(program, ctx);
  registerCertify(program, ctx);
  registerSelftest(program, ctx);
  registerConformance(program, ctx);
  registerSimulate(program, ctx);
  registerPublish(program, ctx);
  registerDeploy(program, ctx);
  registerSync(program, ctx);
  registerDrift(program, ctx);
  registerRun(program, ctx);
  registerServe(program, ctx);
  registerPackage(program, ctx);
  registerSkill(program, ctx);

  // `anvil version` (the positional spelling of --version) stays supported but
  // hidden — it is an alias, not a lifecycle step.
  program
    .command("version", { hidden: true })
    .summary("Print the anvil version.")
    .action(() => {
      io.out(VERSION);
    });

  CONTEXTS.set(program, ctx);
  return program;
}

/** The exit code the last executed action recorded (0 when no action ran). */
export function programExitCode(program: Command): number {
  return CONTEXTS.get(program)?.code ?? 0;
}

/** CliIO appends its own newline; strip Commander's so output stays line-shaped. */
function trimTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s.slice(0, -1) : s;
}
