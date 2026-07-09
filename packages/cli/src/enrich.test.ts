import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TransportFactory } from "@anvil/harness";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runAnvilCli } from "./anvil-cli.js";
import { bufferIO } from "./io.js";

const examples = fileURLToPath(new URL("../../../examples/payments/", import.meta.url));

function githubServer(): McpServer {
  const server = new McpServer({ name: "github", version: "0" });
  server.registerTool(
    "search_code",
    { description: "search", inputSchema: { query: z.string() } },
    async (args: { query: string }) => ({
      content: [
        {
          type: "text" as const,
          text: args.query.includes("create_refund")
            ? "refund handler reads the Idempotency-Key header"
            : "",
        },
      ],
    }),
  );
  return server;
}

const factory: TransportFactory = async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await githubServer().connect(serverTransport);
  return clientTransport;
};

describe("anvil enrich", () => {
  it("compiles spec-only, then proposes an idempotency patch from a source", async () => {
    const dir = mkdtempSync(join(tmpdir(), "anvil-enrich-"));
    try {
      // Compile spec-only so the refund is unproven (review_required).
      await runAnvilCli(
        ["compile", join(examples, "openapi.yaml"), "--service", "payments", "--out", dir],
        { io: bufferIO() },
      );

      const sources = join(dir, "sources.yaml");
      writeFileSync(
        sources,
        "sources:\n  - id: github\n    system: github\n    transport: { kind: stdio, command: x }\n    hints: { searchTool: search_code }\n",
        "utf8",
      );

      const io = bufferIO();
      const code = await runAnvilCli(["enrich", dir, "--sources", sources], {
        io,
        transportFactory: factory,
      });
      expect(code).toBe(0);
      expect(io.text()).toContain("create_refund");
      expect(io.text()).toContain("required_request_key");
      expect(io.text()).toMatch(/APPLY|Proposed manifest/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes the proposed manifest to a file with --write", async () => {
    const dir = mkdtempSync(join(tmpdir(), "anvil-enrich-"));
    try {
      await runAnvilCli(
        ["compile", join(examples, "openapi.yaml"), "--service", "payments", "--out", dir],
        { io: bufferIO() },
      );
      const sources = join(dir, "sources.yaml");
      writeFileSync(
        sources,
        "sources:\n  - id: github\n    system: github\n    transport: { kind: stdio, command: x }\n    hints: { searchTool: search_code }\n",
        "utf8",
      );
      const out = join(dir, "proposed.anvil.yaml");
      const code = await runAnvilCli(["enrich", dir, "--sources", sources, "--write", out], {
        io: bufferIO(),
        transportFactory: factory,
      });
      expect(code).toBe(0);
      expect(readFileSync(out, "utf8")).toContain("required_request_key");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
