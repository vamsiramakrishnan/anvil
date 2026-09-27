import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { AirDocument } from "./schema.js";
import { type AirLoadOptions, migrateAir } from "./version.js";

/**
 * Validate and normalize an arbitrary object into a canonical AirDocument.
 * Every reader of an AIR document passes through here, so this is where the
 * format version is checked (a newer major version is refused, an older one
 * warns through `options.onWarning`) and where registered migrations run —
 * before schema validation, on the raw object, because a shape change is
 * exactly what the current schema cannot parse.
 */
export function loadAirDocument(data: unknown, options: AirLoadOptions = {}): AirDocument {
  return AirDocument.parse(migrateAir(data, options));
}

/** Parse an AIR document from YAML text (defaults applied, structure validated). */
export function airFromYaml(text: string, options: AirLoadOptions = {}): AirDocument {
  // The AIR is Anvil's OWN trusted, self-generated document — not an untrusted
  // upload. A large bundle legitimately repeats sub-structures (shared retry
  // condition lists, error shapes, schema fragments), and the `yaml` parser's
  // default anti-"billion laughs" cap of 100 aliases would reject a perfectly
  // valid bundle: PagerDuty's real 465-operation AIR serialized to 110 aliases,
  // so `anvil lint`/`certify` — which re-read air.yaml — failed on their own
  // output. Lift the cap for this trusted parse only; untrusted specs and
  // manifests are parsed elsewhere (parse.ts, manifest.ts) and keep the default
  // protection. Combined with `aliasDuplicateObjects: false` in `airToYaml`,
  // freshly generated bundles carry no aliases at all — this keeps already
  // written (or older) bundles loadable too.
  return loadAirDocument(parseYaml(text, { maxAliasCount: -1 }), options);
}

/** Parse an AIR document from JSON text. */
export function airFromJson(text: string, options: AirLoadOptions = {}): AirDocument {
  return loadAirDocument(JSON.parse(text), options);
}

/**
 * A string a YAML block scalar may not round-trip faithfully: any line with
 * trailing whitespace (which includes whitespace-only lines). Found on a real
 * spec (lgtm.com, via the corpus sweep): a description containing
 * `"...row.\n    \n\n..."` gained an extra newline through the pretty block-
 * scalar emission, silently drifting the contract hash.
 */
const RISKY_WHITESPACE = /[ \t](?:\r?\n|$)/;

/** True when any string anywhere in the value has YAML-risky whitespace. */
function containsRiskyWhitespace(value: unknown): boolean {
  if (typeof value === "string") return RISKY_WHITESPACE.test(value);
  if (Array.isArray(value)) return value.some(containsRiskyWhitespace);
  if (value !== null && typeof value === "object") {
    return Object.values(value).some(containsRiskyWhitespace);
  }
  return false;
}

/** Serialize an AIR document to canonical YAML (the on-disk `air.yaml`). */
export function airToYaml(air: AirDocument): string {
  // `aliasDuplicateObjects: false` — never emit YAML anchors/aliases for
  // repeated objects. The canonical air.yaml must be self-contained and
  // human-diffable (an `*alias` pointing elsewhere in a 20k-line file is
  // unreadable), and must re-parse without tripping the parser's alias-count
  // safety cap. This is what makes the serialize→parse round-trip robust on a
  // large bundle, not just the raised cap on the read side.
  const doc = AirDocument.parse(air);
  if (doc.operations.length > CHUNKED_YAML_MIN_OPERATIONS) {
    return losslessYaml(doc as unknown as Record<string, unknown>, true);
  }
  return losslessYaml(doc as unknown as Record<string, unknown>, false);
}

/**
 * Above this many operations the YAML is emitted one entry at a time (see
 * `chunkedYaml`). Below it the whole document is emitted at once, exactly as
 * before, so every existing bundle keeps its bytes.
 */
const CHUNKED_YAML_MIN_OPERATIONS = 500;

const PRETTY = { lineWidth: 100, aliasDuplicateObjects: false } as const;
const QUOTED = {
  lineWidth: 0,
  aliasDuplicateObjects: false,
  blockQuote: false,
  defaultStringType: "QUOTE_DOUBLE",
  doubleQuotedAsJSON: true,
} as const;

/**
 * Emit a document in pretty style, falling back to fully quoted style when
 * the pretty form would not round-trip. Chunked, the check and the fallback
 * apply per chunk, so one drifting description quotes only its own entry.
 */
function losslessYaml(doc: Record<string, unknown>, chunked: boolean): string {
  if (!chunked) return losslessChunk(doc);
  return chunkedYaml(doc, losslessChunk);
}

/**
 * The `yaml` emitter holds a node per value of the whole document before it
 * writes a byte; a Microsoft Graph whole-source AIR (17,870 operations) needed
 * over 9GB for that. A block map or sequence entry's emitted text does not
 * depend on its siblings, so each top-level key's array items and map entries
 * are emitted one at a time inside a one-entry document of the same shape,
 * and the key's header line is dropped from every chunk but the first.
 */
function chunkedYaml(
  doc: Record<string, unknown>,
  emit: (part: Record<string, unknown>) => string,
): string {
  let out = "";
  for (const [key, value] of Object.entries(doc)) {
    const header = `${key}:\n`;
    const parts: Record<string, unknown>[] | undefined = Array.isArray(value)
      ? value.map((item) => ({ [key]: [item] }))
      : isPlainRecord(value) && key !== "service" && key !== "anvilVersion"
        ? Object.entries(value).map(([k, v]) => ({ [key]: { [k]: v } }))
        : undefined;
    if (!parts || parts.length === 0) {
      out += emit({ [key]: value });
      continue;
    }
    out += header;
    for (const part of parts) {
      const text = emit(part);
      if (!text.startsWith(header)) return emit(doc);
      out += text.slice(header.length);
    }
  }
  return out;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function losslessChunk(doc: Record<string, unknown>): string {
  const pretty = stringifyYaml(doc, PRETTY);
  // Round-trip law guard: `airFromYaml(airToYaml(x))` must equal `x` — the
  // certify/lint path re-reads air.yaml, so a lossy emission silently drifts
  // the contract hash. Block scalars cannot represent trailing whitespace on a
  // line, and the emitter's style chooser has been observed picking one anyway
  // on real vendor descriptions. Verification is gated on a cheap risky-
  // whitespace scan so the common case pays nothing; on drift, fall back to
  // fully-quoted flow strings (lineWidth 0, no block scalars) — ugly for the
  // affected document, but lossless by construction. If even that drifts,
  // fail loudly: a silently wrong canonical artifact is the worst outcome.
  if (!containsRiskyWhitespace(doc)) return pretty;
  const parsesBack = (text: string): boolean => {
    try {
      return JSON.stringify(parseYaml(text, { maxAliasCount: -1 })) === JSON.stringify(doc);
    } catch {
      return false;
    }
  };
  if (parsesBack(pretty)) return pretty;
  const quoted = stringifyYaml(doc, QUOTED);
  if (parsesBack(quoted)) return quoted;
  throw new Error(
    "airToYaml: no lossless YAML representation found — refusing to emit a canonical artifact that would not round-trip.",
  );
}

/** Serialize an AIR document to pretty JSON. */
export function airToJson(air: AirDocument): string {
  return `${JSON.stringify(AirDocument.parse(air), null, 2)}\n`;
}
