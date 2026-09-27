/**
 * The fast path for reading a spec document into a plain JS value.
 *
 * A vendor spec is large: Jira's platform spec is 2.5MB of JSON and Microsoft
 * Graph's is 44MB of YAML. The `yaml` package's document model keeps a CST
 * node per scalar so it can report positions and round-trip comments, which
 * costs about 1.6s and 150MB for Jira and over 20s and 1.4GB for Graph. None
 * of that is needed when the document is well formed, so this module parses
 * with the fastest correct reader first and leaves located diagnostics to the
 * caller's `yaml` fallback:
 *
 * - Text that starts with `{` or `[` goes to `JSON.parse`.
 * - Other text goes to `js-yaml` with a schema that resolves plain scalars
 *   exactly as the `yaml` package's YAML 1.2 core schema does (the same
 *   patterns and the same number construction), so a document reads to the
 *   same value on either path.
 *
 * The fast path declines, and the caller falls back to `yaml`, whenever the
 * two readers could disagree or a limit matters: any parse error (the
 * fallback reports it with a line and column), a document that uses anchors
 * or merge keys (the `yaml` fallback enforces its alias-expansion limit and
 * its merge semantics), and an empty document.
 */
import jsyaml from "js-yaml";

export type FastParseResult = { ok: true; value: unknown } | { ok: false };

// The `yaml` package's core-schema scalar patterns, verbatim
// (yaml/dist/schema/core). Anything else is a string.
const NULL = /^(?:~|[Nn]ull|NULL)?$/;
const BOOL = /^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$/;
const INT_DEC = /^[-+]?[0-9]+$/;
const INT_OCT = /^0o[0-7]+$/;
const INT_HEX = /^0x[0-9a-fA-F]+$/;
const FLOAT_NAN = /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/;
const FLOAT_EXP = /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$/;
const FLOAT = /^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$/;

const coreInt = new jsyaml.Type("tag:yaml.org,2002:int", {
  kind: "scalar",
  resolve: (data: unknown) =>
    typeof data === "string" && (INT_DEC.test(data) || INT_OCT.test(data) || INT_HEX.test(data)),
  construct: (data: string) => {
    if (INT_OCT.test(data)) return Number.parseInt(data.substring(2), 8);
    if (INT_HEX.test(data)) return Number.parseInt(data.substring(2), 16);
    return Number.parseInt(data, 10);
  },
  predicate: (value: unknown) => typeof value === "number" && Number.isInteger(value),
});

const coreFloat = new jsyaml.Type("tag:yaml.org,2002:float", {
  kind: "scalar",
  resolve: (data: unknown) =>
    typeof data === "string" && (FLOAT_NAN.test(data) || FLOAT_EXP.test(data) || FLOAT.test(data)),
  construct: (data: string) => {
    if (FLOAT_NAN.test(data)) {
      if (data.slice(-3).toLowerCase() === "nan") return Number.NaN;
      return data[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
    }
    return Number.parseFloat(data);
  },
  predicate: (value: unknown) => typeof value === "number",
});

const coreNull = new jsyaml.Type("tag:yaml.org,2002:null", {
  kind: "scalar",
  resolve: (data: unknown) => data === null || (typeof data === "string" && NULL.test(data)),
  construct: () => null,
  predicate: (value: unknown) => value === null,
});

const coreBool = new jsyaml.Type("tag:yaml.org,2002:bool", {
  kind: "scalar",
  resolve: (data: unknown) => typeof data === "string" && BOOL.test(data),
  construct: (data: string) => data[0] === "t" || data[0] === "T",
  predicate: (value: unknown) => typeof value === "boolean",
});

/**
 * js-yaml's failsafe schema (map, seq, str) plus the four core scalar types
 * above. js-yaml's own int and float are not used: they accept `_` separators
 * and `0b` binary, which the core schema reads as strings.
 */
const CORE_SCHEMA = jsyaml.FAILSAFE_SCHEMA.extend({
  implicit: [coreNull, coreBool, coreInt, coreFloat],
});

/**
 * An anchor (`&name`) or a merge key (`<<`) sends the document to the `yaml`
 * fallback. The test errs toward declining: `&` inside a quoted description
 * also matches, which costs speed, never correctness.
 */
const ANCHOR_OR_MERGE = /(?:^|[\s[{,:-])&[^\s,[\]{}]|<</m;

/** Parse spec text on the fast path, or decline so the caller can fall back. */
export function fastParseSpecText(text: string): FastParseResult {
  const start = firstSignificantChar(text);
  if (start === undefined) return { ok: false };
  if (start === "{" || start === "[") {
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch {
      // Not strict JSON (a comment, a trailing comma, or a real error). YAML
      // may still read it; the js-yaml attempt below or the caller decides.
    }
  }
  if (ANCHOR_OR_MERGE.test(text)) return { ok: false };
  try {
    return { ok: true, value: jsyaml.load(text, { schema: CORE_SCHEMA }) };
  } catch {
    return { ok: false };
  }
}

function firstSignificantChar(text: string): string | undefined {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (ch === "﻿" || ch === " " || ch === "\t" || ch === "\n" || ch === "\r") continue;
    return ch;
  }
  return undefined;
}
