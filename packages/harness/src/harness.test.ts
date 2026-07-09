import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AirDocument } from "@anvil/air";
import { compile, enrich } from "@anvil/compiler";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { runEnrichment } from "./enrich.js";
import type { TransportFactory } from "./mcp-source.js";
import type { SourceConfig } from "./sources.js";

const examples = fileURLToPath(new URL("../../../examples/payments/", import.meta.url));
const read = (rel: string) => readFileSync(join(examples, rel), "utf8");

let air: AirDocument;
beforeAll(async () => {
  // Compile from the SPEC ONLY, so enrichment has something to prove.
  air = await compile({ spec: read("openapi.yaml"), serviceId: "payments" });
});

/** An in-memory MCP server standing in for a published source (GitHub/Confluence). */
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

/** Wire each configured source to its in-memory server via a linked transport. */
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
const gitlabSource: SourceConfig = {
  id: "gitlab",
  system: "gitlab",
  transport: { kind: "stdio", command: "x", args: [], env: {} },
  hints: { searchTool: "search_code", scope: [] },
};
const confluenceSource: SourceConfig = {
  id: "confluence",
  system: "confluence",
  transport: { kind: "http", url: "https://mcp.atlassian.example/mcp", headers: {} },
  hints: { searchTool: "search_code", scope: [] },
};
const postmanSource: SourceConfig = {
  id: "postman",
  system: "postman",
  transport: { kind: "http", url: "https://mcp.postman.example/mcp", headers: {} },
  hints: { searchTool: "search_code", scope: [] },
};

describe("harness enrichment", () => {
  it("accepts a safety-loosening claim only from high-reliability (impl) evidence", async () => {
    const servers = {
      github: makeSourceServer((q) =>
        q.includes("create_refund")
          ? "refund handler reads the Idempotency-Key header before creating the refund"
          : "",
      ),
    };
    const report = await runEnrichment(air, [githubSource], {
      transportFactory: factoryFor(servers),
    });

    const refund = report.proposedManifest.operations?.create_refund;
    expect(refund?.idempotency?.strategy).toBe("required_request_key");
    expect(refund?.idempotency?.header).toBe("Idempotency-Key");

    // And it must NOT have mutated AIR — enrichment is propose-only.
    const airRefund = air.operations.find((o) => o.canonicalName === "create_refund");
    expect(airRefund?.idempotency.mode).toBe("none");
  });

  it("rejects a safety-loosening claim backed only by weak (doc) evidence", async () => {
    const servers = {
      confluence: makeSourceServer((q) =>
        q.includes("create_refund") ? "the refund endpoint mentions idempotency somewhere" : "",
      ),
    };
    const report = await runEnrichment(air, [confluenceSource], {
      transportFactory: factoryFor(servers),
    });
    // Weak doc mention → no loosening patch.
    expect(report.proposedManifest.operations?.create_refund).toBeUndefined();
    const refund = report.operations.find((o) => o.canonicalName === "create_refund");
    const loosen = refund?.decisions.find((d) => d.claim.type === "idempotency");
    expect(loosen?.accepted).toBe(false);
    expect(loosen?.reason).toMatch(/needs reliability/);
  });

  it("prefers the safer claim on conflict (tighten beats loosen)", async () => {
    const servers = {
      github: makeSourceServer((q) =>
        q.includes("capture_payment") ? "// capturePayment is not idempotent, do not retry" : "",
      ),
      confluence: makeSourceServer((q) =>
        q.includes("capture_payment") ? "capture may support idempotency keys" : "",
      ),
    };
    const report = await runEnrichment(air, [githubSource, confluenceSource], {
      transportFactory: factoryFor(servers),
    });
    const capture = report.proposedManifest.operations?.capture_payment;
    expect(capture?.idempotency?.strategy).toBe("none");
    expect(capture?.confirmation?.required).toBe(true);
  });

  it("lets GitLab (a code host) loosen safety just like GitHub", async () => {
    const servers = {
      gitlab: makeSourceServer((q) =>
        q.includes("create_refund") ? "refund service sets the Idempotency-Key header" : "",
      ),
    };
    const report = await runEnrichment(air, [gitlabSource], {
      transportFactory: factoryFor(servers),
    });
    expect(report.proposedManifest.operations?.create_refund?.idempotency?.strategy).toBe(
      "required_request_key",
    );
  });

  it("treats a Postman example as corroborating only — it cannot loosen alone", async () => {
    const servers = {
      postman: makeSourceServer((q) =>
        q.includes("create_refund") ? "saved request includes an Idempotency-Key header" : "",
      ),
    };
    const report = await runEnrichment(air, [postmanSource], {
      transportFactory: factoryFor(servers),
    });
    // Postman's strong weight is below the loosen threshold, so no patch.
    expect(report.proposedManifest.operations?.create_refund).toBeUndefined();
    const refund = report.operations.find((o) => o.canonicalName === "create_refund");
    expect(refund?.decisions.find((d) => d.claim.type === "idempotency")?.accepted).toBe(false);
    // But confidence still rises from the corroborating evidence.
    expect(refund?.newConfidence).toBeGreaterThan(refund?.priorConfidence ?? 1);
  });

  it("raises evidence confidence and the patch applies through the compiler", async () => {
    const servers = {
      github: makeSourceServer((q) =>
        q.includes("create_refund") ? "refund handler reads the Idempotency-Key header" : "",
      ),
    };
    const report = await runEnrichment(air, [githubSource], {
      transportFactory: factoryFor(servers),
    });
    const refundReport = report.operations.find((o) => o.canonicalName === "create_refund");
    expect(refundReport?.newConfidence).toBeGreaterThan(refundReport?.priorConfidence ?? 1);

    // The proposed patch, fed to the compiler's enrich, makes the refund idempotent.
    const enriched = enrich(air.operations, report.proposedManifest);
    const refund = enriched.find((o) => o.canonicalName === "create_refund");
    expect(refund?.idempotency.mode).toBe("required");
    expect(refund?.retries.mode).toBe("safe");
  });
});
