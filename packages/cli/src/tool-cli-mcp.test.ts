import { readFileSync } from "node:fs";
import { createServer } from "node:http";
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
import { type McpToolClient, remoteMcpTarget, runToolCli } from "./tool-cli.js";

// skill → CLI → MCP: the CLI can route an invocation THROUGH an MCP server (the
// `--mcp` path) instead of executing directly, and the safety contract survives
// the hop — confirm / idempotency-key travel as the operation's synthesized input
// fields, and --dry-run rides the reserved anvil_dry_run arg. The MCP transport
// Transport selection is orthogonal and mostly injected here via
// InMemoryTransport; the bearer test below also drives the real Streamable HTTP
// client far enough to inspect its initialization request.

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
  it("uses Streamable HTTP for ordinary deployed /mcp URLs and requires an explicit SSE prefix", () => {
    expect(remoteMcpTarget("https://tools.example.com/mcp")).toMatchObject({
      kind: "streamable-http",
    });
    expect(remoteMcpTarget("sse:https://tools.example.com/sse")).toMatchObject({
      kind: "sse",
    });
    expect(() => remoteMcpTarget("ftp://tools.example.com/mcp")).toThrow(/expected HTTP\(S\)/);
    expect(() => remoteMcpTarget("not-a-url")).toThrow(/Invalid remote MCP target/);
    expect(() => remoteMcpTarget("https://token@tools.example.com/mcp")).toThrow(
      /URL credentials are forbidden/,
    );
  });

  it("classifies a malformed built-in MCP target as input, not an outage", async () => {
    const io = bufferIO();
    const code = await runToolCli(
      air,
      [
        "customers",
        "get",
        "--customer-id",
        "cus_123",
        "--dry-run",
        "--mcp",
        "ftp://tools.example.com/mcp",
      ],
      { env: { ANVIL_ENV: "dev" } as NodeJS.ProcessEnv, io },
    );
    expect(code).toBe(2);
    expect(io.stderr.join("\n")).toContain("validation_error");
    expect(io.stderr.join("\n")).toContain("expected HTTP(S)");
    expect(io.stderr.join("\n")).not.toContain("upstream_unavailable");
  });

  it("reads remote Streamable HTTP bearer auth from the named env variable at call time", async () => {
    const token = "secret-that-must-not-be-rendered";
    let authorization: string | undefined;
    const server = createServer((req, res) => {
      authorization = req.headers.authorization;
      res.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" });
      res.end('{"error":"unauthorized test endpoint"}');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP test server.");
      const io = bufferIO();
      const code = await runToolCli(
        air,
        [
          "customers",
          "get",
          "--customer-id",
          "cus_123",
          "--dry-run",
          "--mcp",
          `http://127.0.0.1:${address.port}/mcp`,
          "--mcp-token-env",
          "TEST_REMOTE_MCP_TOKEN",
        ],
        {
          env: {
            ANVIL_ENV: "dev",
            TEST_REMOTE_MCP_TOKEN: token,
          } as NodeJS.ProcessEnv,
          io,
        },
      );
      expect(code).toBe(7); // the probe deliberately rejects initialization
      expect(authorization).toBe(`Bearer ${token}`);
      expect(io.text()).not.toContain(token);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("redacts a bearer value even when a connector includes it in an error", async () => {
    const token = "secret-that-a-connector-echoed";
    const io = bufferIO();
    const code = await runToolCli(
      air,
      [
        "customers",
        "get",
        "--customer-id",
        "cus_123",
        "--dry-run",
        "--mcp",
        "https://tools.example.com/mcp?tenant=acme",
        "--mcp-token-env",
        "TEST_REMOTE_MCP_TOKEN",
      ],
      {
        env: {
          ANVIL_ENV: "dev",
          TEST_REMOTE_MCP_TOKEN: token,
        } as NodeJS.ProcessEnv,
        io,
        mcpConnect: async () => {
          throw new Error(`authorization failed for Bearer ${token}`);
        },
      },
    );
    expect(code).toBe(7);
    expect(io.text()).toContain("Bearer [REDACTED]");
    expect(io.text()).toContain("?redacted");
    expect(io.text()).not.toContain(token);
    expect(io.text()).not.toContain("tenant=acme");
  });

  it("fails before connecting when the named remote MCP bearer variable is absent", async () => {
    let connected = false;
    const io = bufferIO();
    const code = await runToolCli(
      air,
      [
        "customers",
        "get",
        "--customer-id",
        "cus_123",
        "--dry-run",
        "--mcp",
        "https://tools.example.com/mcp",
        "--mcp-token-env",
        "MISSING_REMOTE_MCP_TOKEN",
      ],
      {
        env: { ANVIL_ENV: "dev" } as NodeJS.ProcessEnv,
        io,
        mcpConnect: async () => {
          connected = true;
          throw new Error("must not connect");
        },
      },
    );
    expect(code).toBe(4);
    expect(connected).toBe(false);
    expect(io.stderr.join("\n")).toContain("MISSING_REMOTE_MCP_TOKEN");
    expect(io.stderr.join("\n")).toContain("auth_required");
  });

  it("supports ANVIL_MCP_TOKEN_ENV as the secret-free default variable name", async () => {
    let observedToken: string | undefined;
    const io = bufferIO();
    const code = await runToolCli(
      air,
      ["customers", "get", "--customer-id", "cus_123", "--dry-run"],
      {
        env: {
          ANVIL_ENV: "dev",
          ANVIL_MCP_TARGET: "https://tools.example.com/mcp",
          ANVIL_MCP_TOKEN_ENV: "REMOTE_MCP_TOKEN",
          REMOTE_MCP_TOKEN: "opaque-test-token",
        } as NodeJS.ProcessEnv,
        io,
        mcpConnect: async (_target, _deps, options) => {
          observedToken = options?.bearerToken;
          return {
            async callTool() {
              return { content: [{ type: "text", text: '{"ok":true}' }] };
            },
            async close() {},
          };
        },
      },
    );
    expect(code, io.text()).toBe(0);
    expect(observedToken).toBe("opaque-test-token");
    expect(io.text()).not.toContain("opaque-test-token");
  });

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
