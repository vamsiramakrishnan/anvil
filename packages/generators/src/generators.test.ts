import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type AirDocument, loadAirDocument } from "@anvil/air";
import { compile } from "@anvil/compiler";
import { MockTransport } from "@anvil/runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it } from "vitest";
import { generateBundle } from "./bundle.js";
import { buildMcpServer } from "./mcp.js";
import { buildToolResources } from "./resources.js";

const read = (rel: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../../examples/payments/${rel}`, import.meta.url)),
    "utf8",
  );

let air: AirDocument;

beforeAll(async () => {
  air = await compile({
    spec: read("openapi.yaml"),
    manifest: read("anvil.yaml"),
    serviceId: "payments",
  });
});

async function connect(server: ReturnType<typeof buildMcpServer>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("MCP server", () => {
  it("exposes one tool per approved operation with risk-visible metadata", async () => {
    const server = buildMcpServer(air, {
      contextFor: () => ({
        transport: new MockTransport(() => ({ status: 200, headers: {}, body: "{}" })),
        baseUrl: "https://payments.internal.example.com",
        allowedHosts: ["payments.internal.example.com"],
        env: "prod",
      }),
    });
    const client = await connect(server);
    const { tools } = await client.listTools();
    const refund = tools.find((t) => t.name === "payments_create_refund");
    expect(refund).toBeDefined();
    expect(refund?.annotations?.destructiveHint).toBe(true);
    expect(refund?.annotations?.readOnlyHint).toBe(false);
    expect(refund?.description).toMatch(/irreversible|idempotency|confirm/i);
    // Input schema requires the safety fields.
    expect(refund?.inputSchema.required).toEqual(
      expect.arrayContaining(["payment_id", "amount", "currency", "idempotency_key", "confirm"]),
    );
    await client.close();
  });

  it("refuses an unsafe call without confirm, and executes with it", async () => {
    const transport = new MockTransport(() => ({
      status: 201,
      headers: {},
      body: JSON.stringify({ id: "re_1" }),
    }));
    const credentials = {
      async resolve() {
        return { headers: { Authorization: "Bearer t" } };
      },
    };
    const server = buildMcpServer(air, {
      contextFor: () => ({
        transport,
        credentials,
        authProfile: "prod",
        baseUrl: "https://payments.internal.example.com",
        allowedHosts: ["payments.internal.example.com"],
        env: "prod",
      }),
    });
    const client = await connect(server);

    // The tool's input schema makes confirm a required `const: true`, so the MCP
    // layer refuses a call without confirmation before it can reach upstream.
    const refused = await client.callTool({
      name: "payments_create_refund",
      arguments: {
        payment_id: "pay_1",
        amount: 2500,
        currency: "USD",
        idempotency_key: "k1",
        confirm: false,
      },
    });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toMatch(/confirm/i);
    expect(transport.requests).toHaveLength(0);

    const ok = await client.callTool({
      name: "payments_create_refund",
      arguments: {
        payment_id: "pay_1",
        amount: 2500,
        currency: "USD",
        idempotency_key: "k1",
        confirm: true,
      },
    });
    expect(ok.isError).toBeFalsy();
    expect(transport.requests).toHaveLength(1);
    await client.close();
  });

  it("serves the skill and CLI install manifest as MCP resources", async () => {
    const server = buildMcpServer(air, {
      contextFor: () => ({
        transport: new MockTransport(() => ({ status: 200, headers: {}, body: "{}" })),
        baseUrl: "https://payments.internal.example.com",
        allowedHosts: ["payments.internal.example.com"],
        env: "prod",
      }),
      resourceOptions: { mcpEndpoint: "https://payments-tools.run.app/mcp" },
    });
    const client = await connect(server);
    const { resources } = await client.listResources();
    const skill = resources.find((r) => r.uri === "anvil://skill/payments/SKILL.md");
    const cli = resources.find((r) => r.uri === "anvil://cli/payments/install.json");
    expect(skill).toBeDefined();
    expect(cli).toBeDefined();

    const skillRead = await client.readResource({ uri: "anvil://skill/payments/SKILL.md" });
    expect(skillRead.contents[0]?.text).toContain("Safety rules");
    const cliRead = await client.readResource({ uri: "anvil://cli/payments/install.json" });
    expect(cliRead.contents[0]?.text).toContain("payments-tools.run.app/mcp");
    await client.close();
  });
});

describe("resources", () => {
  it("marks SKILL.md for the assistant audience with high priority", () => {
    const resources = buildToolResources(air);
    const skill = resources.find((r) => r.uri === "anvil://skill/payments/SKILL.md");
    expect(skill?.audience).toContain("assistant");
    expect(skill?.priority).toBeGreaterThan(0.9);
  });
});

describe("bundle", () => {
  it("emits every aligned artifact from one AIR", () => {
    const { files } = generateBundle(air);
    const paths = Object.keys(files);
    for (const expected of [
      "air.yaml",
      "air.json",
      "catalog.json",
      "cli/payments.mjs",
      "mcp/server.js",
      "runtime/server.js",
      "runtime/operations.manifest.json",
      "skill/SKILL.md",
      "skill/reference/operations.md",
      "deploy/Dockerfile",
      "deploy/cloudrun.service.yaml",
      "mock/scenarios.json",
      "tests/conformance.test.ts",
      "package.json",
    ]) {
      expect(paths, `missing ${expected}`).toContain(expected);
    }
  });

  it("compiles only approved operations into the runtime manifest", () => {
    const { files } = generateBundle(air);
    const manifest = JSON.parse(files["runtime/operations.manifest.json"] as string);
    const approved = air.operations.filter((o) => o.state === "approved").length;
    expect(manifest.operations).toHaveLength(approved);
    // The refund must keep its confirmation + idempotency contract post-compile.
    const refund = manifest.operations.find((o: { id: string }) => o.id.includes("refund"));
    expect(refund.confirmation.required).toBe(true);
    expect(refund.idempotency.mode).toBe("required");
  });

  it("generates a conformance test asserting the safety contract", () => {
    const { files } = generateBundle(air);
    const test = files["tests/conformance.test.ts"] as string;
    expect(test).toContain("requires confirmation");
    expect(test).toContain("never auto-retries");
  });
});

// Keep the loader import meaningful for downstream consumers.
void loadAirDocument;
