import type { Command } from "commander";
import { CAPABILITIES } from "../capabilities.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";

/** `anvil capabilities [--json]`: the contract features this Anvil implements. */
export function registerCapabilities(parent: Command, ctx: CommandContext): void {
  annotate(
    parent
      .command("capabilities")
      .summary("List the gateway-contract features this Anvil implements.")
      .description(
        'Prints the feature names (for example token.proxy, manifest.claim) so a caller can tell which contract items this build supports. With --json, prints {"features": [...]}.',
      )
      .option("--json", 'print {"features": [...]} as JSON'),
    { mutates: false },
  ).action((opts: { json?: boolean }) => {
    const features = [...CAPABILITIES].sort();
    if (opts.json) ctx.io.out(JSON.stringify({ features }));
    else for (const feature of features) ctx.io.out(feature);
    ctx.code = 0;
  });
}
