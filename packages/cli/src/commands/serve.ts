import { createServer } from "node:http";
import type { CertificationVerdict } from "@anvil/generators";
import type { FleetBundleInput, FleetServer } from "@anvil/mcp-runtime";
import { loadAir } from "@anvil/refinement";
import type { InboundIdentity, Principal, RuntimeConfig } from "@anvil/runtime";
import type { Command } from "commander";
import type { CliIO } from "../io.js";
import type { CommandContext } from "./context.js";
import { measuredAccuracyFromReport } from "./ladder-status.js";
import { annotate } from "./meta.js";

/** `anvil serve mcp <dir> [--fleet [--http <port>]]` — boot the generated MCP server. */
export function registerServe(parent: Command, ctx: CommandContext): void {
  const serve = annotate(
    parent
      .command("serve")
      .summary("Serve the generated MCP server over stdio (or a fleet over StreamableHTTP).")
      .description(
        "Boots the MCP server for local agent use over stdio. With --fleet --http it serves a whole workspace over StreamableHTTP behind the same inbound-auth gate the deployed server enforces. The same server deploys to Cloud Run or Kubernetes for remote use.",
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
    .option(
      "--http <port>",
      "with --fleet: serve over StreamableHTTP on this port instead of stdio, with the deployed " +
        "server's inbound-auth enforcement (ANVIL_INBOUND_*); /readyz and /healthz share the listener",
    )
    .option(
      "--host <host>",
      "with --http: the interface to bind (default 127.0.0.1); a non-loopback host requires inbound auth",
    )
    .action(async (dir: string, opts: { fleet?: boolean; http?: string; host?: string }) => {
      if (opts.http !== undefined || opts.host !== undefined) {
        ctx.code = await runServeFleetHttp(dir, opts, ctx.io);
        return;
      }
      ctx.code = opts.fleet ? await runServeFleet(dir, ctx.io) : await runServeMcp(dir, ctx.io);
    });
}

/** `--fleet --http <port> [--host]`: the fleet over StreamableHTTP (serve-fleet-http.ts). */
async function runServeFleetHttp(
  dir: string,
  opts: { fleet?: boolean; http?: string; host?: string },
  io: CliIO,
): Promise<number> {
  if (!opts.fleet) {
    io.err(
      "anvil: --http and --host apply to --fleet only; a single bundle serves HTTP through its own runtime/server.js.",
    );
    return 1;
  }
  const port = Number(opts.http);
  if (opts.http === undefined || !Number.isInteger(port) || port < 1 || port > 65535) {
    io.err("anvil: --http expects a port from 1 to 65535.");
    return 1;
  }
  const { startFleetHttp } = await import("./serve-fleet-http.js");
  const started = await startFleetHttp(dir, { host: opts.host ?? "127.0.0.1", port, io });
  if (!started.ok) {
    io.err(`anvil: ${started.message}.`);
    return 1;
  }
  await new Promise<void>((resolve) => {
    const stop = () => void started.handle.close().finally(resolve);
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  });
  return 0;
}

async function runServeMcp(dir: string, io: CliIO): Promise<number> {
  const air = loadAir(dir);
  const { buildMcpServer, buildToolResources, readBundleDir, resolveBundleDir } = await import(
    "@anvil/generators"
  );
  const { bootRuntimeFromEnv } = await import("@anvil/runtime");
  // The same measured accuracy delta `anvil status`/`anvil inspect` would show
  // for this bundle right now (`measuredAccuracyFromReport`), so `auto` mode's
  // decision here and what an operator was told to expect can never disagree.
  // A bundle that has never been benchmarked (or whose report is stale) simply
  // has no delta to weigh, which reproduces `auto`'s pre-measurement behavior.
  const bundleDir = resolveBundleDir(dir);
  const measuredAccuracy = measuredAccuracyFromReport(bundleDir, readBundleDir(bundleDir));
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  // The same composition root the generated mcp/server.js and the deployed
  // runtime/server.js boot through: extensions (ANVIL_EXTENSIONS /
  // ANVIL_POLICY_BUNDLE), the record exporter (ANVIL_OTEL_EXPORTER), transport,
  // credentials, ledger — in that order — so a bundle served here cannot behave
  // differently from the same bundle served by its own entrypoint.
  const boot = await bootRuntimeFromEnv({
    serviceId: air.service.id,
    serviceVersion: air.service.version,
    log: (line) => io.err(line),
    // stdout is the MCP transport: records and diagnostics go to stderr.
    recordWrite: (line) => io.err(line),
  });
  const config = boot.config;
  // ANVIL_BASE_URL is a deliberate operator override (loopback self-test,
  // staging smoke); when set without an allowlist, egress pins to its host.
  const { baseUrl, allowedHosts, protocolFacade } = boot.baseUrlFor(air.service.servers[0]?.url);
  const server = buildMcpServer(air, {
    resources: buildToolResources(air),
    measuredAccuracy,
    contextFor: () => ({
      ...boot.contextDeps,
      serviceId: air.service.id,
      baseUrl,
      ...(protocolFacade !== undefined ? { protocolFacade } : {}),
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
 * `certification.json` (when present) is read AND verified against the
 * bundle's current content hash here, in the CLI (`verifyCertification`,
 * `@anvil/generators` — the same freshness gate `anvil deploy` checks a plan
 * against), and handed to `buildFleetServer` as plain data —
 * `@anvil/mcp-runtime` never reads the filesystem or depends on
 * `@anvil/generators` (that dependency runs the other way), so certification
 * stays a build-time artifact the serving path only ever consumes.
 */
export type BuildFleetResult =
  | { ok: true; fleet: FleetServer; bundleIds: string[] }
  | { ok: false; message: string };

/** One discovered bundle, read and verified once, ready to be mounted into any number of fleet compositions. */
interface PreparedBundle {
  id: string;
  air: ReturnType<typeof loadAir>;
  baseUrl: string;
  allowedHosts: string[];
  authProfile: string | undefined;
  measuredAccuracy: ReturnType<typeof measuredAccuracyFromReport>;
  certification: FleetBundleInput["certification"];
}

export type PreparedFleet =
  | {
      ok: true;
      bundleIds: string[];
      config: RuntimeConfig;
      principalDirectoryConfigured: boolean;
      /** Resolve a session's caller: by verified inbound identity, else ANVIL_PRINCIPAL. */
      principalFor: (inbound?: InboundIdentity) => Principal | undefined;
      /** Compose one fleet server for one session/transport, under one principal. */
      build(session: { principal: Principal | undefined }): Promise<FleetServer>;
    }
  | { ok: false; message: string };

/**
 * Everything about `--fleet` that does not touch a live transport: discover
 * bundles, boot the runtime, read each bundle's own certification, and hand
 * back a builder that composes a fleet server per session. Split out from
 * `runServeFleet` so it is unit-testable against a real workspace fixture
 * without ever binding stdio or a port, and so the HTTP transport
 * (`serve-fleet-http.ts`) can mount one composition per StreamableHTTP session
 * — an McpServer binds to exactly one transport — without re-reading disk.
 */
export async function prepareFleetForWorkspace(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PreparedFleet> {
  const { discoverBundles } = await import("@anvil/generators");
  const bundles = discoverBundles(workspaceRoot);
  if (bundles.length === 0) {
    return {
      ok: false,
      message: `no bundles found beneath ${workspaceRoot} (looked for air.yaml/air.json)`,
    };
  }

  const { buildFleetServer, fleetToolPrefix } = await import("@anvil/mcp-runtime");
  const { buildToolResources, readBundleDir, verifyCertification } = await import(
    "@anvil/generators"
  );
  const { allowedHostsFor, bootRuntimeFromEnv } = await import("@anvil/runtime");

  // Same composition root as every other serving surface (see runServeMcp).
  // A fleet mounts many bundles on one process, so its extensions and its
  // exporter are per-process: records from every bundle reach one sink, and
  // one policy hook set sees every call, keyed by `ctx.operation`.
  const boot = await bootRuntimeFromEnv({
    env,
    serviceId: "fleet",
    log: (line) => console.error(line),
    // stdout is the MCP transport: records and diagnostics go to stderr.
    recordWrite: (line) => console.error(line),
  });
  const config = boot.config;
  // Both caller gates come from the composition root, like every other
  // serving surface: the rate and spend limiters ride `boot.contextDeps`, and
  // `boot.principalFor` resolves the caller — from `ANVIL_PRINCIPAL` for a
  // stdio session, or from the verified inbound identity for an HTTP one.
  // `principalDirectoryConfigured` tells `execute()` whether `ANVIL_PRINCIPALS`
  // names any entries at all, so an unresolved caller (a mistyped or missing
  // credential, or one the directory does not name) is refused fail-closed
  // instead of silently reproducing the anonymous default.

  const prepared: PreparedBundle[] = bundles.map((bundle) => {
    const air = loadAir(bundle.dir);
    const baseUrl = air.service.servers[0]?.url ?? "";
    const allowedHosts = allowedHostsFor(config.allowedHosts, baseUrl, false);

    // Read once, reused below for both the benchmarked-ladder decision and
    // certification-hash verification — the exact same on-disk evidence
    // `anvil serve mcp` (no --fleet) and `anvil certify`/`anvil deploy`
    // already consult, so a fleet-mounted bundle can never quietly disagree
    // with what those commands would say about it. An unreadable bundle (a
    // disallowed symlink — see `readBundleDir`) is treated as having
    // neither: the fleet still mounts and serves it, exactly as an
    // unreadable certification.json already was before this.
    let files: Record<string, string> | undefined;
    try {
      files = readBundleDir(bundle.dir);
    } catch {
      files = undefined;
    }

    // The same measured accuracy delta `anvil serve mcp` (no --fleet) would
    // derive for this bundle right now (`measuredAccuracyFromReport`), so
    // `auto` mode's decision here and a standalone serve of the same bundle
    // can never disagree. A bundle that has never been benchmarked (or whose
    // report is stale) has no delta to weigh, reproducing `auto`'s
    // pre-measurement behavior — identical to the single-bundle path.
    const measuredAccuracy = files ? measuredAccuracyFromReport(bundle.dir, files) : undefined;

    // Credential namespace, mirrored from the tool-naming precedent
    // (`fleetToolPrefix`): with exactly one bundle mounted there is nothing
    // to disambiguate, so its authProfile is byte-identical to `anvil serve
    // mcp` without --fleet. From two bundles on, each bundle's authProfile
    // is namespaced by its own stable id — `credentialProfileName`
    // (`@anvil/runtime`) only adds the security-SCHEME suffix on top of
    // this, so two bundles whose schemes happen to share a name (both
    // "oauth", say) still resolve distinct `ANVIL_<PROFILE>_*` variables and
    // one service's credential can never be sent to another's origin (see
    // docs/fleet.md).
    const authProfile =
      bundles.length === 1
        ? config.authProfile
        : `${config.authProfile ?? "default"}_${fleetToolPrefix(bundle.id)}`;

    return {
      id: bundle.id,
      air,
      baseUrl,
      allowedHosts,
      authProfile,
      measuredAccuracy,
      certification: files ? readCertification(files, verifyCertification) : undefined,
    };
  });

  return {
    ok: true,
    bundleIds: bundles.map((b) => b.id),
    config,
    principalDirectoryConfigured: boot.contextDeps.principalDirectoryConfigured,
    principalFor: boot.principalFor,
    build: ({ principal }) =>
      buildFleetServer(
        prepared.map((bundle) => ({
          id: bundle.id,
          air: bundle.air,
          options: {
            resources: buildToolResources(bundle.air),
            measuredAccuracy: bundle.measuredAccuracy,
            contextFor: () => ({
              ...boot.contextDeps,
              serviceId: bundle.air.service.id,
              baseUrl: bundle.baseUrl,
              authProfile: bundle.authProfile,
              allowedHosts: bundle.allowedHosts,
              env: config.env,
              timeoutMs: config.upstreamTimeoutMs,
              principal,
            }),
          },
          certification: bundle.certification,
        })),
        { name: "anvil-fleet", version: "0.1.0" },
      ),
  };
}

/**
 * The stdio composition: one session, one principal for the lifetime of the
 * process, resolved from `ANVIL_PRINCIPAL` — the same rule a single-bundle
 * stdio server would follow if it opted in. Unconfigured (`ANVIL_PRINCIPALS`
 * unset, or `ANVIL_PRINCIPAL` unset/unmatched) resolves to `undefined`, which
 * `execute()` itself turns into the anonymous, every-scope principal (or a
 * fail-closed refusal when a directory IS configured) — this call never
 * invents a fallback of its own.
 */
export async function buildFleetForWorkspace(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<BuildFleetResult> {
  const prepared = await prepareFleetForWorkspace(workspaceRoot, env);
  if (!prepared.ok) return prepared;
  try {
    // One stdio session, one caller: the root resolves it from ANVIL_PRINCIPAL
    // exactly as it resolves an inbound one from a verified identity.
    const fleet = await prepared.build({ principal: prepared.principalFor() });
    return { ok: true, fleet, bundleIds: prepared.bundleIds };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
}

async function runServeFleet(workspaceRoot: string, io: CliIO): Promise<number> {
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

/**
 * Verify a bundle's own `certification.json` the same way `verifyCertification`
 * (`@anvil/generators` — the exact hash-freshness gate `anvil deploy` checks a
 * plan against) does: PASSED status AND a `bundleHash` that still matches the
 * CURRENT content of `files` — never the status string taken on faith. A
 * bundle with no certification.json, an unparsable one, one whose status
 * isn't "passed", or one whose bundleHash no longer matches what's on disk
 * (a compiler-owned file edited after `anvil certify` ran, or a
 * certification.json copied in from elsewhere) reports `fresh: false` with
 * `reason` naming why — readyz never trusts a status it hasn't re-verified.
 */
function readCertification(
  files: Record<string, string>,
  verifyCertificationFn: (files: Record<string, string>) => CertificationVerdict,
):
  | { hash: string; status: "passed" | "failed" | "expired"; fresh: boolean; reason?: string }
  | undefined {
  if (files["certification.json"] === undefined) return undefined;
  const verdict = verifyCertificationFn(files);
  // `certification` is absent only when certification.json itself was
  // missing/unparsable/schema-invalid — the same as never certified.
  if (!verdict.certification) return undefined;
  return verdict.ok
    ? { hash: verdict.certification.bundleHash, status: verdict.certification.status, fresh: true }
    : {
        hash: verdict.certification.bundleHash,
        status: verdict.certification.status,
        fresh: false,
        reason: verdict.reason,
      };
}

const DEFAULT_READYZ_PORT = 8787;

function parseReadyzPort(raw: string | undefined): number {
  if (!raw) return DEFAULT_READYZ_PORT;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_READYZ_PORT;
}
