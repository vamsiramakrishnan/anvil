import { type AirDocument, loadAirDocument, Operation } from "@anvil/air";
import type { Transport } from "@anvil/runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { buildFleetServer, FleetToolCollisionError, fleetToolName } from "./fleet.js";
import { buildMcpServer } from "./server.js";

const mockTransport: Transport = {
  send: async () => ({ status: 200, headers: {}, body: JSON.stringify({ ok: true }) }),
};

function op(overrides?: Partial<Operation>): Operation {
  return Operation.parse({
    id: "svc.op",
    canonicalName: "svc_op",
    displayName: "Op",
    sourceRef: { kind: "openapi", path: "/op", method: "get" },
    effect: { kind: "read", action: "list", resource: "thing", risk: "low", reversible: false },
    input: { params: [] },
    idempotency: { mode: "natural", mechanism: "none" },
    retries: { mode: "safe", maxAttempts: 3, backoff: "exponential", retryOn: ["timeout"] },
    confirmation: { required: false },
    auth: { type: "none", scopes: [] },
    cli: { command: "op" },
    mcp: { toolName: "svc_op" },
    skill: { intentExamples: [] },
    state: "approved",
    ...overrides,
  });
}

function airFor(serviceId: string, operation: Operation): AirDocument {
  return loadAirDocument({
    service: { id: serviceId, version: "1.0.0", source: { kind: "openapi" } },
    operations: [operation],
  });
}

async function listViaClient(server: Awaited<ReturnType<typeof buildFleetServer>>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  const listed = await client.listTools();
  await client.close();
  return listed.tools;
}

