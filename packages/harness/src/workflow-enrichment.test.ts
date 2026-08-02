import { type AirDocument, loadAirDocument } from "@anvil/air";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runEnrichment } from "./enrich.js";
import type { TransportFactory } from "./mcp-source.js";
import type { SourceConfig } from "./sources.js";

/** Same search→detail shape as workflow-candidates.test.ts: list_mappings' output covers get_mapping's required params. */
function doc(): AirDocument {
  return loadAirDocument({
    service: { id: "cards", displayName: "Cards", version: "1", source: { kind: "openapi" } },
    capabilities: [
      {
        id: "cards.mappings",
        displayName: "Card mappings",
        description: "",
        operationIds: ["cards.mappings.list", "cards.mappings.get"],
      },
    ],
    operations: [
      {
        id: "cards.mappings.list",
        canonicalName: "list_mappings",
        displayName: "List mappings",
        description: "",
        capabilityId: "cards.mappings",
        sourceRef: { kind: "openapi", path: "/mappings", method: "get" },
        effect: { kind: "read", action: "search" },
        input: { params: [] },
        output: {
          schema: {
            type: "array",
            items: { type: "object", properties: { atmCardN: { type: "string" } } },
          },
        },
        idempotency: { mode: "none" },
        retries: { mode: "none" },
        confirmation: { required: false },
        auth: { type: "api_key" },
        cli: { command: "cards mappings list" },
        mcp: { toolName: "cards_list_mappings" },
        skill: { intentExamples: ["List card mappings."] },
      },
      {
        id: "cards.mappings.get",
        canonicalName: "get_mapping",
        displayName: "Get mapping",
        description: "",
        capabilityId: "cards.mappings",
        sourceRef: { kind: "openapi", path: "/mappings/{atmCardN}", method: "get" },
        effect: { kind: "read", action: "search" },
        input: {
          params: [{ name: "atmCardN", in: "path", required: true, schema: { type: "string" } }],
        },
        idempotency: { mode: "none" },
        retries: { mode: "none" },
        confirmation: { required: false },
        auth: { type: "api_key" },
        cli: { command: "cards mappings get" },
        mcp: { toolName: "cards_get_mapping" },
        skill: { intentExamples: ["Get a card mapping."] },
      },
    ],
  });
}

function makeSourceServer(reply: (query: string) => string): McpServer {
  const server = new McpServer({ name: "source", version: "0" });
  server.registerTool(
    "search_code",
    { description: "search", inputSchema: { query: z.string() } },
    async (args: { query: string }) => ({
      content: [{ type: "text" as const, text: reply(args.query) }],
    }),
  );
  return server;
}

function factoryFor(servers: Record<string, McpServer>): TransportFactory {
  return async (config: SourceConfig) => {
    const server = servers[config.id];
    if (!server) throw new Error(`no server for ${config.id}`);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    return clientTransport;
  };
}

const githubSource: SourceConfig = {
  id: "github",
  system: "github",
  transport: { kind: "stdio", command: "x", args: [], env: {} },
  hints: { searchTool: "search_code", scope: [] },
};
const confluenceSource: SourceConfig = {
  id: "confluence",
  system: "confluence",
  transport: { kind: "http", url: "https://mcp.atlassian.example/mcp", headers: {} },
  hints: { searchTool: "search_code", scope: [] },
};

describe("workflow candidate enrichment", () => {
  it("proposes a review_required workflow when a connected source mentions both operations together", async () => {
    const servers = {
      github: makeSourceServer((q) =>
        q.includes("list_mappings") && q.includes("get_mapping")
          ? "the mapping controller calls list_mappings, then get_mapping for the selected row"
          : "",
      ),
    };
    const air = doc();
    const report = await runEnrichment(air, [githubSource], {
      transportFactory: factoryFor(servers),
    });

    const entry = report.proposedManifest.workflows.list_mappings_then_get_mapping;
    expect(entry).toBeDefined();
    expect(entry?.state).toBe("review_required");
    expect(entry?.capability).toBe("cards.mappings");
    expect(entry?.steps).toEqual([
      { operation: "list_mappings", description: "List mappings" },
      {
        operation: "get_mapping",
        description: "Get mapping",
        bindings: { atmCardN: "$.output.atmCardN" },
      },
    ]);

    const decision = report.workflows.find(
      (w) => w.candidate.toOperationId === "cards.mappings.get",
    );
    expect(decision?.accepted).toBe(true);

    // Propose-only: AIR itself gained no workflows.
    expect(air.workflows).toEqual([]);
  });

  it("does not propose a workflow when no connected source corroborates the candidate", async () => {
    const servers = { github: makeSourceServer(() => "") };
    const report = await runEnrichment(doc(), [githubSource], {
      transportFactory: factoryFor(servers),
    });

    expect(report.proposedManifest.workflows).toEqual({});
    const decision = report.workflows.find(
      (w) => w.candidate.toOperationId === "cards.mappings.get",
    );
    expect(decision?.accepted).toBe(false);
    expect(decision?.reason).toMatch(/no connected source corroborates/);
  });

  it("does not propose a workflow when a source mentions only one of the two operations", async () => {
    const servers = {
      confluence: makeSourceServer((q) =>
        q.includes("list_mappings") ? "list_mappings docs" : "",
      ),
    };
    const report = await runEnrichment(doc(), [confluenceSource], {
      transportFactory: factoryFor(servers),
    });

    expect(report.proposedManifest.workflows).toEqual({});
  });
});
