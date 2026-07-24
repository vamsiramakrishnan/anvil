import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Command } from "commander";
import { runToolCli } from "../tool-cli.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";
import { loadAir, resolveAirPath } from "./shared.js";

/**
 * `anvil run <dir> <resource> <action> [tool flags...]` — invoke an operation
 * through the safety runtime. Everything after <dir> belongs to the generated
 * tool CLI's own grammar (runToolCli), so this command is a pass-through:
 * options are not parsed here (`passThroughOptions` + `allowUnknownOption`),
 * and the raw remainder reaches the tool engine verbatim — including `--help`,
 * `--schema`, and every per-operation flag.
 */
export function registerRun(parent: Command, ctx: CommandContext): void {
  const run = parent
    .command("run")
    .summary("Invoke an operation through the safety runtime.")
    .description(
      "Supports --dry-run, --confirm, --idempotency-key, --schema, --examples, --errors, --policy, --explain, --json, --trace. Route through MCP with --mcp stdio, --mcp <https-url>, or explicit legacy --mcp sse:<url>; --mcp-token-env <NAME> reads a remote bearer token from that environment variable without putting the token in argv. Unsafe mutations refuse without --confirm; failures are structured envelopes with stable exit codes (2 input, 3 needs-flags, 4 auth, 5 policy, 6 upstream state, 7 upstream availability).",
    )
    .argument("[dir]", "generated bundle directory or air.yaml")
    .argument("[args...]", "resource, action, and tool flags (forwarded verbatim)")
    // The tool engine owns help after a bundle coordinate. Bare `anvil run
    // --help` is handled below so it cannot be mistaken for a bundle path.
    .helpOption(false)
    .allowUnknownOption()
    .allowExcessArguments()
    .passThroughOptions();

  annotate(
    run.action(async (dir: string | undefined, args: string[]) => {
      if (dir === undefined || ((dir === "--help" || dir === "-h") && args.length === 0)) {
        ctx.io.out(run.helpInformation());
        ctx.code = 0;
        return;
      }
      const airPath = resolveAirPath(dir);
      const air = loadAir(airPath);
      // Point `--mcp stdio` at this AIR file's sibling bundle server. Resolving
      // the canonical AIR path first keeps directory and direct air.yaml/json
      // coordinates behaviorally identical.
      const serverPath = join(dirname(airPath), "mcp", "server.js");
      const mcpServerPath = existsSync(serverPath) ? serverPath : undefined;
      ctx.code = await runToolCli(air, args, { ...ctx.deps, io: ctx.io, mcpServerPath });
    }),
    { mutates: true },
  );
}
