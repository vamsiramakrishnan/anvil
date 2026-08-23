import type { McpCapture, McpCaptureResult, McpProbe, McpTool } from "@anvil/compiler";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

/**
 * The real MCP probe — the impure edge `adoptMcp` declares and nothing
 * implemented.
 *
 * `@anvil/compiler` owns adoption as a pure function of a captured surface and
 * deliberately cannot open a socket; the only probe that existed was the fake
 * one its tests use. So the whole adoption path — capture, AIR, capability
 * contracts, surface signature, plan — was reachable from a unit test and from
 * nowhere else. This is the socket.
 *
 * It lives in `@anvil/harness` because that is already where Anvil is an MCP
 * *client* (`mcp-source.ts` connects to the servers `anvil enrich` consults),
 * so the transport-selection rules have one home rather than two.
 */

/** How the endpoint string is interpreted. */
export interface ProbeOptions {
  /** Headers for an HTTP endpoint; `${VAR}` resolves from the environment. */
  headers?: Record<string, string>;
  /** Injectable transport, so adoption is testable without a live server. */
  transportFactory?: (endpoint: string) => Promise<Transport>;
  /** Milliseconds before a capture is abandoned. */
  timeoutMs?: number;
}

function resolveEnvRefs(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key: string) =>
      process.env[key] === undefined ? "" : String(process.env[key]),
    );
  }
  return out;
}

/**
 * An endpoint is a URL (remote, streamable HTTP) or a local command line
 * (stdio). A `stdio:` prefix forces the latter for a command that would
 * otherwise parse as a URL.
 */
export function transportKindFor(endpoint: string): "stdio" | "streamable-http" {
  if (endpoint.startsWith("stdio:")) return "stdio";
  return /^https?:\/\//i.test(endpoint) ? "streamable-http" : "stdio";
}

async function defaultTransport(endpoint: string, options: ProbeOptions): Promise<Transport> {
  if (transportKindFor(endpoint) === "streamable-http") {
    const { StreamableHTTPClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/streamableHttp.js"
    );
    return new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers: resolveEnvRefs(options.headers ?? {}) },
    });
  }
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const line = endpoint.replace(/^stdio:/, "").trim();
  const [command, ...args] = line.split(/\s+/);
  if (command === undefined || command.length === 0) {
    throw new Error("a stdio endpoint must name a command to run");
  }
  return new StdioClientTransport({ command, args });
}

function toolsFrom(raw: unknown): McpTool[] {
  const list = (raw as { tools?: unknown }).tools;
  if (!Array.isArray(list)) return [];
  const tools: McpTool[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const tool = entry as Record<string, unknown>;
    if (typeof tool.name !== "string") continue;
    tools.push({
      name: tool.name,
      ...(typeof tool.description === "string" ? { description: tool.description } : {}),
      // Carried verbatim. A server that advertises no input schema gets an empty
      // object rather than an invented one — adoption must never widen a
      // contract the provider did not state.
      inputSchema:
        typeof tool.inputSchema === "object" && tool.inputSchema !== null
          ? (tool.inputSchema as McpTool["inputSchema"])
          : {},
      ...(typeof tool.annotations === "object" && tool.annotations !== null
        ? { annotations: tool.annotations as McpTool["annotations"] }
        : {}),
    });
  }
  return tools;
}

/**
 * Connect to an MCP server and capture its advertised surface.
 *
 * Every failure is returned as data, never thrown: an unreachable endpoint is a
 * fact about the adoption, and `adoptMcp` already models it that way.
 */
export function mcpProbe(options: ProbeOptions = {}): McpProbe {
  return {
    async capture(endpoint: string): Promise<McpCaptureResult> {
      const client = new Client({ name: "anvil-adopt", version: "0.1.0" });
      const timeoutMs = options.timeoutMs ?? 30_000;
      // The timer is cleared when the race settles. Left running, a referenced
      // 30-second timeout keeps the event loop alive after a fast success, and
      // the CLI sets `process.exitCode` rather than calling `process.exit` — so
      // `anvil adopt` would appear to hang for the whole timeout after having
      // already done its work.
      const deadline = <T>(promise: Promise<T>, label: string): Promise<T> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const expiry = new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
        });
        return Promise.race([promise, expiry]).finally(() => {
          if (timer !== undefined) clearTimeout(timer);
        });
      };
      let transport: Transport;
      try {
        transport = options.transportFactory
          ? await options.transportFactory(endpoint)
          : await defaultTransport(endpoint, options);
      } catch (error) {
        return {
          ok: false,
          code: "unreachable",
          message: error instanceof Error ? error.message : "the endpoint could not be prepared",
        };
      }
      try {
        await deadline(client.connect(transport), "handshake");
      } catch (error) {
        // Never echo the transport's message verbatim for an HTTP endpoint: it
        // can carry the URL, and a Moodle MCP endpoint carries its token in the
        // query string.
        return {
          ok: false,
          code: "unreachable",
          message:
            transportKindFor(endpoint) === "streamable-http"
              ? "the MCP endpoint could not be reached or refused the handshake"
              : `the MCP server could not be started: ${error instanceof Error ? error.message : "unknown error"}`,
        };
      }
      try {
        const listed = await deadline(client.listTools(), "tools/list");
        const version = client.getServerVersion();
        const capture: McpCapture = {
          endpoint,
          protocolVersion: "unknown",
          server: {
            name: version?.name ?? "unknown",
            version: version?.version ?? "unknown",
          },
          transport: transportKindFor(endpoint),
          serverCapabilities: (client.getServerCapabilities() ?? {}) as Record<string, unknown>,
          tools: toolsFrom(listed),
        };
        return { ok: true, capture };
      } catch (error) {
        return {
          ok: false,
          code: "protocol_error",
          message: `the server did not answer tools/list: ${error instanceof Error ? error.message : "unknown error"}`,
        };
      } finally {
        await client.close().catch(() => undefined);
      }
    },
  };
}
