import { createServer, type Server } from "node:http";
import { BlockList, isIP } from "node:net";
import type { CertificationVerdict } from "@anvil/generators";
import type { FleetBundleInput, FleetServer } from "@anvil/mcp-runtime";
import { loadAir } from "@anvil/refinement";
import type {
  AuditSink,
  CredentialResolver,
  InboundIdentity,
  Principal,
  RuntimeConfig,
} from "@anvil/runtime";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Command } from "commander";
import type { CliIO } from "../io.js";
import type { CommandContext } from "./context.js";
import { isOwnLoopbackHost, json } from "./fleet-http-io.js";
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
      // One stdio session, one caller, resolved from ANVIL_PRINCIPAL. Spreading
      // `contextDeps` without this would hand `execute()` a configured
      // directory and no caller, which it refuses fail-closed — so omitting it
      // breaks every call the moment an operator sets ANVIL_PRINCIPALS.
      principal: boot.principalFor(),
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

/**
 * What a Branchyard gateway session adds to a fleet composition: the
 * principal's vault-backed credentials (never the environment's).
 */
interface GatewaySessionDeps {
  credentials: CredentialResolver;
  mcp?: import("@anvil/runtime").McpUpstream;
}

export type PreparedFleet =
  | {
      ok: true;
      bundleIds: string[];
      /** Each mounted bundle's connector id (its fleet prefix) and AIR, for the connect flow. */
      connectors: Array<{ bundleId: string; connector: string; air: ReturnType<typeof loadAir> }>;
      config: RuntimeConfig;
      principalDirectoryConfigured: boolean;
      /** Resolve a session's caller: by verified inbound identity, else ANVIL_PRINCIPAL. */
      principalFor: (inbound?: InboundIdentity) => Principal | undefined;
      /**
       * Compose one fleet server for one session/transport, under one
       * principal. A principal carrying a Branchyard grant gets every tool
       * under its connector prefix, `tools/list` narrowed to its grant, and
       * `gateway.credentials` in place of the environment's resolver.
       */
      build(session: {
        principal: Principal | undefined;
        gateway?: GatewaySessionDeps;
      }): Promise<FleetServer>;
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
  opts: { audit?: AuditSink } = {},
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
  const { allowedHostsFor, bootRuntimeFromEnv, decideGrant } = await import("@anvil/runtime");

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
    connectors: prepared.map((bundle) => ({
      bundleId: bundle.id,
      connector: fleetToolPrefix(bundle.id),
      air: bundle.air,
    })),
    config,
    principalDirectoryConfigured: boot.contextDeps.principalDirectoryConfigured,
    principalFor: boot.principalFor,
    build: ({ principal, gateway }) => {
      const grants = principal?.grants;
      if (grants !== undefined && !gateway) {
        // Fail closed: a granted caller's credentials come from the vault,
        // never from the environment's resolver.
        return Promise.reject(
          new Error("a Branchyard principal needs the gateway's vault credentials"),
        );
      }
      const opsById = new Map(
        prepared.map((bundle) => [
          bundle.id,
          new Map(bundle.air.operations.map((op) => [op.id, op] as const)),
        ]),
      );
      const serviceOf = new Map(prepared.map((bundle) => [bundle.id, bundle.air.service.id]));
      return buildFleetServer(
        prepared.map((bundle) => ({
          id: bundle.id,
          air: bundle.air,
          options: {
            resources: buildToolResources(bundle.air),
            measuredAccuracy: bundle.measuredAccuracy,
            contextFor: () => ({
              ...boot.contextDeps,
              ...(gateway ? { credentials: gateway.credentials, mcp: gateway.mcp } : {}),
              serviceId: bundle.air.service.id,
              baseUrl: bundle.baseUrl,
              authProfile: bundle.authProfile,
              allowedHosts: bundle.allowedHosts,
              env: config.env,
              timeoutMs: config.upstreamTimeoutMs,
              principal,
              connector: fleetToolPrefix(bundle.id),
              ...(opts.audit ? { audit: opts.audit } : {}),
            }),
          },
          certification: bundle.certification,
        })),
        {
          name: "anvil-fleet",
          version: "0.1.0",
          // A Branchyard caller dials `<connector>__<tool>` whatever else the
          // gateway serves, and is offered only what its grant allows.
          ...(grants !== undefined
            ? {
                alwaysPrefix: true,
                listFilter: (bundleId: string, operationId: string | undefined) => {
                  const op = operationId ? opsById.get(bundleId)?.get(operationId) : undefined;
                  if (!op) {
                    // A composite (workflow) tool: offered when the grant
                    // reaches this connector at all; each step it runs is
                    // still checked on its own.
                    return grants.some((entry) => entry.connector === fleetToolPrefix(bundleId));
                  }
                  return decideGrant(grants, fleetToolPrefix(bundleId), op, serviceOf.get(bundleId))
                    .allowed;
                },
              }
            : {}),
        },
      );
    },
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

  const readyzBind = readyzBindFromEnv(process.env);
  const readyzHttp = serveReadyz(fleet, readyzBind, (line) => io.err(line));

  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  io.err(
    `anvil: serving fleet of ${bundleIds.length} bundle(s) over stdio ` +
      `(${bundleIds.join(", ")}); /readyz on ${formatHostPort(readyzBind)}`,
  );
  // `connect` resolves once the transport is reading stdin, not when the
  // session ends: the fleet and /readyz stay up until it does.
  const transport = new StdioServerTransport();
  const ended = stdioSessionEnded(transport);
  await fleet.server.connect(transport);
  await ended;
  await fleet.server.close();
  readyzHttp.close();
  readyzHttp.closeAllConnections();
  await fleet.close();
  return 0;
}

