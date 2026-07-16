import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { runToolCli } from "../tool-cli.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";
import { loadAir } from "./shared.js";

/**
 * `anvil run <dir> <resource> <action> [tool flags...]` — invoke an operation
 * through the safety runtime. Everything after <dir> belongs to the generated
 * tool CLI's own grammar (runToolCli), so this command is a pass-through:
 * options are not parsed here (`passThroughOptions` + `allowUnknownOption`),
 * and the raw remainder reaches the tool engine verbatim — including `--help`,
 * `--schema`, and every per-operation flag.
 */
export function registerRun(parent: Command, ctx: CommandContext): void {
  annotate(
    parent
      .command("run")
      .summary("Invoke an operation through the safety runtime.")
      .description(
        "Supports --dry-run, --confirm, --idempotency-key, --schema, --examples, --errors, --policy, --explain, --json, --trace. Unsafe mutations refuse without --confirm; failures are structured envelopes with stable exit codes (2 input, 3 needs-flags, 4 auth, 5 policy, 6 upstream state, 7 upstream availability).",
      )
      .argument("<dir>", "generated bundle directory or air.yaml")
      .argument("[args...]", "resource, action, and tool flags (forwarded verbatim)")
      // The tool engine owns its own --help; never intercept it here.
      .helpOption(false)
      .allowUnknownOption()
      .allowExcessArguments()
      .passThroughOptions()
      .action(async (dir: string, args: string[]) => {
        const air = loadAir(dir);
        // Point `--mcp stdio` at this bundle's own local MCP server, when present
        // (dir may be a bundle root or an air.yaml path — only the former ships one).
        const serverPath = join(dir, "mcp", "server.js");
        const mcpServerPath = existsSync(serverPath) ? serverPath : undefined;
        ctx.code = await runToolCli(air, args, { ...ctx.deps, io: ctx.io, mcpServerPath });
      }),
    { mutates: true },
  );
}
