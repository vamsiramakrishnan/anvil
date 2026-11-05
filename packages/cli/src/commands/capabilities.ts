import type { Command } from "commander";
import { capabilitiesDocument } from "../capabilities.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";

/** `anvil capabilities [--json]` — which optional features this Anvil implements. */
export function registerCapabilities(parent: Command, ctx: CommandContext): void {
  annotate(
    parent
      .command("capabilities")
      .summary("List the optional features this anvil implements.")
      .description(
        "Read-only. Lists the contract features this build supports by name (for example vault.firestore and connect.disconnect), so a caller can tell what to rely on.",
      )
      .option("--json", 'print {"features": [...]} as JSON')
      .action((opts: { json?: boolean }) => {
        const { features } = capabilitiesDocument();
        ctx.io.out(opts.json === true ? JSON.stringify({ features }) : features.join("\n"));
      }),
    { mutates: false },
  );
}
