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
