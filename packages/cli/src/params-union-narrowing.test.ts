import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AirDocument, Operation } from "@anvil/air";
import { approveOperations, compile } from "@anvil/compiler";
import { buildMcpServer, generateSdks } from "@anvil/generators";
import { type HttpResponse, MockTransport } from "@anvil/runtime";
import { Simulator, simulatorDefinitionFor } from "@anvil/simulator";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * A union input narrowed by manifest reaches every projection alike. The
 * fixture is a page write shaped like Confluence's v2 contract: `body` is a
 * oneOf of two alternatives that both accept any object, so a strict oneOf
 * refuses the storage body the service accepts. `createPage` is narrowed to
 * the flat alternative; `updatePage` is left as the source typed it.
 */
const fixtures = fileURLToPath(new URL("../../../examples/fixtures/", import.meta.url));
const SPEC = readFileSync(join(fixtures, "page-body-union.yaml"), "utf8");
const MANIFEST = [
  "operations:",
  "  createPage:",
  "    params:",
  "      body:",
  "        one_of: PageBodyWrite",
  "        properties: { representation: { enum: [storage] } }",
  "        required: [representation, value]",
  "  getPages:",
  "    params:",
  "      body-format: { one_of: 0 }",
].join("\n");

const STORAGE = { representation: "storage", value: "<p>Hello</p>" };
const NESTED = { storage: STORAGE };
const page = (body: unknown) => ({ spaceId: "S1", title: "Hello", body });

let air: AirDocument;
beforeAll(async () => {
  const compiled = await compile({ spec: SPEC, manifest: MANIFEST, serviceId: "pages" });
  air = approveOperations(
    compiled,
    compiled.operations.map((o) => o.id),
  );
});

const opNamed = (id: string) =>
  air.operations.find((o) => o.sourceRef.operationId === id) as Operation;

const ok = (body: unknown): HttpResponse => ({
  status: 200,
  headers: {},
  body: JSON.stringify(body),
});

async function served() {
  const transport = new MockTransport(() => ok({ id: "P-1" }));
  const server = buildMcpServer(air, {
    contextFor: () => ({
      transport,
      serviceId: air.service.id,
      baseUrl: "https://pages.example.com/wiki/api/v2",
      allowedHosts: ["pages.example.com"],
      env: "dev",
    }),
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
  await client.connect(clientT);
  return { client, requests: transport.requests };
}

describe("a union input narrowed by manifest, end to end", () => {
  it("an unnarrowed compile publishes no union member name in AIR or the MCP tool list", async () => {
    const plain = await compile({ spec: SPEC, serviceId: "pages" });
    const doc = approveOperations(
      plain,
      plain.operations.map((o) => o.id),
    );
    expect(JSON.stringify(doc)).not.toContain("x-anvil-component");
    const server = buildMcpServer(doc, {
      contextFor: () => ({
        transport: new MockTransport(() => ok({})),
        serviceId: doc.service.id,
        baseUrl: "https://pages.example.com/wiki/api/v2",
        allowedHosts: ["pages.example.com"],
        env: "dev",
      }),
    });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
    await client.connect(clientT);
    const tools = await client.listTools();
    expect(JSON.stringify(tools)).toContain("oneOf");
    expect(JSON.stringify(tools)).not.toContain("x-anvil-component");
    await client.close();
  });

  it("AIR records the narrowing and leaves the unnamed operation's union alone", () => {
    expect(opNamed("createPage").reviewNotes).toContain(
      "Input 'body' narrowed by manifest to oneOf[0] (PageBodyWrite).",
    );
    const update = opNamed("updatePage").input.body?.schema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(update.body?.oneOf).toHaveLength(2);
  });

  it("the served MCP tool accepts a storage body, refuses the nested form, and the unnarrowed tool still refuses", async () => {
    const { client, requests } = await served();
    const tools = await client.listTools();
    const schemaOf = (id: string) =>
      JSON.stringify(tools.tools.find((t) => t.name === opNamed(id).mcp.toolName)?.inputSchema);
    expect(schemaOf("createPage")).not.toContain("oneOf");
    // A one-value enum is re-emitted by the SDK as the equivalent `const`.
    expect(schemaOf("createPage")).toContain('"const":"storage"');
    expect(schemaOf("updatePage")).toContain("oneOf");
    // Union member names are compile-time bookkeeping: no published schema,
    // narrowed or not, carries one.
    expect(JSON.stringify(tools)).not.toContain("x-anvil-component");

    const call = (id: string, body: unknown, extra: Record<string, unknown> = {}) =>
      client.callTool({
        name: opNamed(id).mcp.toolName,
        arguments: { body: page(body), confirm: true, ...extra },
      });

    const accepted = await call("createPage", STORAGE);
    expect(accepted.isError).toBeFalsy();
    expect(requests).toHaveLength(1);
    expect(JSON.parse(String(requests[0]?.body)).body).toEqual(STORAGE);

    expect((await call("createPage", NESTED)).isError).toBe(true);
    expect((await call("updatePage", STORAGE, { id: "P-1" })).isError).toBe(true);
    // Neither refused call reached the wire.
    expect(requests).toHaveLength(1);
    await client.close();
  });

  it("the simulator agrees with the served tool", async () => {
    const sim = new Simulator(air, simulatorDefinitionFor(air), {
      provider: { invoke: () => ({ ok: true, result: { id: "P-1" } }) },
    });
    const call = (id: string, body: unknown, extra: Record<string, unknown> = {}) =>
      sim.invokeAsync(opNamed(id).mcp.toolName, { body: page(body), ...extra }, { confirm: true });
    expect(await call("createPage", STORAGE)).toMatchObject({ ok: true });
    expect(await call("createPage", NESTED)).toMatchObject({
      ok: false,
      error: { code: "validation_error" },
    });
    expect(await call("updatePage", STORAGE, { id: "P-1" })).toMatchObject({
      ok: false,
      error: { code: "validation_error" },
    });
  });

  it("the generated SDKs type a narrowed parameter as the alternative it took", () => {
    const files = generateSdks(air);
    expect(files["sdk/typescript/src/operations.ts"]).toContain(
      'body_format?: "storage" | "atlas_doc_format" | "view";',
    );
    expect(files["sdk/go/client.go"]).toContain(
      'BodyFormat *string `json:"body_format,omitempty"`',
    );
  });
});
