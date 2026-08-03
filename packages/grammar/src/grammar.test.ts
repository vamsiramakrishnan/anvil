import { describe, expect, it } from "vitest";
import { checkQuery, type QueryPolicy } from "./policy.js";
import { analyzeTemplate, escapeStringLiteralBody, renderTemplate } from "./template.js";
import { lexicalFamily, significantTokens, tokenize } from "./tokenize.js";

describe("lexicalFamily — warehouse dialects collapse to a lean lexer family", () => {
  it("maps Postgres-lineage warehouses (redshift, snowflake) to the postgres family", () => {
    expect(lexicalFamily("postgres")).toBe("postgres");
    expect(lexicalFamily("redshift")).toBe("postgres");
    expect(lexicalFamily("snowflake")).toBe("postgres");
  });

  it("maps backtick/backslash warehouses (bigquery, databricks) to the mysql family", () => {
    expect(lexicalFamily("mysql")).toBe("mysql");
    expect(lexicalFamily("bigquery")).toBe("mysql");
    expect(lexicalFamily("databricks")).toBe("mysql");
    expect(lexicalFamily("hive")).toBe("mysql");
  });

  it("falls back to ansi for the portable subset and any unrecognized dialect", () => {
    expect(lexicalFamily("ansi")).toBe("ansi");
    expect(lexicalFamily("cql")).toBe("ansi");
    expect(lexicalFamily("")).toBe("ansi");
  });

  it("polices a BigQuery query with backtick-quoted tables under the mysql family", () => {
    // A BigQuery table reference uses backticks; the mysql-family lexer decodes
    // the identifier so the allowlist match works and injection past it fails.
    const policy: QueryPolicy = {
      dialect: lexicalFamily("bigquery"),
      allowedStatements: ["select"],
      singleStatementOnly: true,
      forbidComments: true,
      allowedTables: ["events"],
    };
    const ok = checkQuery("SELECT id FROM `events` LIMIT 10", policy);
    expect(ok.ok).toBe(true);
    const bad = checkQuery("SELECT id FROM `secrets` LIMIT 10", policy);
    expect(bad.ok).toBe(false);
  });
});

describe("tokenize", () => {
  it("keeps string literals whole, including doubled-quote escapes", () => {
    const r = tokenize("SELECT 'O''Brien' FROM t", "ansi");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const strings = r.tokens.filter((t) => t.kind === "string");
    expect(strings).toHaveLength(1);
    expect(strings[0]?.value).toBe("O'Brien");
  });

  it("fails closed on an unterminated string", () => {
    const r = tokenize("SELECT 'oops FROM t", "ansi");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("unterminated_string");
  });

  it("fails closed on an unterminated block comment", () => {
    const r = tokenize("SELECT 1 /* never ends", "ansi");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("unterminated_comment");
  });

  it("recognizes -- and /* */ comments as comment tokens", () => {
    const r = tokenize("SELECT 1 -- trailing\n/* block */ FROM t", "ansi");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tokens.filter((t) => t.kind === "comment")).toHaveLength(2);
  });

  it("treats a postgres dollar-quoted body as one string, never as code", () => {
    const r = tokenize("SELECT $tag$ ; DROP TABLE users $tag$", "postgres");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sig = significantTokens(r.tokens);
    // Everything after SELECT is one string — no DROP/TABLE words leak out.
    expect(sig.some((t) => t.kind === "word" && t.value === "drop")).toBe(false);
    expect(sig.filter((t) => t.kind === "string")).toHaveLength(1);
  });

  it("honors mysql backslash escapes so '' inside is not misread", () => {
    const r = tokenize("SELECT 'a\\'; DROP' FROM t", "mysql");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The backslash-escaped quote keeps the string open through `; DROP`.
    expect(r.tokens.filter((t) => t.kind === "string")).toHaveLength(1);
  });
});

const SELECT_ONLY: QueryPolicy = { dialect: "ansi", allowedStatements: ["select"], maxRows: 1000 };

