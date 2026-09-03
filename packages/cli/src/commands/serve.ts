import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import type { FleetServer } from "@anvil/mcp-runtime";
import { loadAir } from "@anvil/refinement";
import type { Command } from "commander";
import type { CliIO } from "../io.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";

/** `anvil serve <dir> [--fleet]` — boot the generated MCP server over stdio. */
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
    .summary("Serve one bundle's MCP server on stdio, or a whole workspace with --fleet.")
    .argument("<dir>", "generated bundle directory or air.yaml (a workspace root with --fleet)")
    .option(
      "--fleet",
      "treat <dir> as a workspace root and mount every bundle beneath it onto one MCP server, " +
        "each under a stable per-bundle tool prefix (see docs/fleet.md)",
    )
    .action(async (dir: string, opts: { fleet?: boolean }) => {
      ctx.code = opts.fleet ? await runServeFleet(dir, ctx.io) : await runServeMcp(dir, ctx.io);
    });
}

async function runServeMcp(dir: string, io: CliIO): Promise<number> {
  const air = loadAir(dir);
  const { buildMcpServer, buildToolResources } = await import("@anvil/generators");
  const { allowedHostsFor, FetchTransport, loadRuntimeConfig, resolveCredentials, resolveLedger } =
    await import("@anvil/runtime");
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

/**
 * `--fleet`: `<dir>` names a WORKSPACE ROOT, not a single bundle. Discovery is
 * `@anvil/generators`'s `discoverBundles` — the exact function the console
 * uses to browse a workspace, so the fleet and the console can never
 * disagree about what counts as a bundle. Each discovered bundle's own
 * `certification.json` (when present) is read here, in the CLI, and handed
 * to `buildFleetServer` as plain data — `@anvil/mcp-runtime` never reads the
 * filesystem or depends on `@anvil/generators` (that dependency runs the
 * other way), so certification stays a build-time artifact the serving path
 * only ever consumes.
 */
export type BuildFleetResult =
  | { ok: true; fleet: FleetServer; bundleIds: string[] }
  | { ok: false; message: string };

/**
 * Everything about `--fleet` that does not touch a live transport: discover
 * bundles, read each one's own certification, and build the fleet server.
 * Split out from `runServeFleet` so it is unit-testable against a real
 * workspace fixture without ever binding stdio or a port.
 */
export async function buildFleetForWorkspace(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<BuildFleetResult> {
  const { discoverBundles } = await import("@anvil/generators");
  const bundles = discoverBundles(workspaceRoot);
  if (bundles.length === 0) {
    return {
      ok: false,
      message: `no bundles found beneath ${workspaceRoot} (looked for air.yaml/air.json)`,
    };
  }

  const { buildFleetServer } = await import("@anvil/mcp-runtime");
  const { buildToolResources } = await import("@anvil/generators");
  const {
    allowedHostsFor,
    buildLimitsGate,
    FetchTransport,
    loadRuntimeConfig,
    resolveCredentials,
    resolveLedger,
    resolvePrincipalForEnv,
  } = await import("@anvil/runtime");

  const config = loadRuntimeConfig(env);
  const transport = new FetchTransport();
  const credentials = resolveCredentials(config);
  const ledger = resolveLedger(config.ledger, {
    resultTtlMs: config.ledgerResultTtlSeconds * 1000,
  });
  // One session, one principal for the lifetime of this stdio process — the
  // same rule a single-bundle stdio server would follow if it opted in.
  // Unconfigured (`ANVIL_PRINCIPALS` unset, or `ANVIL_PRINCIPAL` unset/
  // unmatched) resolves to `undefined` here, which `execute()` itself turns
  // into the anonymous, every-scope principal — this call never invents a
  // fallback of its own.
  const principal = resolvePrincipalForEnv(config.principals, env);
  const limits = buildLimitsGate(config.limits);

  const fleetInputs = bundles.map((bundle) => {
    const air = loadAir(bundle.dir);
    const baseUrl = air.service.servers[0]?.url ?? "";
    const allowedHosts = allowedHostsFor(config.allowedHosts, baseUrl, false);
    return {
      id: bundle.id,
      air,
      options: {
        resources: buildToolResources(air),
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
          principal,
          limits,
        }),
      },
      certification: readCertification(bundle.dir),
    };
  });

  try {
    const fleet = await buildFleetServer(fleetInputs, { name: "anvil-fleet", version: "0.1.0" });
    return { ok: true, fleet, bundleIds: bundles.map((b) => b.id) };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
}

export async function runServeFleet(workspaceRoot: string, io: CliIO): Promise<number> {
  const built = await buildFleetForWorkspace(workspaceRoot);
  if (!built.ok) {
    io.err(`anvil: ${built.message}.`);
    return 1;
  }
  const { fleet, bundleIds } = built;

  const readyzPort = parseReadyzPort(process.env.ANVIL_FLEET_READYZ_PORT);
  const readyzHttp = createServer((req, res) => {
    if (req.url === "/readyz") {
      const body = fleet.readyz();
      res.writeHead(body.ready ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "not_found", message: "Only /readyz is served." } }));
  });
  readyzHttp.listen(readyzPort);

  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  io.err(
    `anvil: serving fleet of ${bundleIds.length} bundle(s) over stdio ` +
      `(${bundleIds.join(", ")}); /readyz on :${readyzPort}`,
  );
  await fleet.server.connect(new StdioServerTransport());
  readyzHttp.close();
  await fleet.close();
  return 0;
}

/** Read a bundle's own `certification.json`, or undefined when it has never been certified. */
function readCertification(
  bundleDir: string,
): { hash: string; status: "passed" | "failed" | "expired" } | undefined {
  const path = join(bundleDir, "certification.json");
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      bundleHash?: unknown;
      status?: unknown;
    };
    if (typeof parsed.bundleHash !== "string") return undefined;
    if (
      parsed.status !== "passed" &&
      parsed.status !== "failed" &&
      parsed.status !== "expired"
    ) {
      return undefined;
    }
    return { hash: parsed.bundleHash, status: parsed.status };
  } catch {
    // An unreadable/malformed certification.json is the same as none: the
    // fleet still serves the bundle, and readyz honestly reports it uncertified.
    return undefined;
  }
}

const DEFAULT_READYZ_PORT = 8787;

function parseReadyzPort(raw: string | undefined): number {
  if (!raw) return DEFAULT_READYZ_PORT;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_READYZ_PORT;
}
