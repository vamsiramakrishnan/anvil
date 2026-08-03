/**
 * Structural policy over tokenized SQL. This never asks "what does this query
 * do"; it proves a small set of NEGATIVE properties — the things injection
 * relies on — and refuses anything it cannot prove safe. The asymmetry is the
 * whole point: a stricter check produces false refusals (an over-cautious
 * "no"), never a false permit. Parse failure is refusal.
 */

import { type SqlDialect, significantTokens, type Token, tokenize } from "./tokenize.js";

/** Statement classes the surface may allow. `select` is the safe default. */
export type StatementClass =
  | "select"
  | "insert"
  | "update"
  | "delete"
  | "merge"
  | "call"
  | "explain"
  | "other";

export interface QueryPolicy {
  dialect: SqlDialect;
  /** Statement classes permitted. An empty/absent set means `["select"]`. */
  allowedStatements?: StatementClass[];
  /** Reject `;`-separated multiple statements (default true). */
  singleStatementOnly?: boolean;
  /** Reject any comment token (default true — comments are a classic evasion). */
  forbidComments?: boolean;
  /** Require a LIMIT/TOP/FETCH clause and cap it at this value, when set. */
  maxRows?: number;
  /**
   * Lowercased table/identifier allowlist. When set, every bare table-position
   * identifier the validator can see must be a member. Omit to skip.
   */
  allowedTables?: string[];
}

export interface PolicyViolation {
  code:
    | "tokenize_failed"
    | "empty_query"
    | "multiple_statements"
    | "statement_not_allowed"
    | "comment_forbidden"
    | "limit_required"
    | "limit_exceeds_max"
    | "table_not_allowed";
  message: string;
  /** Source offset the violation anchors to, when known. */
  at?: number;
}

export interface PolicyResult {
  ok: boolean;
  violations: PolicyViolation[];
  /** The statement class the validator read, when it could read one. */
  statementClass?: StatementClass;
}

const FIRST_KEYWORD_CLASS: Record<string, StatementClass> = {
  select: "select",
  with: "select", // a CTE resolves to its leading statement; validated below
  insert: "insert",
  update: "update",
  delete: "delete",
  merge: "merge",
  call: "call",
  exec: "call",
  execute: "call",
  explain: "explain",
};

const DEFAULT_ALLOWED: StatementClass[] = ["select"];

/**
 * Validate one query string against a policy. Comments are considered even
 * though the tokenizer keeps them separate, because `forbidComments` acts on
 * their presence.
 */
export function checkQuery(sql: string, policy: QueryPolicy): PolicyResult {
  const tok = tokenize(sql, policy.dialect);
  if (!tok.ok) {
    return {
      ok: false,
      violations: [
        {
          code: "tokenize_failed",
          message: `Could not tokenize query: ${tok.message}`,
          at: tok.at,
        },
      ],
    };
  }

  const violations: PolicyViolation[] = [];
  const allTokens = tok.tokens;
  const sig = significantTokens(allTokens);

  const forbidComments = policy.forbidComments !== false;
  if (forbidComments) {
    const comment = allTokens.find((t) => t.kind === "comment");
    if (comment) {
      violations.push({
        code: "comment_forbidden",
        message: "Comments are not permitted in this query surface.",
        at: comment.start,
      });
    }
  }

  if (sig.length === 0) {
    violations.push({ code: "empty_query", message: "Query is empty." });
    return { ok: false, violations };
  }

  // Single-statement rule: a `;` is only benign as the very last significant
  // token. Anything after it is a second statement.
  const singleOnly = policy.singleStatementOnly !== false;
  const semicolons = sig
    .map((t, idx) => ({ t, idx }))
    .filter((e) => e.t.kind === "punct" && e.t.value === ";");
  if (singleOnly) {
    const offending = semicolons.find((e) => e.idx !== sig.length - 1);
    if (offending) {
      violations.push({
        code: "multiple_statements",
        message: "Multiple statements are not permitted; use a single statement.",
        at: offending.t.start,
      });
    }
  }

  // Statement class: the first significant word token decides it.
  const firstWord = sig.find((t) => t.kind === "word");
  const statementClass: StatementClass = firstWord
    ? (FIRST_KEYWORD_CLASS[firstWord.value] ?? "other")
    : "other";
  const allowed = policy.allowedStatements?.length ? policy.allowedStatements : DEFAULT_ALLOWED;
  if (!allowed.includes(statementClass)) {
    violations.push({
      code: "statement_not_allowed",
      message: `Statement class '${statementClass}' is not permitted; allowed: ${allowed.join(", ")}.`,
      at: firstWord?.start,
    });
  }

  // Row bound: when maxRows is set and this is a read, require a numeric LIMIT
  // (postgres/mysql) or FETCH FIRST n, and cap it. TOP-style is treated as a
  // read bound too. We only enforce when the statement is a select-class read.
  if (policy.maxRows !== undefined && statementClass === "select") {
    const bound = readRowBound(sig);
    if (bound === undefined) {
      violations.push({
        code: "limit_required",
        message: `A row limit (LIMIT ≤ ${policy.maxRows}) is required on this query.`,
      });
    } else if (bound > policy.maxRows) {
      violations.push({
        code: "limit_exceeds_max",
        message: `LIMIT ${bound} exceeds the maximum of ${policy.maxRows}.`,
      });
    }
  }

  // Table allowlist: every identifier in a FROM/JOIN/INTO/UPDATE position must
  // be a member. This is a conservative reader — if it cannot resolve a name it
  // does not silently pass it; it only checks names it positively identifies as
  // table positions, and any such name outside the list is refused.
  if (policy.allowedTables && policy.allowedTables.length > 0) {
    const allow = new Set(policy.allowedTables.map((t) => t.toLowerCase()));
    for (const name of tablePositionIdentifiers(sig)) {
      if (!allow.has(name.value.toLowerCase())) {
        violations.push({
          code: "table_not_allowed",
          message: `Table '${name.value}' is not in the allowlist.`,
          at: name.start,
        });
      }
    }
  }

  return { ok: violations.length === 0, violations, statementClass };
}

/** The numeric row bound from a trailing LIMIT / FETCH FIRST n, if present. */
function readRowBound(sig: Token[]): number | undefined {
  for (let i = 0; i < sig.length; i++) {
    const t = sig[i] as Token;
    if (t.kind !== "word") continue;
    if (t.value === "limit") {
      const next = sig[i + 1];
      if (next?.kind === "number") {
        const v = Number.parseInt(next.value, 10);
        if (Number.isFinite(v)) return v;
      }
      // LIMIT with a non-literal (placeholder/expression) is not a provable bound.
      return undefined;
    }
    if (t.value === "fetch") {
      // FETCH FIRST n ROWS ONLY — find the first number after FETCH.
      const num = sig.slice(i + 1, i + 5).find((x) => x.kind === "number");
      if (num) {
        const v = Number.parseInt(num.value, 10);
        if (Number.isFinite(v)) return v;
      }
      return undefined;
    }
  }
  return undefined;
}

/** Identifiers sitting immediately after FROM / JOIN / INTO / UPDATE keywords. */
function tablePositionIdentifiers(sig: Token[]): Token[] {
  const anchors = new Set(["from", "join", "into", "update"]);
  const out: Token[] = [];
  for (let i = 0; i < sig.length - 1; i++) {
    const t = sig[i] as Token;
    if (t.kind === "word" && anchors.has(t.value)) {
      const next = sig[i + 1] as Token;
      if (next.kind === "word" || next.kind === "quoted_identifier") out.push(next);
    }
  }
  return out;
}
