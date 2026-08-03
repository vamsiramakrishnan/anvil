/**
 * A security-focused SQL tokenizer. Its job is NOT to understand what a query
 * means — it is to expose the lexical structure that injection hides in:
 * string boundaries, comment boundaries, statement separators, and where a
 * value sits relative to identifiers and keywords. Every ambiguity resolves
 * toward refusal: an unterminated string, comment, or dollar-quote is a
 * tokenize error, never "read the rest as code".
 *
 * Deliberately dependency-free and dialect-parameterized so `@anvil/mcp-runtime`
 * (the deployed unit) can load it without pulling a multi-megabyte parser.
 */

export type SqlDialect = "postgres" | "mysql" | "ansi";

/**
 * Collapse a broad, warehouse-named SQL dialect (as authored on an AIR
 * `queryPolicy`/`queryTemplate`) onto one of the three *lexical* families this
 * tokenizer implements. The deployed runtime deliberately keeps only three
 * families — growing it per-warehouse would put warehouse-specific lexing on the
 * safety hot path — so each warehouse maps to the family that shares its
 * security-relevant lexical forms (identifier quoting, comment markers, string
 * escaping):
 *
 * - `bigquery`, `databricks`/`hive`/`spark` → **mysql** family: backtick-quoted
 *   identifiers and backslash string escapes (BigQuery also honors `#` line
 *   comments — a `#` outside a string in a Databricks query would be over-read
 *   as a comment and, if `forbidComments`, refused; fail-closed and rare).
 * - `snowflake`, `redshift` → **postgres** family: dollar-quoted string bodies
 *   (Snowflake procedures, Redshift is Postgres-derived) and `"`-quoted
 *   identifiers.
 * - everything else, including an unrecognized dialect → **ansi**, the portable
 *   subset.
 *
 * This governs only the runtime tokenizer's fail-closed lexing. The precise,
 * warehouse-specific grammar lives in the compiler's authoring-time analyzer
 * (`node-sql-parser`), never in the deployed unit.
 */
export function lexicalFamily(dialect: string): SqlDialect {
  switch (dialect) {
    case "postgres":
    case "redshift":
    case "snowflake":
      return "postgres";
    case "mysql":
    case "bigquery":
    case "databricks":
    case "hive":
    case "spark":
    case "sparksql":
      return "mysql";
    default:
      return "ansi";
  }
}

export type TokenKind =
  | "word" // keyword or bare identifier (not yet distinguished)
  | "quoted_identifier" // "x" / `x` / [x]
  | "string" // '...'  (and dialect string forms)
  | "number"
  | "punct" // operators and separators, including ;
  | "placeholder" // ? $1 :name @name — a bound-parameter marker
  | "comment"; // -- ... , # ... , /* ... */

export interface Token {
  kind: TokenKind;
  /** Raw source slice, verbatim (including quotes/comment markers). */
  raw: string;
  /**
   * For `word`, the lowercased bare text (keyword matching). For
   * `quoted_identifier` and `string`, the DECODED inner value with quote
   * escaping resolved — so a policy can compare identifiers and a renderer can
   * reason about literal contents without re-lexing.
   */
  value: string;
  /** 0-based offset of the token's first character in the source. */
  start: number;
  /** Offset one past the token's last character. */
  end: number;
}

export interface TokenizeOk {
  ok: true;
  tokens: Token[];
}
export interface TokenizeErr {
  ok: false;
  /** Stable, machine-actionable reason. */
  code:
    | "unterminated_string"
    | "unterminated_comment"
    | "unterminated_identifier"
    | "unterminated_dollar_quote"
    | "unsupported_character";
  message: string;
  /** Offset where the problem was detected. */
  at: number;
}
export type TokenizeResult = TokenizeOk | TokenizeErr;

const WHITESPACE = new Set([" ", "\t", "\r", "\n", "\f", "\v"]);

function isWordStart(ch: string): boolean {
  // ASCII letters/underscore, or any non-ASCII code point (unicode identifiers).
  return /[A-Za-z_]/.test(ch) || ch.charCodeAt(0) >= 0x80;
}
function isWordPart(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch) || ch.charCodeAt(0) >= 0x80;
}
function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

/**
 * Tokenize `sql` under `dialect`. Comments are RETAINED as tokens (a policy may
 * refuse them, and dropping them would hide an injection vector); callers decide
 * what to do with them. Returns a typed error rather than throwing so the
 * runtime hot path can fail closed without a try/catch.
 */
