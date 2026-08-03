import { type Operation, Operation as OperationSchema } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { execute, type HttpResponse, MockTransport } from "./index.js";

/** A raw query-passthrough operation carrying a grammar policy. */
function passthroughOp(policy: Record<string, unknown>): Operation {
  return OperationSchema.parse({
    id: "warehouse.reports.run",
    canonicalName: "run_query",
    displayName: "Run query",
    sourceRef: { kind: "openapi", path: "/reports/run", method: "get" },
    effect: { kind: "read", action: "search", resource: "report", risk: "low", reversible: true },
    input: {
      params: [{ name: "sql", in: "query", required: true, schema: { type: "string" } }],
    },
    queryPolicy: { queryParam: "sql", ...policy },
    idempotency: { mode: "natural" },
    retries: {
      mode: "safe",
      basis: "read_safe",
      maxAttempts: 3,
      backoff: "exponential_jitter",
      retryOn: ["timeout"],
    },
    confirmation: { required: false },
    auth: { type: "none", scopes: [] },
    cli: { command: "warehouse reports run" },
    mcp: { toolName: "warehouse_run_query" },
    skill: { intentExamples: [] },
    state: "approved",
  });
}

const ok = (body: unknown): HttpResponse => ({
  status: 200,
  headers: {},
  body: JSON.stringify(body),
});

const ctx = (transport: MockTransport) => ({
  transport,
  serviceId: "warehouse",
  baseUrl: "https://warehouse.internal.example.com",
  allowedHosts: ["warehouse.internal.example.com"],
  env: "dev",
  sleep: async () => {},
  rng: () => 0.5,
});

describe("query grammar policy — parse-then-police", () => {
  it("sends a bounded single SELECT that satisfies the policy", async () => {
    const transport = new MockTransport(() => ok({ rows: [] }));
    const op = passthroughOp({ dialect: "postgres", maxRows: 1000 });
    const res = await execute(
      op,
      { input: { sql: "SELECT name FROM accounts WHERE region = 'US' LIMIT 10" } },
      ctx(transport),
    );
    expect(res.outcome).toBe("success");
    expect(transport.requests).toHaveLength(1);
  });

  it("refuses a stacked second statement before any wire request", async () => {
    const transport = new MockTransport(() => ok({ rows: [] }));
    const op = passthroughOp({ dialect: "postgres", maxRows: 1000 });
    const res = await execute(
      op,
      { input: { sql: "SELECT 1 FROM t LIMIT 1; DROP TABLE users" } },
      ctx(transport),
    );
    expect(res.outcome).toBe("error");
    expect(transport.requests).toHaveLength(0); // fail closed, nothing sent
    if (res.outcome !== "error") return;
    expect(res.envelope.error.message).toMatch(/grammar policy/i);
  });

  it("refuses a non-SELECT statement class", async () => {
    const transport = new MockTransport(() => ok({}));
    const op = passthroughOp({ dialect: "postgres", allowedStatements: ["select"] });
    const res = await execute(
      op,
      { input: { sql: "DELETE FROM users WHERE id = 1" } },
      ctx(transport),
    );
    expect(res.outcome).toBe("error");
    expect(transport.requests).toHaveLength(0);
  });

  it("refuses an unbounded read when maxRows is set", async () => {
    const transport = new MockTransport(() => ok({}));
    const op = passthroughOp({ dialect: "postgres", maxRows: 100 });
    const res = await execute(op, { input: { sql: "SELECT * FROM accounts" } }, ctx(transport));
    expect(res.outcome).toBe("error");
    expect(transport.requests).toHaveLength(0);
  });

  it("refuses an off-allowlist table", async () => {
    const transport = new MockTransport(() => ok({}));
    const op = passthroughOp({ dialect: "postgres", maxRows: 100, allowedTables: ["accounts"] });
    const res = await execute(
      op,
      { input: { sql: "SELECT * FROM secrets LIMIT 5" } },
      ctx(transport),
    );
    expect(res.outcome).toBe("error");
    expect(transport.requests).toHaveLength(0);
  });

  it("fails closed on a query that will not tokenize", async () => {
    const transport = new MockTransport(() => ok({}));
    const op = passthroughOp({ dialect: "postgres", maxRows: 100 });
    const res = await execute(
      op,
      { input: { sql: "SELECT 'unterminated FROM accounts LIMIT 5" } },
      ctx(transport),
    );
    expect(res.outcome).toBe("error");
    expect(transport.requests).toHaveLength(0);
  });
});
