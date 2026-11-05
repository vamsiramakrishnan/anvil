import type { Command } from "commander";
import { FEATURES } from "../capabilities.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";

/** `anvil capabilities [--json]` — the contract-v2 features this build implements. */
export function registerCapabilities(parent: Command, ctx: CommandContext): void {
  annotate(
    parent
      .command("capabilities")
      .summary("List the optional features this Anvil implements.")
      .description(
        'Lists, by name, the optional features of this build (package.search, skill.lean, install.prefix, package.oci, bundle.icon). A host reads the list before it relies on one. With --json it prints {"features": [...]}.',
      )
      .option("--json", 'print {"features": [...]} as JSON')
      .action((opts: { json?: boolean }) => {
        ctx.io.out(opts.json ? JSON.stringify({ features: [...FEATURES] }) : FEATURES.join("\n"));
      }),
    { mutates: false },
  );
}
