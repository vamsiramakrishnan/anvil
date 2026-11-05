import {
  type AirDocument,
  effectClassOf,
  idempotencyModeUsesCarrier,
  isDirectlyCallable,
  type Operation,
  operationInputSchema,
} from "@anvil/air";

/**
 * `search.json`: the operation index `anvil package harness` writes beside
 * `SKILL.md` (Branchyard's contract v2, item 3). One entry per approved,
 * directly callable operation, sorted by id, with a JSON Schema file for each
 * one's input. Nothing here reads a clock or the environment, so one bundle
 * gives the same bytes every time.
 */

export const SEARCH_SCHEMA = "anvil.search/v1";
export const SUMMARY_MAX = 160;
/** Where the JSON Schema for `search.json` ships inside a package. */
export const SEARCH_SCHEMA_PATH = "schemas/anvil-search-v1.json";

export interface SearchOperation {
  id: string;
  title: string;
  summary: string;
  effect: string;
  risk: string | null;
  confirm: boolean;
  idempotency: "safe" | "keyed" | "none";
  resource: string;
  tags: string[];
  terms: string[];
  schema: string;
  cli: string;
}

export interface SearchIndex {
  schema: typeof SEARCH_SCHEMA;
  connector: string;
  bundle_hash: string;
  icon: string | null;
  operations: SearchOperation[];
}

/** The index and the schema files it points at, keyed by package-relative path. */
export interface BuiltSearchIndex {
  index: SearchIndex;
  schemas: Record<string, string>;
}

/** JSON with object keys sorted at every level, so equal values give equal bytes. */
export function stableJson(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, sortKeys(item)]),
    );
  }
  return value;
}

/** The first sentence of a description, on one line, at most 160 characters. */
export function summaryOf(description: string, fallback: string): string {
  const text = description.replace(/\s+/g, " ").trim() || fallback.replace(/\s+/g, " ").trim();
  const match = /^(.+?[.!?])(\s|$)/.exec(text);
  const sentence = match ? (match[1] as string) : text;
  return sentence.length > SUMMARY_MAX
    ? `${sentence.slice(0, SUMMARY_MAX - 3).trimEnd()}...`
    : sentence;
}

/** Lower-case letters and digits, split on punctuation and camelCase. */
export function termsOf(...parts: readonly string[]): string[] {
  const words = new Set<string>();
  for (const part of parts) {
    for (const word of part
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)) {
      if (word) words.add(word);
    }
  }
  return [...words].sort();
}

/** `github.issues.list` under connector `github`; the connector prefix is the fleet id, not the service id. */
function searchId(air: AirDocument, connector: string, operationId: string): string {
  let short = operationId;
  for (const prefix of [`${air.service.id}.`, `${connector}.`]) {
    if (short.startsWith(prefix)) {
      short = short.slice(prefix.length);
      break;
    }
  }
  const segments = short
    .split(".")
    .map((segment) => segment.replace(/[^A-Za-z0-9_-]/g, "_"))
    .filter(Boolean);
  return [connector, ...(segments.length > 0 ? segments : ["operation"])].join(".");
}

function idempotencyOf(op: Operation): SearchOperation["idempotency"] {
  if (op.idempotency.mode === "natural") return "safe";
  if (op.idempotency.mode === "none") return "none";
  return idempotencyModeUsesCarrier(op.idempotency.mode) || op.idempotency.mode === "client_id"
    ? "keyed"
    : "none";
}

/** The id of the capability that owns the operation (the first, by id, when several do). */
function resourceOf(air: AirDocument, op: Operation, short: string): string {
  const owners = air.capabilities
    .filter((capability) => capability.operationIds.includes(op.id))
    .map((capability) => capability.id)
    .sort();
  return owners[0] ?? (op.effect.resource || short.split(".")[1] || "operations");
}

function parameterNames(schema: unknown): string[] {
  const properties = (schema as { properties?: Record<string, unknown> } | undefined)?.properties;
  return properties && typeof properties === "object" ? Object.keys(properties) : [];
}

