import { type AirDocument, loadAirDocument } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { generateSkill } from "./skill.js";

/** A minimal AIR with one approved, grammar-checked passthrough operation. */
function grammarAir(): AirDocument {
  return loadAirDocument({
    service: {
      id: "warehouse",
      displayName: "Warehouse",
      version: "1",
      source: { kind: "openapi" },
      servers: [{ url: "https://warehouse.example.com" }],
    },
    operations: [
      {
        id: "warehouse.reports.run",
        canonicalName: "run_report",
        displayName: "Run report",
        description: "Run a SQL report.",
        sourceRef: { kind: "openapi", path: "/reports/run", method: "get" },
        effect: {
          kind: "read",
          action: "search",
          resource: "report",
          risk: "low",
          reversible: true,
        },
        input: {
          params: [{ name: "sql", in: "query", required: true, schema: { type: "string" } }],
        },
        archetype: "query_passthrough",
        queryPolicy: {
          queryParam: "sql",
          dialect: "postgres",
          allowedStatements: ["select"],
          singleStatementOnly: true,
          forbidComments: true,
          maxRows: 1000,
          allowedTables: ["accounts"],
        },
        idempotency: { mode: "natural", mechanism: "none", keyDerivation: "none" },
        retries: {
          mode: "safe",
          basis: "read_safe",
          maxAttempts: 3,
          backoff: "exponential_jitter",
          retryOn: [],
        },
        confirmation: { required: false },
        auth: { type: "none", scopes: [] },
        cli: { command: "warehouse reports run" },
        mcp: { toolName: "warehouse_run_report" },
        skill: { intentExamples: [] },
        state: "approved",
      },
    ],
  });
}

describe("skill query-grammar card", () => {
  it("emits a query-grammar reference teaching the exact policy constraints", () => {
    const files = generateSkill(grammarAir());
    const card = files["reference/query-grammar.md"];
    expect(card).toBeDefined();
    expect(card).toContain("SELECT-only");
    expect(card).toContain("postgres dialect");
    expect(card).toContain("LIMIT ≤ 1000 required");
    expect(card).toContain("accounts");
    expect(card).toContain("--dry-run");
  });

  it("omits the card entirely when no operation is grammar-checked", () => {
    const air = grammarAir();
    // Strip the policy — now it is just an approved read with no grammar surface.
    air.operations[0]!.queryPolicy = undefined;
    air.operations[0]!.archetype = "search";
    const files = generateSkill(air);
    expect(files["reference/query-grammar.md"]).toBeUndefined();
  });
});