describe("checkQuery — structural policy", () => {
  it("permits a bounded single SELECT", () => {
    const r = checkQuery("SELECT name FROM accounts WHERE region = 'US' LIMIT 50", SELECT_ONLY);
    expect(r.ok).toBe(true);
    expect(r.statementClass).toBe("select");
  });

  it("refuses a stacked second statement", () => {
    const r = checkQuery("SELECT 1 FROM t LIMIT 1; DROP TABLE users", SELECT_ONLY);
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.code)).toContain("multiple_statements");
  });

  it("refuses a non-SELECT statement class", () => {
    const r = checkQuery("DELETE FROM users WHERE id = 1", SELECT_ONLY);
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.code)).toContain("statement_not_allowed");
    expect(r.statementClass).toBe("delete");
  });

  it("refuses an embedded comment", () => {
    const r = checkQuery("SELECT 1 FROM t -- sneaky\n LIMIT 1", SELECT_ONLY);
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.code)).toContain("comment_forbidden");
  });

  it("requires a LIMIT and caps it", () => {
    expect(checkQuery("SELECT * FROM t", SELECT_ONLY).violations.map((v) => v.code)).toContain(
      "limit_required",
    );
    expect(
      checkQuery("SELECT * FROM t LIMIT 5000", SELECT_ONLY).violations.map((v) => v.code),
    ).toContain("limit_exceeds_max");
  });

  it("enforces a table allowlist on FROM/JOIN positions", () => {
    const policy: QueryPolicy = { ...SELECT_ONLY, allowedTables: ["accounts"] };
    expect(checkQuery("SELECT * FROM accounts LIMIT 1", policy).ok).toBe(true);
    const bad = checkQuery("SELECT * FROM secrets LIMIT 1", policy);
    expect(bad.ok).toBe(false);
    expect(bad.violations.map((v) => v.code)).toContain("table_not_allowed");
  });

  it("fails closed when the query does not tokenize", () => {
    const r = checkQuery("SELECT 'unterminated FROM t", SELECT_ONLY);
    expect(r.ok).toBe(false);
    expect(r.violations[0]?.code).toBe("tokenize_failed");
  });
});

describe("analyzeTemplate", () => {
  it("resolves an in-string placeholder as a string context", () => {
    const a = analyzeTemplate("SELECT name FROM t WHERE branch = '{branch}' LIMIT 10", "ansi");
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.sites).toEqual([{ name: "branch", context: { kind: "string", quote: "'" } }]);
  });

  it("resolves a bare value placeholder as a numeric context", () => {
    const a = analyzeTemplate("SELECT * FROM t LIMIT {n}", "ansi");
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.sites).toEqual([{ name: "n", context: { kind: "numeric" } }]);
  });

  it("rejects a placeholder in an identifier position", () => {
    const a = analyzeTemplate("SELECT * FROM {table} LIMIT 1", "ansi");
    expect(a.ok).toBe(false);
    if (a.ok) return;
    expect(a.code).toBe("placeholder_in_identifier_position");
  });

  it("rejects a placeholder in a qualified-name position", () => {
    const a = analyzeTemplate("SELECT {schema}.col FROM t", "ansi");
    expect(a.ok).toBe(false);
  });
});

describe("renderTemplate — injection is grammatically impossible", () => {
  const TEMPLATE = "SELECT name FROM accounts WHERE branch = '{branch}' LIMIT 10";

  it("escapes a quote-breakout attempt into an inert literal", () => {
    const r = renderTemplate(TEMPLATE, { branch: "x' OR '1'='1" }, "ansi");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.query).toBe("SELECT name FROM accounts WHERE branch = 'x'' OR ''1''=''1' LIMIT 10");
    // The rendered query still tokenizes to exactly one string in that slot.
    const tok = tokenize(r.query, "ansi");
    expect(tok.ok).toBe(true);
    if (!tok.ok) return;
    expect(tok.tokens.filter((t) => t.kind === "string")).toHaveLength(1);
  });

  it("neutralizes a stacked-statement payload — it stays inside the literal", () => {
    const r = renderTemplate(TEMPLATE, { branch: "'; DROP TABLE users; --" }, "ansi");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const check = checkQuery(r.query, {
      dialect: "ansi",
      allowedStatements: ["select"],
      maxRows: 100,
    });
    expect(check.ok).toBe(true); // no second statement, no comment escaped out
  });

  it("requires a numeric value for a bare numeric placeholder", () => {
    const t = "SELECT * FROM t LIMIT {n}";
    expect(renderTemplate(t, { n: 25 }, "ansi")).toEqual({
      ok: true,
      query: "SELECT * FROM t LIMIT 25",
    });
    const bad = renderTemplate(t, { n: "5; DROP TABLE users" }, "ansi");
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.code).toBe("non_numeric_value");
  });

  it("refuses to render an unanalyzable template rather than splice raw", () => {
    const r = renderTemplate("SELECT * FROM {table}", { table: "accounts" }, "ansi");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("unanalyzable_template");
  });

  it("doubles backslashes for mysql so a trailing backslash cannot escape the quote", () => {
    // value ending in a backslash would, unescaped, turn the closing quote into
    // an escaped quote and keep the string open.
    expect(escapeStringLiteralBody("a\\", "mysql")).toBe("a\\\\");
    expect(escapeStringLiteralBody("a\\", "ansi")).toBe("a\\");
  });
});
