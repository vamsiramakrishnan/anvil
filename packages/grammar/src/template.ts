/**
 * Grammar-aware query-template substitution. The old renderer spliced values in
 * as raw characters and shipped a documented caveat: a value containing a quote
 * could still terminate the surrounding string literal. This module removes the
 * caveat rather than restating it — each placeholder's lexical CONTEXT is
 * resolved once, and values are substituted as properly escaped literals for
 * exactly that context. A value can never leave the literal it was written in.
 */

import { type SqlDialect, significantTokens, type Token, tokenize } from "./tokenize.js";

/** Where a `{param}` placeholder sits in the template's lexical structure. */
export type PlaceholderContext =
  | { kind: "string"; quote: "'" } // inside a '...' string literal
  | { kind: "numeric" }; // a bare value position that must render as a number

export interface PlaceholderSite {
  name: string;
  context: PlaceholderContext;
}

interface TemplateAnalysisOk {
  ok: true;
  sites: PlaceholderSite[];
}
interface TemplateAnalysisErr {
  ok: false;
  code: "tokenize_failed" | "placeholder_in_identifier_position" | "nested_or_adjacent_placeholder";
  message: string;
  /** The placeholder name (or offset) the error concerns. */
  detail: string;
}
export type TemplateAnalysis = TemplateAnalysisOk | TemplateAnalysisErr;

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Keywords after which an identifier — not a literal — is expected. */
const IDENTIFIER_ANCHORS = new Set(["from", "join", "into", "update", "table"]);

/**
 * Resolve every `{param}` placeholder's lexical context, or explain why the
 * template is unsafe. This is the COMPILE-TIME gate: a placeholder in an
 * identifier position (e.g. `FROM {table}`) or an unresolvable position is
 * rejected here, so it can never reach the runtime renderer.
 */
export function analyzeTemplate(template: string, dialect: SqlDialect = "ansi"): TemplateAnalysis {
  const insideString = stringMask(template, dialect);

  // Partition placeholders into string-context (inside a '...' literal) and
  // bare-context (everything else). Bare placeholders are probed with `?`.
  const stringSites: PlaceholderSite[] = [];
  const bareOrder: string[] = [];
  for (const m of template.matchAll(PLACEHOLDER)) {
    const name = m[1] as string;
    const start = m.index ?? 0;
    if (insideString[start]) {
      stringSites.push({ name, context: { kind: "string", quote: "'" } });
    } else {
      bareOrder.push(name);
    }
  }

  const probed = template.replace(PLACEHOLDER, (whole, _name: string, offset: number) =>
    insideString[offset] ? whole : "?",
  );
  const tok = tokenize(probed, dialect);
  if (!tok.ok) {
    return {
      ok: false,
      code: "tokenize_failed",
      message: `Template does not tokenize: ${tok.message}`,
      detail: String(tok.at),
    };
  }
  const sig = significantTokens(tok.tokens);
  const markers = sig.filter((t) => t.kind === "placeholder" && t.value === "?");
  if (markers.length !== bareOrder.length) {
    return {
      ok: false,
      code: "nested_or_adjacent_placeholder",
      message:
        "A bare placeholder did not resolve to exactly one token; keep placeholders separated by SQL syntax.",
      detail: bareOrder.join(", "),
    };
  }

  const bareSites: PlaceholderSite[] = [];
  for (let m = 0; m < markers.length; m++) {
    const name = bareOrder[m] as string;
    const pos = sig.indexOf(markers[m] as Token);
    const prev = sig[pos - 1];
    const next = sig[pos + 1];
    const dotAdjacent =
      (prev?.kind === "punct" && prev.value === ".") ||
      (next?.kind === "punct" && next.value === "."); // qualified name: {x}.col or col.{x}
    if ((prev?.kind === "word" && IDENTIFIER_ANCHORS.has(prev.value)) || dotAdjacent) {
      return {
        ok: false,
        code: "placeholder_in_identifier_position",
        message: `Placeholder '{${name}}' sits in an identifier position (after FROM/JOIN/INTO/UPDATE/TABLE or a qualified name); only literal positions are allowed.`,
        detail: name,
      };
    }
    bareSites.push({ name, context: { kind: "numeric" } });
  }

  // A name used in both a string and a bare position keeps the string context
  // (the stricter escape); dedupe by name, string wins.
  const byName = new Map<string, PlaceholderSite>();
  for (const s of [...bareSites, ...stringSites]) {
    const existing = byName.get(s.name);
    if (!existing || (existing.context.kind === "numeric" && s.context.kind === "string")) {
      byName.set(s.name, s);
    }
  }
  return { ok: true, sites: [...byName.values()] };
}

