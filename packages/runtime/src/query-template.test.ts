import { type Operation, Operation as OperationSchema } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { execute, type HttpResponse, MockTransport } from "./index.js";

/** A derived query-template operation, as buildQueryTemplates emits it. */
function templateOp(template: string): Operation {
  return OperationSchema.parse({
    id: "warehouse.reports.query.tpl.branch_names",
    canonicalName: "run_query_tpl_branch_names",
    displayName: "Run query (branch_names)",
    sourceRef: { kind: "openapi", path: "/reports/query", method: "get" },
    effect: { kind: "read", action: "search", resource: "report", risk: "low", reversible: true },
    input: {
      params: [{ name: "branch", in: "query", required: true, schema: { type: "string" } }],
    },
    queryTemplate: {
      baseOperationId: "warehouse.reports.query",
      template,
      targetParam: "sql",
    },
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
    cli: { command: "warehouse reports query-tpl-branch-names" },
    mcp: { toolName: "warehouse_run_query_tpl_branch_names" },
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

describe("query template rendering", () => {
  it("renders the template and sends it as the base operation's target param", async () => {
    const transport = new MockTransport(() => ok({ rows: [] }));
    const op = templateOp("SELECT name FROM accounts WHERE branch = '{branch}' LIMIT 10");
    const res = await execute(op, { input: { branch: "MUM01" } }, ctx(transport));

    expect(res.outcome).toBe("success");
    expect(transport.requests).toHaveLength(1);
    const url = new URL(transport.requests[0]?.url ?? "");
    expect(url.searchParams.get("sql")).toBe(
      "SELECT name FROM accounts WHERE branch = 'MUM01' LIMIT 10",
    );
    // The template variable itself is never sent as a request param.
    expect(url.searchParams.get("branch")).toBeNull();
  });

  it("substitutes literally — regex replacement patterns in a value cannot splice query text", async () => {
    const transport = new MockTransport(() => ok({ rows: [] }));
    const op = templateOp("SELECT name FROM accounts WHERE branch = '{branch}'");
    // "$&" and "$'" are replacement-string expansions under String.replace; a
    // literal substitution must pass them through untouched.
    const res = await execute(op, { input: { branch: "x$&y$'z" } }, ctx(transport));

    expect(res.outcome).toBe("success");
    const url = new URL(transport.requests[0]?.url ?? "");
    expect(url.searchParams.get("sql")).toBe("SELECT name FROM accounts WHERE branch = 'x$&y$'z'");
  });

  it("replaces every occurrence of a repeated placeholder", async () => {
    const transport = new MockTransport(() => ok({ rows: [] }));
    const op = templateOp("SELECT '{branch}' AS branch WHERE branch = '{branch}'");
    const res = await execute(op, { input: { branch: "B2" } }, ctx(transport));

    expect(res.outcome).toBe("success");
    const url = new URL(transport.requests[0]?.url ?? "");
    expect(url.searchParams.get("sql")).toBe("SELECT 'B2' AS branch WHERE branch = 'B2'");
  });
});
