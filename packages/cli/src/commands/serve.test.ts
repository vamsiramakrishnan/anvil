import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { airToJson, Capability, loadAirDocument, Operation } from "@anvil/air";
import { bundleHash, readBundleDir } from "@anvil/generators";
import type { FleetServer } from "@anvil/mcp-runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { buildFleetForWorkspace } from "./serve.js";

/**
 * `--fleet` builds real bundle fixtures on disk (not through the full
 * `anvil compile` pipeline — this exercises `buildFleetForWorkspace`'s own
 * discovery/certification-reading/composition, not the compiler) so it stays
 * fast while still going through `discoverBundles` and a real `air.json`
 * exactly as a deployed workspace would.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function op(overrides: Record<string, unknown> = {}): Operation {
  return Operation.parse({
    id: "svc.list",
    canonicalName: "list_things",
    displayName: "List things",
    sourceRef: { kind: "openapi", path: "/things", method: "get" },
    effect: { kind: "read", action: "list", resource: "thing", risk: "low", reversible: false },
    input: { params: [] },
    idempotency: { mode: "natural", mechanism: "none" },
    retries: { mode: "safe", maxAttempts: 3, backoff: "exponential", retryOn: ["timeout"] },
    confirmation: { required: false },
    auth: { type: "none", scopes: [] },
    cli: { command: "things list" },
    mcp: { toolName: "list_things" },
    skill: { intentExamples: [] },
    state: "approved",
    ...overrides,
  });
}

function writeBundle(dir: string, serviceId: string, toolName: string): void {
  mkdirSync(dir, { recursive: true });
  const air = loadAirDocument({
    service: { id: serviceId, version: "1.0.0", source: { kind: "openapi" } },
    operations: [op({ id: `${serviceId}.list`, mcp: { toolName } })],
  });
  writeFileSync(join(dir, "air.json"), airToJson(air), "utf8");
}

/** A bundle whose one operation requires `api_key` auth under a security
 *  scheme named "oauth" — the exact shape two independently-sourced services
 *  can share, which is what finding #2's credential-namespacing bug is about. */
function writeAuthedBundle(dir: string, serviceId: string, toolName: string): void {
  mkdirSync(dir, { recursive: true });
  const air = loadAirDocument({
    service: {
      id: serviceId,
      version: "1.0.0",
      source: { kind: "openapi" },
      servers: [{ url: `https://${serviceId}.internal.example.com` }],
    },
    operations: [
      op({
        id: `${serviceId}.list`,
        mcp: { toolName },
        auth: { type: "api_key", scopes: [], credentialProfile: "oauth" },
      }),
    ],
  });
  writeFileSync(join(dir, "air.json"), airToJson(air), "utf8");
}

const DISCLOSURE_COST = {
  toolTokens: 5_000,
  responseItemTokens: 0,
  responseTokens: 0,
  charsPerToken: 4,
  estimator: "o200k_base",
};

function ladderOp(id: string): Operation {
  return Operation.parse({
    id,
    canonicalName: id.replace(/\./g, "_"),
    displayName: id,
    sourceRef: { kind: "openapi", path: `/${id}`, method: "get" },
    effect: { kind: "read", action: "list", resource: "thing", risk: "low", reversible: false },
    input: { params: [] },
    idempotency: {
      mode: "none",
      mechanism: "header",
      key: "Idempotency-Key",
      keyDerivation: "client_supplied",
    },
    retries: { mode: "safe", maxAttempts: 1, backoff: "exponential", retryOn: ["timeout"] },
    confirmation: { required: false },
    auth: { type: "none", scopes: [] },
    cli: { command: id },
    mcp: { toolName: id.replace(/\./g, "_") },
    skill: { intentExamples: [] },
    state: "approved",
    disclosureCost: DISCLOSURE_COST,
  });
}

function ladderCapability(id: string, operationIds: string[]): Capability {
  return Capability.parse({
    id,
    displayName: id,
    description: `Everything about ${id}`,
    operationIds,
    intentExamples: [`work with ${id}`],
    lifecycle: "approved",
  });
}

/**
 * Seven measured operations across three capabilities — the exact shape
 * `packages/mcp-runtime/src/lane.test.ts`'s `estateWithThreeLanes()` uses for
 * "the measured-accuracy decision" cases: 7 * 5,000 = 35,000 disclosure
 * tokens, over the 20,000-token default surface budget (`@anvil/air`'s
 * `DEFAULT_SURFACE_DISCLOSURE_BUDGET_TOKENS`), so `auto` mode ladders by
 * default (3 lane-entry tools) — clearing the token-savings floor
 * unconditionally (proven by that same fixture in lane.test.ts), so only a
 * measured accuracy delta below the floor can push it back to flat (7 tools).
 */