/** Boolean mask: mask[i] is true when character i sits inside a '...' literal. */
function stringMask(sql: string, dialect: SqlDialect): boolean[] {
  const mask = new Array<boolean>(sql.length).fill(false);
  let i = 0;
  const n = sql.length;
  while (i < n) {
    if (sql[i] === "'") {
      const open = i;
      i++;
      while (i < n) {
        if (dialect === "mysql" && sql[i] === "\\") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      // Interior only (between the quotes) counts as inside-string.
      for (let k = open + 1; k < i - 1 && k < n; k++) mask[k] = true;
      continue;
    }
    i++;
  }
  return mask;
}

export interface RenderOk {
  ok: true;
  query: string;
}
export interface RenderErr {
  ok: false;
  code: "unanalyzable_template" | "non_numeric_value" | "missing_value";
  message: string;
  detail: string;
}
export type RenderResult = RenderOk | RenderErr;

/**
 * Render a template by substituting each placeholder as an escaped literal for
 * its resolved context. String placeholders get quote-escaped for the dialect;
 * numeric (bare) placeholders must be finite numbers and render as their
 * canonical decimal form. Any value that cannot render safely is refused — the
 * renderer never falls back to raw splicing.
 */
export function renderTemplate(
  template: string,
  values: Record<string, unknown>,
  dialect: SqlDialect = "ansi",
): RenderResult {
  const analysis = analyzeTemplate(template, dialect);
  if (!analysis.ok) {
    return {
      ok: false,
      code: "unanalyzable_template",
      message: analysis.message,
      detail: analysis.detail,
    };
  }
  const contextByName = new Map(analysis.sites.map((s) => [s.name, s.context]));

  let out = "";
  let last = 0;
  for (const m of template.matchAll(PLACEHOLDER)) {
    const name = m[1] as string;
    const start = m.index ?? 0;
    out += template.slice(last, start);
    last = start + m[0].length;

    if (!(name in values) || values[name] === undefined || values[name] === null) {
      return {
        ok: false,
        code: "missing_value",
        message: `No value supplied for '{${name}}'.`,
        detail: name,
      };
    }
    const context = contextByName.get(name) ?? { kind: "string", quote: "'" as const };
    const raw = values[name];
    if (context.kind === "numeric") {
      const num = typeof raw === "number" ? raw : Number(raw);
      if (String(raw).trim() === "" || !Number.isFinite(num)) {
        return {
          ok: false,
          code: "non_numeric_value",
          message: `Value for bare placeholder '{${name}}' must be numeric; got ${JSON.stringify(raw)}.`,
          detail: name,
        };
      }
      out += String(num);
    } else {
      out += escapeStringLiteralBody(String(raw), dialect);
    }
  }
  out += template.slice(last);
  return { ok: true, query: out };
}

/**
 * Escape a value for insertion INSIDE an existing '...' literal (the template
 * already wrote the surrounding quotes). Doubling `'` is the standard SQL escape
 * and covers every dialect; MySQL additionally treats backslash as an escape
 * char, so backslashes are doubled there. NUL is stripped — it can terminate a
 * string early in some client protocols. The result can never terminate the
 * string it lives in.
 */
export function escapeStringLiteralBody(value: string, dialect: SqlDialect): string {
  const noNul = [...value].filter((c) => c.charCodeAt(0) !== 0).join("");
  if (dialect === "mysql") {
    return noNul.replace(/\\/g, "\\\\").replace(/'/g, "''");
  }
  return noNul.replace(/'/g, "''");
}
