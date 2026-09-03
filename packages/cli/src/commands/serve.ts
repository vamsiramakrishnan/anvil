import { createServer } from "node:http";
import type { CertificationVerdict } from "@anvil/generators";
import type { FleetServer } from "@anvil/mcp-runtime";
import { loadAir } from "@anvil/refinement";
import type { Command } from "commander";
import type { CliIO } from "../io.js";
import type { CommandContext } from "./context.js";
import { measuredAccuracyFromReport } from "./ladder-status.js";
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

  const { buildFleetServer, fleetToolPrefix } = await import("@anvil/mcp-runtime");
  const { buildToolResources, readBundleDir, verifyCertification } = await import(
    "@anvil/generators"
  );
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
  // fallback of its own. `principalDirectoryConfigured` is the OTHER half of
  // that contract: it tells `execute()` whether `ANVIL_PRINCIPALS` names any
  // entries at all, so an unresolved `principal` here (mistyped/missing
  // `ANVIL_PRINCIPAL`, or a token the directory doesn't name) is refused
  // fail-closed instead of silently reproducing the anonymous default (see
  // `execute()`'s principal-resolution gate, `@anvil/runtime`).
  const principal = resolvePrincipalForEnv(config.principals, env);
  const principalDirectoryConfigured = Object.keys(config.principals).length > 0;
  const limits = buildLimitsGate(config.limits);

  const fleetInputs = bundles.map((bundle) => {
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
      options: {
        resources: buildToolResources(air),
        measuredAccuracy,
        contextFor: () => ({
          transport,
          serviceId: air.service.id,
          credentials,
          ledger,
          baseUrl,
          authProfile,
          allowedHosts,
          env: config.env,
          timeoutMs: config.upstreamTimeoutMs,
          principal,
          principalDirectoryConfigured,
          limits,
        }),
      },
      certification: files ? readCertification(files, verifyCertification) : undefined,
    };
  });

  try {
    const fleet = await buildFleetServer(fleetInputs, { name: "anvil-fleet", version: "0.1.0" });
    return { ok: true, fleet, bundleIds: bundles.map((b) => b.id) };
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
