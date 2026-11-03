import { readFileSync } from "node:fs";
import { generateIdentityKit } from "@anvil/targets";
import type { Command } from "commander";
import type { CommandContext } from "../context.js";
import { annotate } from "../meta.js";
import { resolveTargetBundle, writeTargetKitAtomically } from "./target-shared.js";

export function registerTargetIdentity(target: Command, ctx: CommandContext): void {
  annotate(
    target
      .command("identity")
      .summary(
        "Bind a reusable identity profile to a connector and generate deployment configuration.",
      )
      .argument("<dir>", "generated bundle directory")
      .requiredOption("--profile <file>", "versioned JSON identity profile")
      .action((dir: string, options: { profile: string }) => {
        try {
          const resolved = resolveTargetBundle(dir, undefined, ctx.io);
          if (!resolved) {
            ctx.code = 1;
            return;
          }
          const kit = generateIdentityKit(
            resolved.air,
            JSON.parse(readFileSync(options.profile, "utf8")),
          );
          const written = writeTargetKitAtomically(resolved.bundleRoot, "identity", kit.files, {});
          ctx.io.out(
            `Generated identity kit at ${written.targetDir}; profile sha256 ${kit.digest}.`,
          );
          for (const warning of written.warnings) ctx.io.err(warning);
        } catch (error) {
          ctx.io.err(`Identity kit refused: ${(error as Error).message}`);
          ctx.code = 1;
        }
      }),
    { mutates: true },
  );
}
