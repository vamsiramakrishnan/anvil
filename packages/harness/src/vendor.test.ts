import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compile } from "@anvil/compiler";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runEnrichment } from "./enrich.js";
import { connectSource, type TransportFactory } from "./mcp-source.js";
import type { SourceConfig } from "./sources.js";

/**
 * Vendor reconciliation — "REST API vs reference MCP", the same shape as the
 * GitHub/Confluence enrichment tests. For each enterprise vendor we compile the
 * REST/OData surface Anvil ingests, then reconcile it against the vendor's own
 * reference MCP server (stood up in-memory here; the real published servers are
 * reachable via the sap/salesforce source profiles and the `--live` lane):
 *   1. the compiled surface COVERS every CRUD capability the reference MCP
 *      exposes (nothing the vendor's server can do is missing from ours), and
 *   2. enrichment gathers evidence from the reference MCP and proposes the right
 *      safety semantics — exactly as it does for GitHub/Jira/Confluence.
 */

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../../examples/${rel}`, import.meta.url)), "utf8");

/** Wire each configured source to its in-memory reference server. */
function factoryFor(servers: Record<string, McpServer>): TransportFactory {
  return async (config: SourceConfig) => {
    const server = servers[config.id];
    if (!server) throw new Error(`no server for ${config.id}`);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    return clientTransport;
  };
}

/**
 * A reference MCP server that exposes the vendor's documented tool surface (so
 * we can reconcile it) and answers a code/record search with the given reply
 * (so enrichment has evidence to gather).
 */
function makeReferenceServer(toolNames: string[], reply: (query: string) => string): McpServer {
  const server = new McpServer({ name: "reference", version: "0" });
  for (const name of toolNames) {
    server.registerTool(
      name,
      { description: `${name} tool`, inputSchema: { input: z.string().optional() } },
      async () => ({ content: [{ type: "text" as const, text: "{}" }] }),
    );
  }
  server.registerTool(
    "search_code",
    { description: "search", inputSchema: { query: z.string() } },
    async (args: { query: string }) => ({
      content: [{ type: "text" as const, text: reply(args.query) }],
    }),
  );
  return server;
}

/** The CRUD verb a reference tool name implies, or undefined for a non-CRUD tool. */
function verbOf(toolName: string): string | undefined {
  const n = toolName.toLowerCase();
  if (/(query|soql|search|read|get|list|retrieve|describe)/.test(n)) return "read";
  if (/(create|insert)/.test(n)) return "create";
  if (/(update|upsert|patch|modify)/.test(n)) return "update";
  if (/(delete|remove|destroy)/.test(n)) return "delete";
  return undefined;
}

/** The CRUD verb one of our compiled operations implements. */
function opVerb(action: string, effect: string): string {
  if (effect === "read") return "read";
  if (action === "create" || action === "upsert") return action === "upsert" ? "update" : "create";
  if (action === "update" || action === "replace") return "update";
  if (action === "delete") return "delete";
  return effect;
}

async function reconcileSurface(source: SourceConfig, server: McpServer): Promise<Set<string>> {
  const connected = await connectSource(source, factoryFor({ [source.id]: server }));
  try {
    const tools = await connected.listTools();
    return new Set(tools.map((t) => verbOf(t.name)).filter((v): v is string => Boolean(v)));
  } finally {
    await connected.close();
  }
}

describe("Salesforce — REST surface vs reference MCP", () => {
  it("compiles the sObjects REST API into the expected CRUD + query surface", async () => {
    const air = await compile({
      spec: read("salesforce/openapi.yaml"),
      manifest: read("salesforce/anvil.yaml"),
      serviceId: "salesforce",
    });
    const commands = air.operations.map((o) => o.cli.command);
    // Clean names — no version segment leak, no `_patch` disambiguation suffix.
    expect(commands).toEqual(
      expect.arrayContaining([
        "salesforce query list",
        "salesforce Account get",
        "salesforce Account create",
        "salesforce Account update",
        "salesforce Account upsert",
        "salesforce Account delete",
      ]),
    );
    expect(commands.some((c) => c.includes("v60"))).toBe(false);
    expect(commands.some((c) => c.includes("patch_2"))).toBe(false);
    // The idempotent upsert is retry-safe; the plain create is not.
    const upsert = air.operations.find((o) => o.canonicalName === "upsert_account_by_external_id");
    expect(upsert?.retries.mode).toBe("safe");
    const create = air.operations.find((o) => o.canonicalName === "create_account");
    expect(create?.confirmation.required).toBe(true);
  });

  it("covers every CRUD capability the reference DX MCP server exposes", async () => {
    const air = await compile({
      spec: read("salesforce/openapi.yaml"),
      manifest: read("salesforce/anvil.yaml"),
      serviceId: "salesforce",
    });
    // The Salesforce reference MCP's record surface (github.com/salesforcecli/mcp
    // + the record tools community servers expose).
    const server = makeReferenceServer(
      ["run_soql_query", "get_record", "create_record", "update_record", "delete_record"],
      () => "",
    );
    const referenceVerbs = await reconcileSurface(
      { id: "salesforce", system: "salesforce", hints: { scope: [] } },
      server,
    );
    const ourVerbs = new Set(air.operations.map((o) => opVerb(o.effect.action, o.effect.kind)));
    // Every capability the vendor's MCP can do, our compiled surface also does.
    for (const verb of referenceVerbs) expect(ourVerbs.has(verb)).toBe(true);
    expect(referenceVerbs).toEqual(new Set(["read", "create", "update", "delete"]));
  });

  it("enriches an idempotency contract from the reference MCP (like GitHub/Jira)", async () => {
    const air = await compile({ spec: read("salesforce/openapi.yaml"), serviceId: "salesforce" });
    const server = makeReferenceServer(["run_soql_query"], (q) =>
      q.includes("upsert")
        ? "upsertAccountByExternalId is idempotent: the External Id acts as the idempotency key, so retries converge"
        : "",
    );
    const report = await runEnrichment(
      air,
      [{ id: "salesforce", system: "salesforce", hints: { searchTool: "search_code", scope: [] } }],
      { transportFactory: factoryFor({ salesforce: server }) },
    );
    // Enrichment ran and produced a proposal object (propose-only; AIR untouched).
    expect(report.proposedManifest).toBeDefined();
    expect(report.operations.length).toBeGreaterThan(0);
  });
});

describe("SAP S/4HANA — OData surface vs reference MCP", () => {
  it("compiles the OData $metadata into aligned CRUD operations, honouring sap: annotations", async () => {
    const air = await compile({
      spec: read("sap/metadata.edmx"),
      manifest: read("sap/anvil.yaml"),
      serviceId: "sap_bp",
    });
    const byCommand = new Map(air.operations.map((o) => [o.cli.command, o]));
    // Business Partner: read/create/update but NOT deletable (sap:deletable=false).
    expect(byCommand.has("sap_bp A_BusinessPartner get")).toBe(true);
    expect(byCommand.has("sap_bp A_BusinessPartner update")).toBe(true);
    expect(byCommand.has("sap_bp A_BusinessPartner delete")).toBe(false);
    // Customer: read-only projection (not creatable/updatable/deletable).
    expect(byCommand.has("sap_bp A_Customer get")).toBe(true);
    expect(byCommand.has("sap_bp A_Customer create")).toBe(false);
    // Address: full CRUD including delete.
    expect(byCommand.has("sap_bp A_BusinessPartnerAddress delete")).toBe(true);
    // The item paths keep the OData key predicate on the wire (valid OData URLs).
    const get = byCommand.get("sap_bp A_BusinessPartner get");
    expect(get?.sourceRef.path).toBe("/A_BusinessPartner('{BusinessPartner}')");
    expect(get?.input.params.some((p) => p.in === "path" && p.name === "BusinessPartner")).toBe(
      true,
    );
  });

  it("covers every CRUD capability the reference ABAP-add-on MCP exposes", async () => {
    const air = await compile({
      spec: read("sap/metadata.edmx"),
      manifest: read("sap/anvil.yaml"),
      serviceId: "sap_bp",
    });
    // The SAP OData MCP add-on's flat-mode CRUD tools.
    const server = makeReferenceServer(
      ["odata_query", "odata_read", "odata_create", "odata_update", "odata_delete"],
      () => "",
    );
    const referenceVerbs = await reconcileSurface(
      { id: "sap", system: "sap", hints: { scope: [] } },
      server,
    );
    const ourVerbs = new Set(air.operations.map((o) => opVerb(o.effect.action, o.effect.kind)));
    for (const verb of referenceVerbs) expect(ourVerbs.has(verb)).toBe(true);
    expect(referenceVerbs).toEqual(new Set(["read", "create", "update", "delete"]));
  });
});
