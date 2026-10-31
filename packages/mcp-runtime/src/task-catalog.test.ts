import { readFileSync } from "node:fs";
import { AirDocument } from "@anvil/air";
import { MockTransport } from "@anvil/runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { buildMcpServer } from "./server.js";
import { taskCatalog } from "./task-catalog.js";

function fixture() {
  const air = AirDocument.parse(
    JSON.parse(
      readFileSync(
        new URL("../../../examples/business/sources/orders.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  air.operations = [air.operations[0]!];
  air.operations[0]!.auth.scopes = ["orders:read"];
  const second = structuredClone(air.operations[0]!);
  Object.assign(second, {
    id: "private",
    canonicalName: "secret_financial_lookup",
    mcp: { toolName: "private" },
    auth: { ...second.auth, scopes: ["finance:read"] },
  });
  air.operations.push(second);
  return air;
}
const options = {
  query: "order lookup",
  principal: { id: "user", scopes: ["orders:read"] },
  maxTokens: 1000,
  dynamicLists: true,
};
describe("task-scoped discovery", () => {
  it("filters authority before ranking and distinguishes a flat client fallback", () => {
    const air = fixture();
    const result = taskCatalog(air, options);
    expect(result.authorizedIds).toEqual(["raw_order_lookup"]);
    expect(JSON.stringify(result.operations)).not.toContain("secret_financial");
    expect(
      taskCatalog(air, { ...options, principal: { ...options.principal, grants: [] } }).operations,
    ).toEqual([]);
    air.operations[0]!.description = "x".repeat(1000);
    expect(taskCatalog(air, { ...options, maxTokens: 128 }).operations).toEqual([]);
    expect(taskCatalog(air, { ...options, maxTokens: 128, dynamicLists: false })).toMatchObject({
      reason: "client-flat-fallback",
      operations: [air.operations[0]],
    });
    expect(taskCatalog(air, { ...options, query: "different" }).digest).not.toBe(result.digest);
  });
  it("serves only the scoped catalog and still rejects calls after authority is revoked", async () => {
    const principal = { ...options.principal };
    const transport = new MockTransport(() => ({ status: 200, headers: {}, body: "{}" }));
    const server = buildMcpServer(fixture(), {
      taskCatalog: options,
      contextFor: () => ({
        serviceId: "orders",
        baseUrl: "https://orders.example",
        allowedHosts: ["orders.example"],
        transport,
        env: "dev",
        principal,
      }),
    });
    const client = new Client({ name: "catalog-test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["raw_order_lookup"]);
      principal.scopes = [];
      const result = await client.callTool({
        name: "raw_order_lookup",
        arguments: { opaque_order_ref: "order-1" },
      });
      expect(result.isError).toBe(true);
      expect(transport.requests).toHaveLength(0);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
