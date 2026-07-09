import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { SourceConfig } from "./sources.js";

/** A minimal view of a connected MCP source: list its tools, call them, read text. */
export interface McpSource {
  id: string;
  system: SourceConfig["system"];
  listTools(): Promise<Array<{ name: string; description?: string }>>;
  call(tool: string, args: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

/**
 * Factory that turns a SourceConfig into a live MCP client. Injectable so tests
 * can supply an in-memory transport instead of spawning a real server.
 */
export type TransportFactory = (config: SourceConfig) => Promise<Transport>;

/** Default factory: spawn a published stdio server or connect to a remote http one. */
export const defaultTransportFactory: TransportFactory = async (config) => {
  if (config.transport.kind === "stdio") {
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    return new StdioClientTransport({
      command: config.transport.command,
      args: config.transport.args,
      env: { ...process.env, ...config.transport.env } as Record<string, string>,
    });
  }
  const { StreamableHTTPClientTransport } = await import(
    "@modelcontextprotocol/sdk/client/streamableHttp.js"
  );
  return new StreamableHTTPClientTransport(new URL(config.transport.url), {
    requestInit: { headers: config.transport.headers },
  });
};

/** Connect to a published MCP server described by `config`. */
export async function connectSource(
  config: SourceConfig,
  factory: TransportFactory = defaultTransportFactory,
): Promise<McpSource> {
  const client = new Client({ name: `anvil-harness/${config.id}`, version: "0.1.0" });
  const transport = await factory(config);
  await client.connect(transport);

  return {
    id: config.id,
    system: config.system,
    async listTools() {
      const { tools } = await client.listTools();
      return tools.map((t) => ({ name: t.name, description: t.description }));
    },
    async call(tool, args) {
      const res = await client.callTool({ name: tool, arguments: args });
      const content = (res.content ?? []) as Array<{ type: string; text?: string }>;
      return content
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text)
        .join("\n");
    },
    async close() {
      await client.close();
    },
  };
}