function writeLadderableBundle(dir: string, serviceId: string): void {
  mkdirSync(dir, { recursive: true });
  const air = loadAirDocument({
    service: { id: serviceId, version: "1.0.0", source: { kind: "openapi" } },
    operations: [
      ladderOp("billing.invoice.list"),
      ladderOp("billing.invoice.get"),
      ladderOp("billing.invoice.void"),
      ladderOp("users.user.list"),
      ladderOp("users.user.get"),
      ladderOp("reports.report.list"),
      ladderOp("reports.report.get"),
    ],
    capabilities: [
      ladderCapability("billing.invoices", [
        "billing.invoice.list",
        "billing.invoice.get",
        "billing.invoice.void",
      ]),
      ladderCapability("users.users", ["users.user.list", "users.user.get"]),
      ladderCapability("reports.reports", ["reports.report.list", "reports.report.get"]),
    ],
    workflows: [],
  });
  writeFileSync(join(dir, "air.json"), airToJson(air), "utf8");
}

/** A minimally valid `benchmark.report.json` whose laddered-vs-flat accuracy
 *  delta clears the `-8` floor when `flatAccuracy`/`ladderedAccuracy` are
 *  supplied, so a test can dial the delta without repeating every field. */
function writeBenchmarkReport(
  dir: string,
  hash: string,
  flatAccuracy: number,
  ladderedAccuracy: number,
): void {
  const report = {
    schemaVersion: 2,
    router: "test",
    catalogSize: 7,
    operations: [],
    confusion: {
      posture: "candidate",
      minClusterEvidence: 0,
      hubPartnerFraction: 0,
      hubMinPartners: 0,
      hubs: [],
      clusters: [],
    },
    summary: { total: 10, passed: 9, score: 0.9, curatedRouted: 9, bareRouted: 5, upliftPts: 40 },
    catalogs: {
      flat: { total: 10, passed: 9, accuracy: flatAccuracy, upliftPts: 40 },
      laddered: { total: 10, passed: 5, accuracy: ladderedAccuracy, upliftPts: 0 },
    },
    bundleHash: hash,
  };
  writeFileSync(join(dir, "benchmark.report.json"), JSON.stringify(report), "utf8");
}

function workspaceRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "anvil-fleet-cli-"));
  roots.push(root);
  return root;
}

/** Connect a real MCP client to a built fleet's own server over an in-process
 *  transport pair — the same wire contract a remote fleet caller uses. */
