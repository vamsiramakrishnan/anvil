/**
 * A deterministic in-memory `McpProbe` for tests and fixtures. It captures a
 * canned surface without any transport, so the whole adoption pipeline — snapshot,
 * AIR bridge, capability contracts, signature, plan — is exercised offline. The
 * real SDK-backed probe (StreamableHTTP/stdio) is the composition-shell impl of
 * the same interface.
 */
import type { McpCapture, McpCaptureResult, McpProbe } from "./model.js";

export interface FakeMcpServer {
  capture: McpCapture;
  /** When set, the probe reports this failure instead of capturing. */
  failure?: { code: "unreachable" | "handshake_failed" | "protocol_error"; message: string };
}

export class FakeMcpProbe implements McpProbe {
  constructor(private readonly servers: Record<string, FakeMcpServer>) {}

  async capture(endpoint: string): Promise<McpCaptureResult> {
    const server = this.servers[endpoint];
    if (!server) {
      return { ok: false, code: "unreachable", message: `No server at ${endpoint}.` };
    }
    if (server.failure) return { ok: false, ...server.failure };
    return { ok: true, capture: { ...server.capture, endpoint } };
  }
}

/** A canned, realistic two-tool server (a read + a mutation) for tests. */
export function sampleRefundServer(endpoint = "https://vendor.example/mcp"): FakeMcpServer {
  return {
    capture: {
      endpoint,
      protocolVersion: "2025-06-18",
      server: { name: "Refunds", version: "2.1.0" },
      transport: "streamable-http",
      serverCapabilities: { tools: {}, resources: {} },
      tools: [
        {
          name: "get_refund",
          description: "Fetch a refund by id.",
          inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
          annotations: { readOnlyHint: true },
        },
        {
          name: "create_refund",
          description: "Issue a refund.",
          inputSchema: {
            type: "object",
            properties: { payment_id: { type: "string" }, amount: { type: "number" } },
            required: ["payment_id"],
          },
          annotations: { destructiveHint: true },
        },
      ],
      resources: [{ uri: "refunds://policy", name: "Refund policy" }],
      prompts: [],
    },
  };
}
