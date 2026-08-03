import { describe, expect, it } from "vitest";
import { compile } from "./compile.js";

/** A spec with one unconstrained free-text query param — a passthrough surface. */
const passthroughSpec = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Warehouse", version: "1.0.0" },
  servers: [{ url: "https://api.example.com" }],
  paths: {
    "/reports/run": {
      get: {
        operationId: "runReport",
        summary: "Run a report query",
        parameters: [{ name: "sql", in: "query", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "ok" } },
      },
    },
  },
});

describe("query grammar policy — manifest unblock", () => {
  it("records the policy on AIR and lifts a passthrough from blocked to review_required", async () => {
    const air = await compile({
      spec: passthroughSpec,
      serviceId: "warehouse",
      manifest: `
operations:
  runReport:
    query_policy:
      query_param: sql
      dialect: postgres
      max_rows: 1000
      allowed_tables: [accounts, ledger]
`,
    });
    const op = air.operations.find((o) => o.sourceRef.operationId === "runReport");
    expect(op?.queryPolicy).toMatchObject({
      queryParam: "sql",
      dialect: "postgres",
      allowedStatements: ["select"],
      singleStatementOnly: true,
      forbidComments: true,
      maxRows: 1000,
      allowedTables: ["accounts", "ledger"],
    });
    // A declared policy is a reviewable unblock, never a silent auto-approve.
    expect(op?.state).toBe("review_required");
    expect(op?.reviewNotes.join(" ")).toMatch(/grammar policy/i);
  });

  it("ingests harness-supplied schema and grounds the policy against it", async () => {
    const air = await compile({
      spec: passthroughSpec,
      serviceId: "warehouse",
      manifest: `
operations:
  runReport:
    query_policy:
      query_param: sql
      dialect: postgres
      max_rows: 1000
      allowed_tables: [accounts, ledger]
    query_schema:
      tables:
        - name: accounts
          description: One row per customer account
          columns:
            - { name: id, type: bigint }
            - { name: ssn, type: text, sensitivity: pii }
        - name: ledger
          columns:
            - { name: acct_id, type: bigint }
      example_queries:
        - { intent: recent balances, sql: "SELECT id FROM accounts LIMIT 10" }
      glossary:
        - { term: MRR, definition: monthly recurring revenue }
`,
    });
    const op = air.operations.find((o) => o.sourceRef.operationId === "runReport");
    expect(op?.querySchema?.tables.map((t) => t.name)).toEqual(["accounts", "ledger"]);
    expect(op?.querySchema?.tables[0]?.columns[1]).toMatchObject({
      name: "ssn",
      sensitivity: "pii",
    });
    expect(op?.querySchema?.exampleQueries).toHaveLength(1);
    // Every allowlisted table exists in the schema — grounding passes, so the
    // guarded op is held for review (not re-blocked).
    expect(op?.state).toBe("review_required");
  });

  it("refuses a sloppy answer — an allowlisted table absent from the schema re-blocks the op", async () => {
    const air = await compile({
      spec: passthroughSpec,
      serviceId: "warehouse",
      manifest: `
operations:
  runReport:
    query_policy:
      query_param: sql
      dialect: postgres
      allowed_tables: [accounts, secrets]
    query_schema:
      tables:
        - name: accounts
          columns: [{ name: id, type: bigint }]
`,
    });
    const op = air.operations.find((o) => o.sourceRef.operationId === "runReport");
    expect(op?.state).toBe("blocked");
    expect(op?.reviewNotes.join(" ")).toMatch(/not present in the supplied schema: secrets/);
  });

  it("defaults to SELECT-only with statement/comment guards when only the param is named", async () => {
    const air = await compile({
      spec: passthroughSpec,
      serviceId: "warehouse",
      manifest: `
operations:
  runReport:
    query_policy:
      query_param: sql
`,
    });
    const op = air.operations.find((o) => o.sourceRef.operationId === "runReport");
    expect(op?.queryPolicy).toMatchObject({
      queryParam: "sql",
      dialect: "ansi",
      allowedStatements: ["select"],
      singleStatementOnly: true,
      forbidComments: true,
    });
  });
});
