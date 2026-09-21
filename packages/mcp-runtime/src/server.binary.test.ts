import { type AirDocument, loadAirDocument, Operation } from "@anvil/air";
import type { Transport } from "@anvil/runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { buildMcpServer } from "./server.js";

/**
 * A binary upstream body reaches an MCP caller as a description in the text
 * content and the bytes, base64-encoded, in the structured content — never as
 * megabytes of base64 in the text channel, and never as mangled text.
 */
const PDF = Buffer.from("%PDF-1.7\n\x00\xff\xfe binary \n%%EOF\n", "latin1");

const pdfTransport: Transport = {
  send: async () => ({
    status: 200,
    headers: { "content-type": "application/pdf" },
    body: PDF.toString("base64"),
    bodyEncoding: "base64",
  }),
};

const op = Operation.parse({
  id: "reports.report.get",
  canonicalName: "get_report",
  displayName: "Get report",
  sourceRef: { kind: "openapi", path: "/report", method: "get" },
  effect: { kind: "read", action: "get", resource: "report", risk: "low", reversible: true },
  input: { params: [] },
  idempotency: { mode: "natural", keyDerivation: "none" },
  retries: { mode: "none", maxAttempts: 1, backoff: "none", retryOn: [] },
  confirmation: { required: false },
  auth: { type: "none", scopes: [] },
  cli: { command: "reports report get" },
  mcp: { toolName: "reports_get_report" },
  skill: { intentExamples: [] },
  state: "approved",
  output: { schema: { type: "string", format: "binary" } },
});

describe("binary results over MCP", () => {
  it("describes the bytes in text and carries them in structuredContent", async () => {
    const air: AirDocument = loadAirDocument({
      service: { id: "reports", version: "1.0.0", source: { kind: "openapi" } },
      operations: [op],
    });
    const server = buildMcpServer(air, {
      contextFor: () => ({
        transport: pdfTransport,
        serviceId: "reports",
        baseUrl: "http://reports",
        allowedHosts: ["reports"],
      }),
    });
    const client = new Client({ name: "t", version: "0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({ name: "reports_get_report", arguments: {} });
    expect(result.isError ?? false).toBe(false);
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    expect(text).toContain("application/pdf");
    expect(text).toContain(`${PDF.length} bytes`);
    expect(text).not.toContain(PDF.toString("base64"));
    expect(result.structuredContent).toEqual({
      contentType: "application/pdf",
      encoding: "base64",
      data: PDF.toString("base64"),
      bytes: PDF.length,
    });
    await client.close();
  });
});
