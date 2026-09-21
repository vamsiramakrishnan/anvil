import type { JsonSchema } from "./schema.js";

/**
 * Make inherited object properties explicit on union branches that carry only
 * `required` and/or a partial `properties` override. Zod's JSON Schema importer
 * otherwise ignores `required` without `properties`, turning a valid exclusive
 * union into two always-matching unconstrained branches — and a branch that
 * names only the properties it constrains (an `xsd:choice` alternative marking
 * the other branches' members absent) loses every sibling's type as well as its
 * own requiredness. The branch's own entries win over the inherited ones, which
 * is what lets such an override stand. This preserves the original constraint;
 * it does not relax oneOf into anyOf.
 */
export function materializeSchemaBranches(schema: JsonSchema): JsonSchema {
  const seen = new WeakMap<object, JsonSchema>();
  function visit(value: JsonSchema): JsonSchema {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const cached = seen.get(value);
    if (cached) return cached;
    const result = { ...value };
    seen.set(value, result);
    const properties = value.properties as Record<string, JsonSchema> | undefined;
    if (properties)
      result.properties = Object.fromEntries(
        Object.entries(properties).map(([key, child]) => [key, visit(child)]),
      );
    for (const key of ["items", "additionalProperties"]) {
      const child = value[key];
      if (child && typeof child === "object" && !Array.isArray(child))
        result[key] = visit(child as JsonSchema);
    }
    for (const key of ["oneOf", "anyOf", "allOf"]) {
      const branches = value[key];
      if (!Array.isArray(branches)) continue;
      result[key] = branches.map((branch: JsonSchema) =>
        visit(
          value.type === "object" &&
            properties &&
            branch &&
            (Array.isArray(branch.required) || branch.properties !== undefined) &&
            Object.keys(branch).every((key) =>
              ["required", "properties", "type", "title", "description"].includes(key),
            ) &&
            (branch.type === undefined || branch.type === "object")
            ? {
                ...branch,
                type: branch.type ?? "object",
                properties: {
                  ...properties,
                  ...((branch.properties as Record<string, JsonSchema>) ?? {}),
                },
              }
            : branch,
        ),
      );
    }
    return result;
  }
  return visit(schema);
}
