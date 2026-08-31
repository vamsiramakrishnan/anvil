/**
 * Bounded stubs for schema nodes the decycling/materialization walks had to
 * cut off (a reference cycle, the ref-depth bound, or the node budget).
 *
 * A stub has one job: stand in for the removed subtree while remaining *valid*
 * at the position it occupies. That is not automatic — the walks run over a
 * whole OpenAPI document, so a truncated node can be a schema, a plain array,
 * or a map whose values are schemas, and each needs a different empty shape.
 * Getting it wrong emits a document that parses as JSON but is not a schema,
 * which fails far away from here (in a generator, or in a consumer's own
 * validator) with no trace back to the truncation that caused it.
 */

/**
 * JSON Schema keywords whose value is a *map of schemas* rather than a schema.
 * Truncation must treat these as containers — see {@link truncateToStub}.
 *
 * This must stay exhaustive across the drafts a spec can reach us in, because
 * a keyword missing here is silently wrong rather than loudly wrong: OpenAPI
 * 3.0 specs carry draft-04/07 (`definitions`, `dependencies`) and 3.1 carries
 * 2020-12 (`$defs`, `dependentSchemas` — the rename of the schema half of
 * `dependencies`). Keywords whose value is an *array* of schemas (`allOf`,
 * `oneOf`, `prefixItems`, …) do not belong here: the array branch already
 * preserves their shape. Nor do keywords holding a single schema (`items`,
 * `not`, `additionalProperties`, `propertyNames`, `if`/`then`/`else`,
 * `contains`, `unevaluated*`) — those really are schemas.
 *
 * `dependencies` is the mixed draft-07 form: each value is a schema *or* an
 * array of property names. Both are handled — the container truncates to `{}`,
 * and an array-valued member truncates to `[]` via the array branch.
 */
export const SCHEMA_MAP_KEYS: ReadonlySet<string> = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
  "dependencies",
]);

const TRUNCATION_NOTE =
  "nested reference truncated by Anvil to keep the schema JSON-safe and bounded";

/**
 * Replace a truncated node with a shallow, safe stub — shape-preserving.
 *
 * An array in, an array out: this walk runs over the *whole* OpenAPI document,
 * not just JSON Schema, so a truncated node can just as easily be a plain
 * array (e.g. OAuth scope lists) as an object — collapsing an array into `{}`
 * would silently turn a `string[]` into an object downstream code still
 * expects to `.map()` over.
 *
 * A map *of* schemas in, an empty map out: `properties` and friends are
 * containers, not schemas. Stamping the explanatory `type`/`description` onto
 * one would mint a bogus member literally named `description` whose value is a
 * *string* where a schema belongs — invalid JSON Schema that crashes any
 * standards-compliant consumer (zod's `fromJSONSchema` throws
 * `Cannot use 'in' operator`, taking the generated MCP server down with it).
 * The truthful bounded stub for a container is the empty container.
 */
export function truncateToStub(
  node: Record<string, unknown> | unknown[],
  inSchemaMap = false,
): Record<string, unknown> | unknown[] {
  if (Array.isArray(node)) return [];
  if (inSchemaMap) return {};
  const stub: Record<string, unknown> = {};
  if (typeof node.type === "string") stub.type = node.type;
  stub.description =
    typeof node.description === "string"
      ? `${node.description} (${TRUNCATION_NOTE})`
      : TRUNCATION_NOTE;
  return stub;
}
