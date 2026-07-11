import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import type { CliIO } from "../io.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";

/** `anvil package skill <dir>` — locate and verify the portable skill package. */
export function registerPackage(parent: Command, ctx: CommandContext): void {
  const pkg = annotate(
    parent
      .command("package")
      .summary("Locate and verify the portable skill package.")
      .description("The skill is also served over MCP as anvil://skill/<service>/... resources."),
    { mutates: false },
  );

  pkg
    .command("skill")
    .summary("Verify the bundle's skill package is complete.")
    .argument("<dir>", "generated bundle directory")
    .action((dir: string) => {
      ctx.code = runPackageSkill(dir, ctx.io);
    });
}

function runPackageSkill(dir: string, io: CliIO): number {
  const skillDir = join(dir, "skill");
  if (!existsSync(join(skillDir, "SKILL.md"))) {
    io.err(`No skill found at ${skillDir}. Run \`anvil compile\` first.`);
    return 1;
  }
  io.out(
    `Skill package is ready at ${skillDir} (SKILL.md + reference/ + schemas/ + examples/ + evals/).`,
  );
  io.out("It is also served over MCP as anvil://skill/<service>/... resources.");
  return 0;
}
