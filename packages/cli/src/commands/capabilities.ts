import type { Command } from "commander";
import { capabilitiesDocument } from "../capabilities.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";

/** `anvil capabilities [--json]`: the contract features this Anvil implements. */
export function registerCapabilities(parent: Command, ctx: CommandContext): void {
  annotate(
    parent
      .command("capabilities")
      .summary("List the optional contract features this Anvil implements.")
      .description(
        'Read-only. Lists the contract features this build supports by name (for example vault.firestore, token.proxy), so a caller can tell what to rely on. With --json, prints {"features": [...]}.',
      )
      .option("--json", 'print {"features": [...]} as JSON')
      .action((opts: { json?: boolean }) => {
        const { features } = capabilitiesDocument();
        ctx.io.out(opts.json === true ? JSON.stringify({ features }) : features.join("\n"));
        ctx.code = 0;
      }),
    { mutates: false },
  );
}