describe("buildFleetServer", () => {
  it("mounts each bundle's tools under a stable per-bundle prefix", async () => {
    const bundleA = {
      id: "billing",
      air: airFor("billing", op({ mcp: { toolName: "list_invoices" } })),
      options: {
        contextFor: () => ({
          transport: mockTransport,
          serviceId: "billing",
          baseUrl: "http://test",
        }),
      },
    };
    const bundleB = {
      id: "shipping",
      air: airFor("shipping", op({ id: "svc.op2", mcp: { toolName: "list_shipments" } })),
      options: {
        contextFor: () => ({
          transport: mockTransport,
          serviceId: "shipping",
          baseUrl: "http://test",
        }),
      },
    };

    const fleet = await buildFleetServer([bundleA, bundleB]);
    const tools = await listViaClient(fleet);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["billing__list_invoices", "shipping__list_shipments"]);
    expect(fleet.toolOwners.get("billing__list_invoices")).toBe("billing");
    expect(fleet.toolOwners.get("shipping__list_shipments")).toBe("shipping");
    await fleet.close();
  });

  it("refuses a cross-bundle tool-name collision, naming which two bundles collided", async () => {
    // Two distinct bundle directories that happen to fold to the same prefix
    // AND the same tool name — the one real way two bundles can collide once
    // discovery already guarantees distinct ids.
    const bundleA = {
      id: "svc",
      air: airFor("svc", op({ mcp: { toolName: "list_things" } })),
      options: {
        contextFor: () => ({ transport: mockTransport, serviceId: "svc", baseUrl: "http://test" }),
      },
    };
    const bundleB = {
      id: "svc!!", // folds to the same prefix "svc" as bundleA
      air: airFor("svc2", op({ mcp: { toolName: "list_things" } })),
      options: {
        contextFor: () => ({ transport: mockTransport, serviceId: "svc2", baseUrl: "http://test" }),
      },
    };

    await expect(buildFleetServer([bundleA, bundleB])).rejects.toThrow(FleetToolCollisionError);
    await expect(buildFleetServer([bundleA, bundleB])).rejects.toMatchObject({
      toolName: fleetToolName("svc", "list_things"),
      existingBundleId: "svc",
      incomingBundleId: "svc!!",
    });
  });

  it("refuses a duplicate bundle id before building anything", async () => {
    const bundle = {
      id: "dup",
      air: airFor("dup", op()),
      options: {
        contextFor: () => ({ transport: mockTransport, serviceId: "dup", baseUrl: "http://test" }),
      },
    };
    await expect(buildFleetServer([bundle, bundle])).rejects.toThrow(/Duplicate bundle id/);
  });

  it("reports per-bundle certified hashes in readyz, folding to ready:false if any bundle isn't certified passed", async () => {
    const bundleA = {
      id: "billing",
      air: airFor("billing", op({ mcp: { toolName: "list_invoices" } })),
      options: {
        contextFor: () => ({
          transport: mockTransport,
          serviceId: "billing",
          baseUrl: "http://test",
        }),
      },
      certification: { hash: "sha256:aaa", status: "passed" as const },
    };
    const bundleB = {
      id: "shipping",
      air: airFor("shipping", op({ id: "svc.op2", mcp: { toolName: "list_shipments" } })),
      options: {
        contextFor: () => ({
          transport: mockTransport,
          serviceId: "shipping",
          baseUrl: "http://test",
        }),
      },
      // Uncertified — the fleet should still build, but readyz must say so.
    };

    const fleet = await buildFleetServer([bundleA, bundleB]);
    const readyz = fleet.readyz();
    expect(readyz.ready).toBe(false);
    expect(readyz.bundles).toEqual([
      {
        id: "billing",
        serviceId: "billing",
        toolCount: 1,
        certifiedHash: "sha256:aaa",
        certificationStatus: "passed",
        ready: true,
      },
      {
        id: "shipping",
        serviceId: "shipping",
        toolCount: 1,
        certifiedHash: undefined,
        certificationStatus: undefined,
        ready: false,
      },
    ]);
    await fleet.close();
  });

  it("readyz is ready:true only when every mounted bundle is certified passed", async () => {
    const bundleA = {
      id: "billing",
      air: airFor("billing", op({ mcp: { toolName: "list_invoices" } })),
      options: {
        contextFor: () => ({
          transport: mockTransport,
          serviceId: "billing",
          baseUrl: "http://test",
        }),
      },
      certification: { hash: "sha256:aaa", status: "passed" as const },
    };
    const fleet = await buildFleetServer([bundleA]);
    expect(fleet.readyz().ready).toBe(true);
    await fleet.close();
  });

  it("a call through the fleet reaches the same underlying operation a single-bundle server would", async () => {
    let sawUrl: string | undefined;
    const transport: Transport = {
      send: async (req) => {
        sawUrl = req.url;
        return { status: 200, headers: {}, body: JSON.stringify({ items: [1, 2, 3] }) };
      },
    };
    const bundle = {
      id: "billing",
      air: airFor("billing", op({ mcp: { toolName: "list_invoices" } })),
      options: {
        contextFor: () => ({
          transport,
          serviceId: "billing",
          baseUrl: "https://billing.internal",
          env: "dev",
        }),
      },
    };
    const fleet = await buildFleetServer([bundle]);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await fleet.server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientTransport);
    // A single-bundle fleet mounts under the bundle's OWN tool name — no
    // prefix, since there is nothing to disambiguate (see fleet.ts's doc).
    const result = await client.callTool({ name: "list_invoices", arguments: {} });
    expect(sawUrl).toBe("https://billing.internal/op");
    expect(result.isError).not.toBe(true);
    await client.close();
    await fleet.close();
  });

  it("rejects an empty fleet", async () => {
    await expect(buildFleetServer([])).rejects.toThrow(/at least one bundle/);
  });

  it("a single-bundle fleet answers tools/list and tools/call byte-identically to the same bundle served alone", async () => {
    // The doc comment at the top of this file claims a bundle served through
    // the fleet answers byte-identically to the same bundle served alone.
    // This is the test that actually holds that claim to its word: build the
    // SAME air document, with the SAME options, both ways — once through
    // `buildMcpServer` directly (the single-bundle serving path this module
    // says it never touches), once through `buildFleetServer` with that one
    // bundle and no principal/limit options — and diff the FULL raw wire
    // response objects, tool names included. No excluded fields, no
    // `.toMatchObject` subset check.
    //
    // `tools/list` is compared with `toEqual` (full recursive structural
    // equality — every key, every value, nothing excluded) rather than
    // `JSON.stringify` string equality, for one documented reason: this
    // module's `tools/list` handler reads a tool's `inputSchema` back
    // through a real `Client` (`jsonSchemaShapeFor`, see fleet.ts), so it is
    // round-tripped JSON-Schema -> zod -> JSON-Schema by the MCP SDK before
    // it reaches a fleet caller. That round trip is not guaranteed to
    // preserve JSON property key ORDER — proven by running this test with a
    // literal `JSON.stringify` compare first: the only diff it ever produces
    // is `{"type":..,"description":..}` vs `{"description":..,"type":..}`
    // inside `inputSchema.properties`, never a missing/extra/different
    // value anywhere in either response. `toEqual` is not a weaker check —
    // it still compares every field of the full response, tool names
    // included — it is the correct check for "the same JSON value," which
    // key-insertion-order was never part of. `tools/call` below still gets
    // a literal `JSON.stringify` compare: a `CallToolResult` carries no
    // schema to round-trip, so nothing should differ there at all.
    const transport: Transport = {
      send: async () => ({ status: 200, headers: {}, body: JSON.stringify({ items: [1, 2, 3] }) }),
    };
    const air = airFor("billing", op({ mcp: { toolName: "list_invoices" } }));
    const options = {
      contextFor: () => ({
        transport,
        serviceId: "billing",
        baseUrl: "https://billing.internal",
        env: "dev",
      }),
    };

    // Standalone: exactly `anvil serve mcp <dir>` without --fleet.
    const standalone = buildMcpServer(air, options);
    const standaloneTransports = InMemoryTransport.createLinkedPair();
    await standalone.connect(standaloneTransports[1]);
    const standaloneClient = new Client({ name: "test-client", version: "0.0.0" });
    await standaloneClient.connect(standaloneTransports[0]);

    // Through the fleet, with that one bundle and nothing else configured.
    const fleet = await buildFleetServer([{ id: "billing", air, options }]);
    const fleetTransports = InMemoryTransport.createLinkedPair();
    await fleet.server.connect(fleetTransports[1]);
    const fleetClient = new Client({ name: "test-client", version: "0.0.0" });
    await fleetClient.connect(fleetTransports[0]);

    const standaloneList = await standaloneClient.listTools();
    const fleetList = await fleetClient.listTools();
    expect(fleetList).toEqual(standaloneList);

    const toolName = standaloneList.tools[0]?.name;
    const standaloneCall = await standaloneClient.callTool({ name: toolName ?? "", arguments: {} });
    const fleetCall = await fleetClient.callTool({ name: toolName ?? "", arguments: {} });
    expect(JSON.stringify(fleetCall)).toBe(JSON.stringify(standaloneCall));

    await standaloneClient.close();
    await standalone.close();
    await fleetClient.close();
    await fleet.close();
  });
});

describe("fleetToolName", () => {
  it("folds unsafe characters in the bundle id and joins with a stable separator", () => {
    expect(fleetToolName("payments/v2", "list_orders")).toBe("payments_v2__list_orders");
  });
});
