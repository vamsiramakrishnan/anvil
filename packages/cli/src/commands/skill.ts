import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Command } from "commander";
import type { CliIO } from "../io.js";
import { generateAnvilSkill } from "../self-skill.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";

/**
 * `anvil skill [out-dir]` — emit the skill that lets a coding-agent harness
 * operate anvil itself. The reference is derived by walking this very Commander
 * tree (see self-skill.ts), so the manual an agent reads never drifts from the
 * CLI it drives.
 */
export function registerSkill(parent: Command, ctx: CommandContext): void {
  annotate(
    parent
      .command("skill")
      .summary("Emit the skill that lets an agent harness operate anvil.")
      .description(
        "Generates SKILL.md plus reference/ and evals/ for operating the anvil CLI itself. The command reference is derived by walking anvil's own Commander tree — the same tree that parses this invocation — so the skill never drifts from the CLI.",
      )
      .argument("[out-dir]", "write the package here instead of printing SKILL.md")
      .action((outDir: string | undefined, _opts: unknown, command: Command) => {
        ctx.code = runSelfSkill(outDir, rootOf(command), ctx.io);
      }),
    { mutates: false },
  );
}

/** Walk up to the root `anvil` program (the tree the skill documents). */
function rootOf(command: Command): Command {
  let root = command;
  while (root.parent) root = root.parent;
  return root;
}

function runSelfSkill(outDir: string | undefined, program: Command, io: CliIO): number {
  const files = generateAnvilSkill(program);
  if (!outDir) {
    io.out(files["SKILL.md"] ?? "");
    return 0;
  }
  for (const [rel, contents] of Object.entries(files)) {
    const full = join(outDir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents, "utf8");
  }
  io.out(`Wrote the anvil operating skill to ${outDir} (SKILL.md + reference/ + evals/).`);
  io.out("Point a coding-agent harness (Claude Code, Codex, Antigravity) at it to operate Anvil.");
  return 0;
}
