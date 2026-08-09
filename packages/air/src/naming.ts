/**
 * Naming helpers shared by the compiler and every generator so that CLI flags,
 * MCP properties, operation ids, and code identifiers are derived one way.
 * Drift in naming is drift in the tool surface, so it lives in one place.
 */

const splitWords = (s: string): string[] =>
  s
    // split camelCase / PascalCase boundaries
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    // any non-alphanumeric run is a separator
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());

export const snakeCase = (s: string): string => splitWords(s).join("_");

export const kebabCase = (s: string): string => splitWords(s).join("-");

export const camelCase = (s: string): string => {
  const words = splitWords(s);
  return words.map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1))).join("");
};

export const pascalCase = (s: string): string => {
  const c = camelCase(s);
  return c.charAt(0).toUpperCase() + c.slice(1);
};

/** A CLI flag for a parameter name, e.g. paymentId -> --payment-id. */
export const cliFlag = (name: string): string => `--${kebabCase(name)}`;

/** An MCP/JSON property key for a parameter name, e.g. paymentId -> payment_id. */
export const propKey = (name: string): string => snakeCase(name);

/** Minimal input node shape shared by Params and projected body fields. */
export interface AgentNamedInput {
  /** Exact upstream coordinate. */
  name: string;
  /** Optional ergonomic name exposed to agents. */
  agentName?: string;
  /** Optional discovery synonyms; not additional wire coordinates. */
  aliases?: string[];
}

/** The human-facing name of an input, preserving its wire name separately. */
export function agentFieldName(input: AgentNamedInput): string {
  return input.agentName?.trim() || input.name;
}

/** The JSON/MCP property key an agent supplies for an input. */
export function agentPropKey(input: AgentNamedInput): string {
  return propKey(agentFieldName(input));
}

/**
 * The ONE definition of a weak operation name, shared by the compiler's naming
 * pass (where it lowers confidence and emits a signal) and the refinement
 * detector (where it raises the `weak_operation_name` deficiency). One predicate
 * so the two never disagree — the failure that let `do_transition` be penalized
 * by confidence yet never flagged, and `get_object` / `list_data` escape both.
 */
export type NameWeakness = "bare_noun" | "vague_verb" | "generic_resource" | "no_resource";

/** Verbs that name an action an agent cannot route on. */
export const WEAK_VERBS: ReadonlySet<string> = new Set([
  "do",
  "run",
  "exec",
  "execute",
  "process",
  "handle",
  "call",
  "post",
]);

/**
 * Resource nouns so generic they name nothing — matched on the WHOLE snake-cased
 * resource token (singular + plural), so `data_source` / `view_config` stay clean
 * while `data` / `view` / `object` do not.
 */
export const GENERIC_NOUNS: ReadonlySet<string> = new Set([
  "object",
  "objects",
  "resource",
  "resources",
  "item",
  "items",
  "entity",
  "entities",
  "record",
  "records",
  "data",
  "view",
  "views",
  "result",
  "results",
  "response",
  "payload",
]);

/**
 * Every way a derived name is weak, as typed reasons. Pure and deterministic.
 * `bare_noun` means the name is not `verb_noun`; `vague_verb` that its leading
 * verb is uninformative; `generic_resource` that its resource is a placeholder
 * noun; `no_resource` that there was no concrete resource to name at all.
 */
export function nameWeaknesses(args: {
  canonicalName: string;
  resource: string;
  action: string;
  hasResource: boolean;
}): NameWeakness[] {
  const out: NameWeakness[] = [];
  const tokens = args.canonicalName.split("_").filter(Boolean);
  if (tokens.length < 2) out.push("bare_noun");
  // The leading verb of the canonical name — its first token, whether the name
  // came from an operationId (`do_transition`) or was synthesized (`create_x`).
  const verb = tokens[0] ?? "";
  if (WEAK_VERBS.has(verb)) out.push("vague_verb");
  const resourceToken = snakeCase(args.resource);
  if (resourceToken && GENERIC_NOUNS.has(resourceToken)) out.push("generic_resource");
  if (!args.hasResource) out.push("no_resource");
  return out;
}

/**
 * Detect an unconstrained query-language passthrough field. An agent cannot
 * safely call an endpoint that accepts arbitrary logic through a single string —
 * the risk is arbitrary injection — but the rule must not swallow ordinary
 * search terms. Two tiers, split by where the field lives:
 *
 * - Names that only ever mean a query LANGUAGE (sql, jql, cql, kql, xpath, dsl,
 *   where, expression) fire in any location.
 * - Names that usually mean free-text search DATA in a query string but a query
 *   DOCUMENT in a request body (q, query, filter — think `GET /search?q=coffee`
 *   vs. a POSTed GraphQL/Elasticsearch body) fire only as body fields. Blocking
 *   every search API's `q` param would make the conservative rung meaningless.
 *
 * Either way, only a plain string with no narrowing constraint (enum, maxLength,
 * pattern) counts — a constrained value is not an open-ended language carrier.
 */
export function isQueryPassthroughParam(
  name: string,
  schema: Record<string, unknown> | undefined,
  location: "param" | "body",
): boolean {
  if (!schema || typeof schema !== "object") return false;
  // Must be a string type with no type alternatives (allOf/oneOf/anyOf/etc).
  if (schema.type !== "string") return false;
  // Must have no constraints that would narrow the injection risk.
  if (schema.enum || schema.maxLength || schema.pattern) return false;
  const languageOnly = /^(sql|jql|cql|kql|xpath|dsl|where|expression)$/i;
  if (languageOnly.test(name)) return true;
  const bodyContextual = /^(q|query|filter)$/i;
  return location === "body" && bodyContextual.test(name);
}
