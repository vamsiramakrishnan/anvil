/**
 * The adversarial battery. Two obligations:
 *  1. A corpus of real injection techniques must ALL be refused by a standard
 *     SELECT-only policy — the surface's safety claim, made concrete.
 *  2. Mutation testing: each guard, when weakened, must let a payload through
 *     that it otherwise catches. This proves every guard is load-bearing —
 *     a guard nothing depends on is a guard that can rot silently.
 */

import { describe, expect, it } from "vitest";
import { checkQuery, type QueryPolicy } from "./policy.js";
import { renderTemplate } from "./template.js";

const STRICT: QueryPolicy = {
  dialect: "postgres",
  allowedStatements: ["select"],
  singleStatementOnly: true,
  forbidComments: true,
  maxRows: 1000,
  allowedTables: ["accounts", "ledger"],
};

/** Every one of these must be refused by the strict policy. */
const INJECTION_CORPUS: Array<{ name: string; sql: string }> = [
  { name: "stacked drop", sql: "SELECT * FROM accounts LIMIT 1; DROP TABLE accounts" },
  { name: "stacked delete", sql: "SELECT 1 FROM ledger LIMIT 1;DELETE FROM ledger" },
  { name: "comment-terminated tail", sql: "SELECT * FROM accounts LIMIT 1 -- AND 1=1" },
  { name: "block-comment splice", sql: "SELECT */**/FROM accounts LIMIT 1" },
  {
    name: "union to another table",
    sql: "SELECT id FROM accounts UNION SELECT id FROM secrets LIMIT 1",
  },
  { name: "outfile exfiltration", sql: "SELECT * FROM accounts INTO OUTFILE '/tmp/x' LIMIT 1" },
  { name: "delete disguised", sql: "DELETE FROM accounts WHERE 1=1" },
  { name: "update disguised", sql: "UPDATE accounts SET balance = 0" },
  { name: "unbounded read", sql: "SELECT * FROM accounts" },
  { name: "over-limit read", sql: "SELECT * FROM accounts LIMIT 100000" },
  { name: "off-allowlist table", sql: "SELECT * FROM pg_shadow LIMIT 1" },
  { name: "unterminated string", sql: "SELECT * FROM accounts WHERE x = 'oops LIMIT 1" },
  { name: "call procedure", sql: "CALL do_dangerous_thing()" },
];

describe("adversarial battery — injection corpus is refused wholesale", () => {
  for (const { name, sql } of INJECTION_CORPUS) {
    it(`refuses: ${name}`, () => {
      expect(checkQuery(sql, STRICT).ok).toBe(false);
    });
  }

  it("union to an off-allowlist table is caught by the table guard", () => {
    const r = checkQuery("SELECT id FROM accounts UNION SELECT id FROM secrets LIMIT 1", STRICT);
    expect(r.violations.map((v) => v.code)).toContain("table_not_allowed");
  });
});

describe("mutation testing — each guard is load-bearing", () => {
  // For each guard, disable it and prove a payload that the guard catches now
  // slips through the OTHER guards. If a payload still fails with the guard
  // disabled, the guard was not the thing protecting against it — the test
  // would (correctly) fail, flagging a dependency that has quietly moved.

  it("statement-class guard is the only thing stopping a DELETE", () => {
    const sql = "DELETE FROM accounts WHERE id = 1";
    expect(checkQuery(sql, STRICT).ok).toBe(false);
    const weakened: QueryPolicy = { ...STRICT, allowedStatements: ["select", "delete"] };
    // With DELETE allowed, this specific payload must now pass — nothing else
    // in the policy was catching it.
    expect(checkQuery(sql, weakened).ok).toBe(true);
  });

  it("single-statement guard is the only thing stopping a stacked statement", () => {
    const sql = "SELECT * FROM accounts LIMIT 1; SELECT * FROM ledger LIMIT 1";
    expect(checkQuery(sql, STRICT).ok).toBe(false);
    const weakened: QueryPolicy = { ...STRICT, singleStatementOnly: false };
    expect(checkQuery(sql, weakened).ok).toBe(true);
  });

  it("comment guard is the only thing stopping an embedded comment", () => {
    const sql = "SELECT * FROM accounts LIMIT 1 /* note */";
    expect(checkQuery(sql, STRICT).ok).toBe(false);
    const weakened: QueryPolicy = { ...STRICT, forbidComments: false };
    expect(checkQuery(sql, weakened).ok).toBe(true);
  });

  it("row-bound guard is the only thing stopping an unbounded read", () => {
    const sql = "SELECT * FROM accounts";
    expect(checkQuery(sql, STRICT).ok).toBe(false);
    const weakened: QueryPolicy = { ...STRICT, maxRows: undefined };
    expect(checkQuery(sql, weakened).ok).toBe(true);
  });

  it("table allowlist is the only thing stopping an off-allowlist read", () => {
    const sql = "SELECT * FROM pg_shadow LIMIT 1";
    expect(checkQuery(sql, STRICT).ok).toBe(false);
    const weakened: QueryPolicy = { ...STRICT, allowedTables: undefined };
    expect(checkQuery(sql, weakened).ok).toBe(true);
  });
});

describe("template rendering neutralizes the same corpus inside a literal", () => {
  const TEMPLATE = "SELECT name FROM accounts WHERE branch = '{branch}' LIMIT 10";

  const payloads = [
    "' OR 1=1 --",
    "'; DROP TABLE accounts; --",
    "' UNION SELECT password FROM secrets --",
    "x' /* */ OR '1'='1",
  ];

  for (const payload of payloads) {
    it(`keeps a payload inert inside the literal: ${payload.slice(0, 20)}…`, () => {
      const r = renderTemplate(TEMPLATE, { branch: payload }, "postgres");
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      // The rendered query passes a strict policy: the payload never escaped
      // the string literal it was written into.
      const verdict = checkQuery(r.query, STRICT);
      expect(verdict.ok).toBe(true);
    });
  }
});