/**
 * Resolves when a stdio MCP session is over: the transport closed, stdin ended
 * (`StdioServerTransport` never closes itself at end of input), or the process
 * was told to stop. End of input first waits for requests already read to be
 * answered, as the single-bundle server does; a signal or a closed transport
 * does not. Call it before `connect`, which chains an `onclose` and an
 * `onmessage` that are already set and leaves `send` as it finds it.
 */
export function stdioSessionEnded(
  transport: Pick<Transport, "onclose" | "onmessage" | "send">,
  stdin: NodeJS.ReadableStream = process.stdin,
): Promise<void> {
  return new Promise((resolve) => {
    const pending = new Set<unknown>();
    let draining = false;
    const end = () => {
      stdin.off("end", drain);
      stdin.off("close", drain);
      process.off("SIGTERM", end);
      process.off("SIGINT", end);
      resolve();
    };
    const drain = () => {
      draining = true;
      if (pending.size === 0) end();
    };
    const settle = (id: unknown) => {
      pending.delete(id);
      if (draining && pending.size === 0) end();
    };
    transport.onmessage = (message) => {
      if ("method" in message && "id" in message) pending.add(message.id);
      else if ("method" in message && message.method === "notifications/cancelled") {
        settle((message.params as { requestId?: unknown } | undefined)?.requestId);
      }
    };
    const send = transport.send.bind(transport);
    transport.send = async (message, options) => {
      await send(message, options);
      if (!("method" in message) && "id" in message) settle(message.id);
    };
    transport.onclose = end;
    stdin.on("end", drain);
    stdin.on("close", drain);
    process.on("SIGTERM", end);
    process.on("SIGINT", end);
  });
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
const DEFAULT_READYZ_HOST = "127.0.0.1";

export interface ReadyzBind {
  host: string;
  port: number;
}

/**
 * Where the stdio fleet's `/readyz` listens. The body names every bundle, its
 * tool count and its certification hash and the listener has no auth, so it is
 * loopback-only unless `ANVIL_FLEET_READYZ_HOST` (an IP address, such as
 * `0.0.0.0` for a container whose probe comes from outside) says otherwise.
 * Like the port, an unusable value falls back to the default.
 */
export function readyzBindFromEnv(env: NodeJS.ProcessEnv): ReadyzBind {
  return {
    host: parseReadyzHost(env.ANVIL_FLEET_READYZ_HOST),
    port: parseReadyzPort(env.ANVIL_FLEET_READYZ_PORT),
  };
}

function parseReadyzPort(raw: string | undefined): number {
  if (!raw) return DEFAULT_READYZ_PORT;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_READYZ_PORT;
}

function parseReadyzHost(raw: string | undefined): string {
  const host = raw?.trim();
  return host && isIP(host) !== 0 ? host : DEFAULT_READYZ_HOST;
}

function formatHostPort({ host, port }: ReadyzBind): string {
  return `${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
}

// Every spelling of a loopback bind address (127.0.0.0/8, ::1, ::ffff:127.0.0.1,
// 0000::1, ...), so an unusual one can't switch the Host check off.
const LOOPBACK = new BlockList();
LOOPBACK.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK.addAddress("::1", "ipv6");

/**
 * The stdio fleet's `/readyz` listener. A bind it cannot take (the port in use,
 * an address the host does not have) is reported through `log` and leaves the
 * MCP session running.
 */
export function serveReadyz(
  fleet: Pick<FleetServer, "readyz">,
  bind: ReadyzBind,
  log: (line: string) => void,
): Server {
  // On a loopback bind, loopback is the only gate, and DNS rebinding walks
  // around it (see serve-fleet-http.ts): answer only requests addressed to the
  // address and port this listener is on. A non-loopback bind serves a
  // container's probe, which may use any name.
  const loopbackOnly = LOOPBACK.check(bind.host, isIP(bind.host) === 6 ? "ipv6" : "ipv4");
  const http = createServer((req, res) => {
    if (loopbackOnly && !isOwnLoopbackHost(req.headers.host, req.socket.localPort)) {
      req.resume();
      json(res, 403, {
        error: {
          code: "host_not_allowed",
          message:
            "This listener answers only requests addressed to its own loopback address and port.",
        },
      });
      return;
    }
    if (req.url === "/readyz") {
      const body = fleet.readyz();
      res.writeHead(body.ready ? 200 : 503, {
        "content-type": "application/json",
        "x-content-type-options": "nosniff",
      });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404, { "content-type": "application/json", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify({ error: { code: "not_found", message: "Only /readyz is served." } }));
  });
  http.on("error", (error) => {
    log(`anvil: /readyz not served on ${formatHostPort(bind)}: ${error.message}`);
  });
  http.listen(bind.port, bind.host);
  return http;
}
