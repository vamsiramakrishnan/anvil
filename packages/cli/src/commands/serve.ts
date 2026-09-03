import { loadAir } from "@anvil/refinement";
import type { Command } from "commander";
import type { CliIO } from "../io.js";
import type { CommandContext } from "./context.js";
import { measuredAccuracyFromReport } from "./ladder-status.js";
import { annotate } from "./meta.js";

/** `anvil serve mcp <dir>` — boot the generated MCP server over stdio. */
export function registerServe(parent: Command, ctx: CommandContext): void {
  const serve = annotate(
    parent
      .command("serve")
      .summary("Serve the generated MCP server over stdio.")
      .description(
        "Boots the MCP server for local agent use. The same server deploys to Cloud Run for remote use.",
      ),
    { mutates: false },
  );

  serve
    .command("mcp")
    .summary("Serve the bundle's MCP server on stdio.")
    .argument("<dir>", "generated bundle directory or air.yaml")
    .action(async (dir: string) => {
      ctx.code = await runServeMcp(dir, ctx.io);
    });
}

async function runServeMcp(dir: string, io: CliIO): Promise<number> {
  const air = loadAir(dir);
  const { buildMcpServer, buildToolResources, readBundleDir, resolveBundleDir } = await import(
    "@anvil/generators"
  );
  const { allowedHostsFor, FetchTransport, loadRuntimeConfig, resolveCredentials, resolveLedger } =
    await import("@anvil/runtime");
  // The same measured accuracy delta `anvil status`/`anvil inspect` would show
  // for this bundle right now (`measuredAccuracyFromReport`), so `auto` mode's
  // decision here and what an operator was told to expect can never disagree.
  // A bundle that has never been benchmarked (or whose report is stale) simply
  // has no delta to weigh, which reproduces `auto`'s pre-measurement behavior.
  const bundleDir = resolveBundleDir(dir);
  const measuredAccuracy = measuredAccuracyFromReport(bundleDir, readBundleDir(bundleDir));
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const config = loadRuntimeConfig();
  const transport = new FetchTransport();
  const credentials = resolveCredentials(config);
  const ledger = resolveLedger(config.ledger, {
    resultTtlMs: config.ledgerResultTtlSeconds * 1000,
  });
  // ANVIL_BASE_URL is a deliberate operator override (loopback self-test,
  // staging smoke); when set without an allowlist, egress pins to its host.
  const baseUrl = process.env.ANVIL_BASE_URL ?? air.service.servers[0]?.url ?? "";
  const allowedHosts = allowedHostsFor(
    config.allowedHosts,
    baseUrl,
    process.env.ANVIL_BASE_URL !== undefined,
  );
  const server = buildMcpServer(air, {
    resources: buildToolResources(air),
    measuredAccuracy,
    contextFor: () => ({
      transport,
      serviceId: air.service.id,
      credentials,
      ledger,
      baseUrl,
      authProfile: config.authProfile,
      allowedHosts,
      env: config.env,
      timeoutMs: config.upstreamTimeoutMs,
    }),
  });
  io.err(`anvil: serving MCP for ${air.service.id} over stdio`);
  await server.connect(new StdioServerTransport());
  return 0;
}
