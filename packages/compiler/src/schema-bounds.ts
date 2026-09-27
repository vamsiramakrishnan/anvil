import {
  DEFAULT_MAX_REF_DEPTH,
  DEFAULT_MAX_SCHEMA_NODES,
  type MaterializeResult,
  materializeSchema,
} from "./decycle.js";

/**
 * Materialization bounds for one compile. The defaults are the historical
 * whole-source bounds; an exposure profile sets its own (see profile.ts).
 */
export interface SchemaBounds {
  /** The deepest named-schema hop chain expanded. */
  maxRefDepth: number;
  /**
   * With `fitToBudget`, the most nodes the materialized tree may hold;
   * otherwise the expansion budget `materializeSchema` has always applied.
   */
  maxSchemaNodes: number;
  /** See `MaterializeOptions.inheritAllOf`. */
  inheritAllOf: boolean;
  /**
   * Choose the depth per schema: the deepest depth up to `maxRefDepth` whose
   * materialized tree fits in `maxSchemaNodes`, else one hop under the node
   * budget. A collection envelope then reaches its element type while a
   * single entity with dozens of navigation properties stays at one hop.
   */
  fitToBudget: boolean;
}

export const DEFAULT_SCHEMA_BOUNDS: SchemaBounds = {
  maxRefDepth: DEFAULT_MAX_REF_DEPTH,
  maxSchemaNodes: DEFAULT_MAX_SCHEMA_NODES,
  inheritAllOf: false,
  fitToBudget: false,
};

/**
 * The expansion budget each fit attempt runs under. It only stops a
 * pathological walk early; the tree-size test decides whether a depth fits.
 */
const FIT_ATTEMPT_WALK_BUDGET = 200_000;

/** `materializeSchema` under a compile's bounds. */
export function materializeWithin(
  schema: unknown,
  namedSchemas: Record<string, unknown>,
  bounds: SchemaBounds = DEFAULT_SCHEMA_BOUNDS,
): MaterializeResult {
  const options = { inheritAllOf: bounds.inheritAllOf };
  if (bounds.fitToBudget) {
    for (let depth = bounds.maxRefDepth; depth > 1; depth--) {
      const attempt = materializeSchema(
        schema,
        namedSchemas,
        depth,
        FIT_ATTEMPT_WALK_BUDGET,
        options,
      );
      if (
        attempt.nodeBudgetLimitedAt.length === 0 &&
        treeFits(attempt.schema, bounds.maxSchemaNodes)
      ) {
        return attempt;
      }
    }
    return materializeSchema(schema, namedSchemas, 1, bounds.maxSchemaNodes, options);
  }
  return materializeSchema(
    schema,
    namedSchemas,
    bounds.maxRefDepth,
    bounds.maxSchemaNodes,
    options,
  );
}

/**
 * Whether a value's JSON tree holds at most `limit` object/array nodes. A
 * memoized named schema appears once per use in the serialized form, so
 * shared objects are counted at every position, and the walk stops as soon
 * as the limit is passed.
 */
function treeFits(value: unknown, limit: number): boolean {
  let count = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== "object") continue;
    count += 1;
    if (count > limit) return false;
    for (const child of Array.isArray(node) ? node : Object.values(node)) stack.push(child);
  }
  return true;
}