export function tokenize(sql: string, dialect: SqlDialect = "ansi"): TokenizeResult {
  const tokens: Token[] = [];
  const n = sql.length;
  let i = 0;

  const err = (code: TokenizeErr["code"], message: string, at: number): TokenizeErr => ({
    ok: false,
    code,
    message,
    at,
  });

  while (i < n) {
    const ch = sql[i] as string;

    // Whitespace — skipped, never a token.
    if (WHITESPACE.has(ch)) {
      i++;
      continue;
    }

    // Line comment: --  (ansi/all) or #  (mysql only).
    if ((ch === "-" && sql[i + 1] === "-") || (ch === "#" && dialect === "mysql")) {
      const start = i;
      while (i < n && sql[i] !== "\n") i++;
      tokens.push({ kind: "comment", raw: sql.slice(start, i), value: "", start, end: i });
      continue;
    }

    // Block comment: /* ... */  (no nesting assumed — refuse if unterminated).
    if (ch === "/" && sql[i + 1] === "*") {
      const start = i;
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      if (i >= n) return err("unterminated_comment", "Unterminated block comment.", start);
      i += 2;
      tokens.push({ kind: "comment", raw: sql.slice(start, i), value: "", start, end: i });
      continue;
    }

    // String literal: '...'  with '' escaping (all dialects). MySQL also honors
    // backslash escapes, so a trailing backslash must not let '' be misread.
    if (ch === "'") {
      const start = i;
      i++;
      let value = "";
      let terminated = false;
      while (i < n) {
        const c = sql[i] as string;
        if (dialect === "mysql" && c === "\\") {
          // Backslash escape: consume the next char verbatim into the value.
          if (i + 1 >= n) break;
          value += sql[i + 1];
          i += 2;
          continue;
        }
        if (c === "'") {
          if (sql[i + 1] === "'") {
            value += "'";
            i += 2;
            continue;
          }
          terminated = true;
          i++;
          break;
        }
        value += c;
        i++;
      }
      if (!terminated) return err("unterminated_string", "Unterminated string literal.", start);
      tokens.push({ kind: "string", raw: sql.slice(start, i), value, start, end: i });
      continue;
    }

    // Postgres dollar-quoted string: $tag$ ... $tag$  (tag may be empty: $$).
    if (ch === "$" && dialect === "postgres") {
      const tagMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tagMatch) {
        const start = i;
        const opener = tagMatch[0];
        const bodyStart = i + opener.length;
        const closeIdx = sql.indexOf(opener, bodyStart);
        if (closeIdx === -1) {
          return err("unterminated_dollar_quote", "Unterminated dollar-quoted string.", start);
        }
        i = closeIdx + opener.length;
        tokens.push({
          kind: "string",
          raw: sql.slice(start, i),
          value: sql.slice(bodyStart, closeIdx),
          start,
          end: i,
        });
        continue;
      }
      // Otherwise `$` begins a placeholder ($1) — handled below.
    }

    // Quoted identifiers.
    const idQuote = quotedIdentifierBounds(ch, dialect);
    if (idQuote) {
      const start = i;
      i++;
      let value = "";
      let terminated = false;
      while (i < n) {
        const c = sql[i] as string;
        if (c === idQuote.close) {
          // Standard doubling escape inside "" and `` (not [] which has no escape).
          if (idQuote.doubles && sql[i + 1] === idQuote.close) {
            value += idQuote.close;
            i += 2;
            continue;
          }
          terminated = true;
          i++;
          break;
        }
        value += c;
        i++;
      }
      if (!terminated) {
        return err("unterminated_identifier", "Unterminated quoted identifier.", start);
      }
      tokens.push({ kind: "quoted_identifier", raw: sql.slice(start, i), value, start, end: i });
      continue;
    }

    // Bound-parameter placeholders: ?  $1  :name  @name.
    if (ch === "?") {
      tokens.push({ kind: "placeholder", raw: "?", value: "?", start: i, end: i + 1 });
      i++;
      continue;
    }
    if (ch === "$" && isDigit(sql[i + 1] ?? "")) {
      const start = i;
      i++;
      while (i < n && isDigit(sql[i] as string)) i++;
      tokens.push({
        kind: "placeholder",
        raw: sql.slice(start, i),
        value: sql.slice(start, i),
        start,
        end: i,
      });
      continue;
    }
    if ((ch === ":" || ch === "@") && isWordStart(sql[i + 1] ?? "")) {
      const start = i;
      i++;
      while (i < n && isWordPart(sql[i] as string)) i++;
      tokens.push({
        kind: "placeholder",
        raw: sql.slice(start, i),
        value: sql.slice(start, i),
        start,
        end: i,
      });
      continue;
    }

    // Numbers (kept simple: leading digit or .digit; exponents/hex fold into word rules loosely).
    if (isDigit(ch) || (ch === "." && isDigit(sql[i + 1] ?? ""))) {
      const start = i;
      while (i < n && /[0-9._eExXaAbBcCdDfF+-]/.test(sql[i] as string)) {
        // Stop at a `+`/`-` that is not part of an exponent, so `1-2` splits.
        const c = sql[i] as string;
        if ((c === "+" || c === "-") && !/[eE]/.test(sql[i - 1] ?? "")) break;
        i++;
      }
      tokens.push({
        kind: "number",
        raw: sql.slice(start, i),
        value: sql.slice(start, i),
        start,
        end: i,
      });
      continue;
    }

    // Words: keywords and bare identifiers.
    if (isWordStart(ch)) {
      const start = i;
      i++;
      while (i < n && isWordPart(sql[i] as string)) i++;
      const raw = sql.slice(start, i);
      tokens.push({ kind: "word", raw, value: raw.toLowerCase(), start, end: i });
      continue;
    }

    // Punctuation / operators. Multi-char operators are not merged; the
    // structural validator only cares about `;` and parentheses, and single
    // chars are sufficient and safe for that.
    if (/[-+*/%<>=!~^&|(),.;:[\]{}@#]/.test(ch)) {
      tokens.push({ kind: "punct", raw: ch, value: ch, start: i, end: i + 1 });
      i++;
      continue;
    }

    return err("unsupported_character", `Unsupported character '${ch}'.`, i);
  }

  return { ok: true, tokens };
}

function quotedIdentifierBounds(
  ch: string,
  dialect: SqlDialect,
): { close: string; doubles: boolean } | undefined {
  if (ch === '"') return { close: '"', doubles: true };
  if (ch === "`" && dialect === "mysql") return { close: "`", doubles: true };
  if (ch === "[") return { close: "]", doubles: false };
  return undefined;
}

/** Tokens that carry meaning for the structural validator (comments stripped). */
export function significantTokens(tokens: Token[]): Token[] {
  return tokens.filter((t) => t.kind !== "comment");
}