/**
 * Build the index for one connector. `hash` is the bundle's hex digest. Throws
 * when two operations fold to one id: an index with a repeated id is refused
 * by every reader, so it is better not written.
 */
export function buildSearchIndex(
  air: AirDocument,
  connector: string,
  hash: string,
): BuiltSearchIndex {
  const schemas: Record<string, string> = {};
  const seen = new Map<string, string>();
  const operations: SearchOperation[] = [];
  for (const op of air.operations) {
    if (op.state !== "approved" || !isDirectlyCallable(op)) continue;
    const id = searchId(air, connector, op.id);
    const clash = seen.get(id);
    if (clash !== undefined) {
      throw new Error(
        `operations '${clash}' and '${op.id}' both become '${id}' in the search index`,
      );
    }
    seen.set(id, op.id);
    const schema = op.input.schema ?? operationInputSchema(op);
    const schemaPath = `schemas/${id}.input.json`;
    schemas[schemaPath] = stableJson(schema);
    const tags = [...new Set(op.tags.map((tag) => tag.trim()).filter(Boolean))].sort();
    const resource = resourceOf(air, op, id.slice(connector.length + 1));
    const risk = op.effect.risk;
    operations.push({
      id,
      title: op.displayName.replace(/\s+/g, " ").trim() || id,
      summary: summaryOf(op.description, op.displayName || id),
      effect: effectClassOf(op),
      risk: risk && risk !== "none" ? risk : null,
      confirm: op.confirmation.required,
      idempotency: idempotencyOf(op),
      resource,
      tags,
      terms: termsOf(id, op.displayName, ...tags, ...parameterNames(schema)),
      schema: schemaPath,
      cli: `bin/${connector} ${op.cli.command.split(" ").slice(1).join(" ")}`.trim(),
    });
  }
  operations.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    index: {
      schema: SEARCH_SCHEMA,
      connector,
      bundle_hash: `sha256:${hash}`,
      icon: air.service.icon ?? null,
      operations,
    },
    schemas,
  };
}

/** The JSON Schema (2020-12) for `search.json`, shipped as `schemas/anvil-search-v1.json`. */
export function searchJsonSchema(): string {
  const strings = { type: "array", items: { type: "string", minLength: 1 } };
  return stableJson({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://anvil.dev/schemas/anvil-search-v1.json",
    title: "Anvil operation search index",
    type: "object",
    additionalProperties: true,
    required: ["schema", "connector", "bundle_hash", "icon", "operations"],
    properties: {
      schema: { const: SEARCH_SCHEMA },
      connector: { type: "string", minLength: 1 },
      bundle_hash: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
      icon: {
        anyOf: [
          { type: "null" },
          { type: "string", maxLength: 64, pattern: "^[a-z0-9]+(-[a-z0-9]+)*$" },
        ],
      },
      operations: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: true,
          required: [
            "id",
            "title",
            "summary",
            "effect",
            "risk",
            "confirm",
            "idempotency",
            "resource",
            "tags",
            "terms",
            "schema",
            "cli",
          ],
          properties: {
            id: { type: "string", pattern: "^[A-Za-z0-9_-]+(\\.[A-Za-z0-9_-]+)+$" },
            title: { type: "string", minLength: 1 },
            summary: {
              type: "string",
              minLength: 1,
              maxLength: SUMMARY_MAX,
              pattern: "^[^\\r\\n]+$",
            },
            effect: { enum: ["read", "reversible", "compensable", "irreversible"] },
            risk: { anyOf: [{ type: "null" }, { type: "string", minLength: 1 }] },
            confirm: { type: "boolean" },
            idempotency: { enum: ["safe", "keyed", "none"] },
            resource: { type: "string", minLength: 1 },
            tags: strings,
            terms: { type: "array", items: { type: "string", pattern: "^[a-z0-9]+$" } },
            schema: { type: "string", minLength: 1 },
            cli: { type: "string", minLength: 1 },
          },
        },
      },
    },
  });
}