async function connectClient(fleet: FleetServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await fleet.server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

describe("buildFleetForWorkspace", () => {
  it("discovers every bundle beneath the workspace root and mounts them all", async () => {
    const root = workspaceRoot();
    writeBundle(join(root, "billing"), "billing", "list_invoices");
    writeBundle(join(root, "shipping"), "shipping", "list_shipments");

    const built = await buildFleetForWorkspace(root, {});
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error("unreachable");
    expect(built.bundleIds.sort()).toEqual(["billing", "shipping"]);
    const readyz = built.fleet.readyz();
    expect(readyz.bundles.map((b) => b.id).sort()).toEqual(["billing", "shipping"]);
    await built.fleet.close();
  });

  it("reads and verifies each bundle's own certification.json into readyz, uncertified bundles report ready:false", async () => {
    const root = workspaceRoot();
    const billingDir = join(root, "billing");
    writeBundle(billingDir, "billing", "list_invoices");
    // The certification binds to the bundle's REAL current content hash —
    // this is the exact freshness check finding #4 is about, so a fabricated
    // hash (as an earlier version of this test used) would now correctly
    // report `ready:false`, not `ready:true`.
    const hash = bundleHash(readBundleDir(billingDir));
    writeFileSync(
      join(billingDir, "certification.json"),
      JSON.stringify({
        schemaVersion: 1,
        serviceId: "billing",
        bundleHash: hash,
        assuranceLevel: "static",
        status: "passed",
        checks: [],
        certifiedAt: new Date().toISOString(),
      }),
      "utf8",
    );

    const built = await buildFleetForWorkspace(root, {});
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error("unreachable");
    const readyz = built.fleet.readyz();
    expect(readyz.ready).toBe(true);
    expect(readyz.bundles).toEqual([
      {
        id: "billing",
        serviceId: "billing",
        toolCount: 1,
        certifiedHash: hash,
        certificationStatus: "passed",
        ready: true,
      },
    ]);
    await built.fleet.close();
  });

  it("refuses (without throwing) when the workspace has no bundles", async () => {
    const root = workspaceRoot();
    const built = await buildFleetForWorkspace(root, {});
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error("unreachable");
    expect(built.message).toMatch(/no bundles found/);
  });

  it("surfaces a cross-bundle tool collision as a failure result, not a throw out of the CLI", async () => {
    const root = workspaceRoot();
    // Two distinct bundle ids that fold to the same prefix and mount the same
    // tool name underneath it.
    writeBundle(join(root, "svc"), "svc-a", "list_things");
    writeBundle(join(root, "svc!!"), "svc-b", "list_things");

    const built = await buildFleetForWorkspace(root, {});
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error("unreachable");
    expect(built.message).toMatch(/collision/);
  });

  it("resolves the configured principal for the whole session from ANVIL_PRINCIPAL", async () => {
    const root = workspaceRoot();
    writeBundle(join(root, "billing"), "billing", "list_invoices");
    const built = await buildFleetForWorkspace(root, {
      ANVIL_PRINCIPALS: "tok_abc:alice:orders.read",
      ANVIL_PRINCIPAL: "tok_abc",
    });
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error("unreachable");
    await built.fleet.close();
  });

  describe("finding #4 — certification freshness (fleet.ts ~255)", () => {
    it("reports a bundle NOT ready, with a reason, once a compiler-owned file changes after certification", async () => {
      const root = workspaceRoot();
      const billingDir = join(root, "billing");
      writeBundle(billingDir, "billing", "list_invoices");
      const hash = bundleHash(readBundleDir(billingDir));
      writeFileSync(
        join(billingDir, "certification.json"),
        JSON.stringify({
          schemaVersion: 1,
          serviceId: "billing",
          bundleHash: hash,
          assuranceLevel: "static",
          status: "passed",
          checks: [],
          certifiedAt: new Date().toISOString(),
        }),
        "utf8",
      );

      // Baseline: fresh certification -> ready.
      const fresh = await buildFleetForWorkspace(root, {});
      expect(fresh.ok).toBe(true);
      if (!fresh.ok) throw new Error("unreachable");
      expect(fresh.fleet.readyz().ready).toBe(true);
      await fresh.fleet.close();

      // Edit a compiler-owned file (air.json) AFTER certifying — the
      // certification.json on disk still claims `status: "passed"` at the
      // OLD hash, exactly the "stale, copied, or mismatched certification"
      // finding #4 describes.
      writeFileSync(
        join(billingDir, "air.json"),
        readBundleDir(billingDir)["air.json"]?.replace("1.0.0", "1.0.1") ?? "",
        "utf8",
      );

      const stale = await buildFleetForWorkspace(root, {});
      expect(stale.ok).toBe(true);
      if (!stale.ok) throw new Error("unreachable");
      const readyz = stale.fleet.readyz();
      expect(readyz.ready).toBe(false);
      expect(readyz.bundles[0]?.ready).toBe(false);
      expect(readyz.bundles[0]?.certificationStatus).toBe("passed");
      expect(readyz.bundles[0]?.reason).toMatch(/stale/i);
      await stale.fleet.close();
    });
  });

  describe("finding #1 — unresolved principal refused when a directory is configured (serve.ts ~145)", () => {
    it("refuses a call whose credential does not resolve, rather than granting the anonymous every-scope principal", async () => {
      const root = workspaceRoot();
      writeBundle(join(root, "billing"), "billing", "list_invoices");
      const built = await buildFleetForWorkspace(root, {
        ANVIL_PRINCIPALS: "tok_abc:alice:orders.read",
        // A directory IS configured, but this session's own credential
        // (mistyped, or simply the wrong one) is not in it.
        ANVIL_PRINCIPAL: "tok_wrong",
      });
      expect(built.ok).toBe(true);
      if (!built.ok) throw new Error("unreachable");

      const client = await connectClient(built.fleet);
      const result = await client.callTool({ name: "list_invoices", arguments: {} });
      await client.close();
      await built.fleet.close();

      expect(result.isError).toBe(true);
      const text = JSON.stringify(result.content);
      expect(text).toContain("policy/principal_unresolved");
      expect(text).not.toContain('"anonymous"');
      expect(text).toContain("policy_denied");
    });

    it("still resolves the anonymous every-scope principal when NO directory is configured at all", async () => {
      const root = workspaceRoot();
      writeBundle(join(root, "billing"), "billing", "list_invoices");
      const built = await buildFleetForWorkspace(root, {});
      expect(built.ok).toBe(true);
      if (!built.ok) throw new Error("unreachable");

      const client = await connectClient(built.fleet);
      const result = await client.callTool({ name: "list_invoices", arguments: {} });
      await client.close();
      await built.fleet.close();

      // The one op here has `auth.type: "none"`, so this either succeeds or
      // fails on the network call this test never mocks a transport for —
      // either way, it must NOT be the policy refusal finding #1 adds.
      const text = JSON.stringify(result.content ?? {});
      expect(text).not.toContain("policy/principal_unresolved");
    });
  });

  describe("finding #2 — credentials namespaced per bundle (serve.ts ~163)", () => {
    it("resolves DISTINCT env-var names for two bundles whose security schemes share a name", async () => {
      const root = workspaceRoot();
      writeAuthedBundle(join(root, "billing"), "billing", "list_invoices");
      writeAuthedBundle(join(root, "shipping"), "shipping", "list_shipments");

      // dev: an unset allowlist permits any host, so the call reaches the
      // auth gate (the one under test) rather than refusing earlier on the
      // host allowlist, which every bundle here leaves unconfigured.
      const built = await buildFleetForWorkspace(root, { ANVIL_ENV: "dev" });
      expect(built.ok).toBe(true);
      if (!built.ok) throw new Error("unreachable");

      const client = await connectClient(built.fleet);
      // Neither bundle has its ANVIL_*_API_KEY set, so both calls refuse
      // with `auth_required`, naming the exact env var(s) they expected.
      const billing = await client.callTool({
        name: "billing__list_invoices",
        arguments: {},
      });
      const shipping = await client.callTool({
        name: "shipping__list_shipments",
        arguments: {},
      });
      await client.close();
      await built.fleet.close();

      expect(billing.isError).toBe(true);
      expect(shipping.isError).toBe(true);
      const billingText = JSON.stringify(billing.content);
      const shippingText = JSON.stringify(shipping.content);
      // Both bundles declare the SAME security-scheme name ("oauth"), so a
      // namespace collapsed to only the scheme suffix would name the SAME
      // env var for both — this is the exact bug finding #2 reports.
      expect(billingText).not.toBe(shippingText);
      expect(billingText).toContain("BILLING");
      expect(billingText).not.toContain("SHIPPING");
      expect(shippingText).toContain("SHIPPING");
      expect(shippingText).not.toContain("BILLING");
    });

    it("keeps a single-bundle fleet's authProfile byte-identical to a bundle served without --fleet", async () => {
      const root = workspaceRoot();
      writeAuthedBundle(join(root, "billing"), "billing", "list_invoices");
      const built = await buildFleetForWorkspace(root, { ANVIL_ENV: "dev" });
      expect(built.ok).toBe(true);
      if (!built.ok) throw new Error("unreachable");

      const client = await connectClient(built.fleet);
      const result = await client.callTool({ name: "list_invoices", arguments: {} });
      await client.close();
      await built.fleet.close();

      expect(result.isError).toBe(true);
      const text = JSON.stringify(result.content);
      // With nothing to disambiguate, the profile is the bare deployment
      // default plus only the security-SCHEME suffix -- no bundle id folded
      // in -- exactly what `credentialProfileName("default", auth)` would
      // produce for the SAME operation served without --fleet.
      expect(text).toContain("DEFAULT_OAUTH_API_KEY");
      expect(text).not.toContain("BILLING");
    });
  });

  describe("finding #3 — benchmarked ladder decisions apply under --fleet (serve.ts ~157)", () => {
    it("ladders by default (auto, no report) when the projected surface is over budget", async () => {
      const root = workspaceRoot();
      const dir = join(root, "billing");
      writeLadderableBundle(dir, "billing");

      const built = await buildFleetForWorkspace(root, {});
      expect(built.ok).toBe(true);
      if (!built.ok) throw new Error("unreachable");
      const client = await connectClient(built.fleet);
      const tools = await client.listTools();
      await client.close();
      await built.fleet.close();

      // 3 lane-entry cards, not the 7 individual operation tools.
      expect(tools.tools.length).toBe(3);
    });

    it("serves flat under --fleet when this bundle's OWN benchmark report measures accuracy below the floor", async () => {
      const root = workspaceRoot();
      const dir = join(root, "billing");
      writeLadderableBundle(dir, "billing");
      const hash = bundleHash(readBundleDir(dir));
      // laddered (50) - flat (90) = -40, well below the -8 floor
      // (`MIN_LADDERED_ACCURACY_DELTA_PTS`, `@anvil/mcp-runtime`'s `lane.ts`).
      writeBenchmarkReport(dir, hash, 90, 50);

      const built = await buildFleetForWorkspace(root, {});
      expect(built.ok).toBe(true);
      if (!built.ok) throw new Error("unreachable");
      const client = await connectClient(built.fleet);
      const tools = await client.listTools();
      await client.close();
      await built.fleet.close();

      // Flat: all 7 individual operation tools, not 3 lane cards -- the
      // exact behavior `anvil serve mcp` (no --fleet) would already show for
      // the same bundle and report; before finding #3's fix, --fleet never
      // read this report at all and always laddered here.
      expect(tools.tools.length).toBe(7);
    });
  });
});
