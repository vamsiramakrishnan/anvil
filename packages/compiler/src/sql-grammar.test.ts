import { describe, expect, it } from "vitest";
import { analyzeSqlTemplate, supportedSqlDialects } from "./sql-grammar.js";

describe("analyzeSqlTemplate — real-parser authoring gate", () => {
  it("accepts a single SELECT with placeholders in value positions and extracts tables", () => {
    const r = analyzeSqlTemplate(
      "SELECT name FROM accounts WHERE branch = '{branch}' AND tier = {tier} LIMIT 10",
      "postgres",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.statementType).toBe("select");
    expect(r.tables).toEqual(["accounts"]);
  });

  it("extracts qualified table names across a join", () => {
    const r = analyzeSqlTemplate(
      "SELECT a.id FROM analytics.accounts a JOIN ledger l ON a.id = l.acct WHERE a.region = '{region}'",
      "postgres",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tables).toContain("analytics.accounts");
    expect(r.tables).toContain("ledger");
  });

  it("rejects a placeholder in an identifier position (the parser throws on :param there)", () => {
    const r = analyzeSqlTemplate("SELECT * FROM {table} LIMIT 1", "postgres");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("placeholder_position");
  });

  it("rejects a multi-statement template", () => {
    const r = analyzeSqlTemplate(
      "SELECT * FROM accounts LIMIT 1; SELECT * FROM ledger LIMIT 1",
      "postgres",
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("multiple_statements");
  });

  it("reports the real statement type for a non-SELECT (so the caller can refuse it)", () => {
    const r = analyzeSqlTemplate("UPDATE accounts SET tier = {tier}", "postgres");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.statementType).toBe("update");
  });

  it("falls back with an unsupported-dialect verdict rather than guessing", () => {
    const r = analyzeSqlTemplate("SELECT 1", "cql");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("unsupported_dialect");
  });

  it("lists the SQL dialects the analyzer covers", () => {
    expect(supportedSqlDialects()).toEqual(expect.arrayContaining(["ansi", "postgres", "mysql"]));
  });
});
