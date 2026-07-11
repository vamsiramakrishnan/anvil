import { writeFileSync } from "node:fs";
import { airToYaml } from "@anvil/air";
import { approveOperations } from "@anvil/compiler";
import type { Command } from "commander";
import type { CliIO } from "../io.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";
import { loadAir, resolveAirPath } from "./shared.js";

/** `anvil approve` — persist operation approvals into the AIR file. */
export function registerApprove(parent: Command, ctx: CommandContext): void {
  annotate(
    parent
      .command("approve")
      .summary("Approve operations so they are exposed by the generated artifacts.")
      .description(
        "Only approved operations appear in the MCP server, CLI catalog, and compiled runtime manifest. Approve deliberately, after inspecting risk.",
      )
      .argument("<path>", "generated bundle directory or air.yaml")
      .argument("<operation-ids...>", "operation ids to approve")
      .action((path: string, ids: string[]) => {
        ctx.code = runApprove(path, ids, ctx.io);
      }),
    { mutates: true },
  );
}

function runApprove(path: string, ids: string[], io: CliIO): number {
  const airPath = resolveAirPath(path);
  const air = loadAir(path);
  approveOperations(air, ids);
  writeFileSync(airPath, airToYaml(air), "utf8");
  io.out(`Approved ${ids.length} operation(s) in ${airPath}.`);
  io.out("Regenerate the bundle with `anvil compile` or re-run generation to expose them.");
  return 0;
}
