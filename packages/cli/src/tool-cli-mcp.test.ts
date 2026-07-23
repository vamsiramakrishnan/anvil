import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AirDocument } from "@anvil/air";
import { compile } from "@anvil/compiler";
import { buildMcpServer } from "@anvil/generators";
import { type HttpResponse, MockTransport } from "@anvil/runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it } from "vitest";
import { bufferIO } from "./io.js";
import { type McpToolClient, runToolCli } from "./tool-cli.js";

// skill → CLI → MCP: the CLI can route an invocation THROUGH an MCP server (the
// `--mcp` path) instead of executing directly, and the safety contract survives
// the hop — confirm / idempotency-key travel as the operation's synthesized input
// fields, and --dry-run rides the reserved anvil_dry_run arg. The MCP transport
// (stdio vs SSE) is orthogonal and injected here in-process via InMemoryTransport;
// a real SSE client↔server is exercised separately (the generated server test).

const examples = fileURLToPath(new URL("../../../examples/payments/", import.meta.url));
const read = (rel: string) => readFileSync(join(examples, rel), "utf8");

let air: AirDocument;
beforeAll(async () => {
  air = await compile({
    spec: read("openapi.yaml"),
    manifest: read("anvil.yaml"),
    serviceId: "payments",
  });
});

const ok = (body: unknown): HttpResponse => ({
  status: 200,
  headers: {},
  body: JSON.stringify(body),
});

/** A `deps.mcpConnect` that links the CLI to a REAL in-process MCP server built
 *  from the same AIR, executing against a mock upstream. `requests` records the
 *  wire calls the server made, so a test can prove an op did (or didn't) execute. */
function inProcessMcp(): {
  connect: () => Promise<McpToolClient>;
  requests: MockTransport["requests"];
} {
  const transport = new MockTransport(() => ok({ id: "re_1", status: "succeeded" }));
  const server = buildMcpServer(air, {
    contextFor: () => ({
      transport,
      serviceId: air.service.id,
      credentials: {
        async resolve() {
          return { headers: { Authorization: "Bearer t" } };
        },
      },
      baseUrl: "https://payments.internal.example.com",
      allowedHosts: ["payments.internal.example.com"],
      env: "dev",
    }),
  });
  return {
    requests: transport.requests,
    connect: async () => {
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      await server.connect(serverT);
      const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
      await client.connect(clientT);
      return client as unknown as McpToolClient;
    },
  };
}

const REFUND = [
  "refunds",
  "create",
  "--payment-id",
  "pay_1",
  "--amount",
  "2500",
  "--currency",
  "USD",
];

describe("CLI routed through MCP (--mcp)", () => {
  it("previews a dry-run over MCP — the plan, and no upstream call", async () => {
    const mcp = inProcessMcp();
    const io = bufferIO();
    const code = await runToolCli(
      air,
      [...REFUND, "--idempotency-key", "k1", "--confirm", "--dry-run", "--mcp", "inmem"],
      { env: { ANVIL_ENV: "dev" } as NodeJS.ProcessEnv, io, mcpConnect: mcp.connect },
    );
    expect(code).toBe(0);
    expect(mcp.requests).toHaveLength(0); // dry-run never touches the wire
    expect(io.stdout.join("\n").length).toBeGreaterThan(0);
  });

  it("executes a confirmation-gated mutation over MCP when --confirm + --idempotency-key are given", async () => {
    const mcp = inProcessMcp();
    const io = bufferIO();
    const code = await runToolCli(
      air,
      [...REFUND, "--idempotency-key", "k1", "--confirm", "--mcp", "inmem"],
      {
        env: { ANVIL_ENV: "dev" } as NodeJS.ProcessEnv,
        io,
        mcpConnect: mcp.connect,
      },
    );
    expect(code).toBe(0);
    // confirm + idempotency_key traveled as input fields → the server executed
    // and hit the (mock) upstream exactly once.
    expect(mcp.requests).toHaveLength(1);
    expect(io.stdout.join("\n")).toContain("re_1");
  });

  it("does NOT execute the mutation over MCP without --confirm (safety preserved)", async () => {
    const mcp = inProcessMcp();
    const io = bufferIO();
    const code = await runToolCli(air, [...REFUND, "--idempotency-key", "k1", "--mcp", "inmem"], {
      env: { ANVIL_ENV: "dev" } as NodeJS.ProcessEnv,
      io,
      mcpConnect: mcp.connect,
    });
    // The server's tool schema requires confirm=true for this op, so an
    // unconfirmed call is refused before any upstream call — non-zero exit, no wire.
    expect(code).not.toBe(0);
    expect(mcp.requests).toHaveLength(0);
  });

  it("routes through MCP when ANVIL_MCP_TARGET is set as the env default (no flag)", async () => {
    const mcp = inProcessMcp();
    const io = bufferIO();
    const code = await runToolCli(air, [...REFUND, "--idempotency-key", "k1", "--confirm"], {
      env: { ANVIL_ENV: "dev", ANVIL_MCP_TARGET: "inmem" } as NodeJS.ProcessEnv,
      io,
      mcpConnect: mcp.connect,
    });
    expect(code).toBe(0);
    expect(mcp.requests).toHaveLength(1); // the env default routed it through MCP
  });

  it("`--mcp direct` forces direct execution, overriding the ANVIL_MCP_TARGET env", async () => {
    const mcp = inProcessMcp(); // must stay untouched
    let connected = false;
    const directTransport = new MockTransport(() => ok({ id: "re_direct" }));
    const io = bufferIO();
    const code = await runToolCli(
      air,
      [...REFUND, "--idempotency-key", "k1", "--confirm", "--mcp", "direct"],
      {
        env: {
          ANVIL_ENV: "dev",
          ANVIL_MCP_TARGET: "inmem",
          ANVIL_ALLOWED_HOSTS: "payments.internal.example.com",
          ANVIL_AUTH_PROFILE: "prod",
        } as NodeJS.ProcessEnv,
        io,
        transport: directTransport,
        credentials: {
          async resolve() {
            return { headers: { Authorization: "Bearer t" } };
          },
        },
        mcpConnect: async () => {
          connected = true;
          throw new Error("should not have connected");
        },
      },
    );
    expect(code).toBe(0);
    expect(connected).toBe(false); // --mcp direct won over the env → no MCP hop
    expect(mcp.requests).toHaveLength(0);
    expect(directTransport.requests).toHaveLength(1); // executed directly
    expect(io.stdout.join("\n")).toContain("re_direct");
  });

  it("maps an MCP connection failure onto the upstream-availability exit code (7)", async () => {
    const io = bufferIO();
    const code = await runToolCli(
      air,
      [...REFUND, "--confirm", "--idempotency-key", "k1", "--mcp", "inmem"],
      {
        env: { ANVIL_ENV: "dev" } as NodeJS.ProcessEnv,
        io,
        mcpConnect: async () => {
          throw new Error("connect refused");
        },
      },
    );
    expect(code).toBe(7);
    expect(io.stderr.join("\n")).toContain("upstream_unavailable");
  });
});
