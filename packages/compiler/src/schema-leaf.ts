/** Small, non-recursive object contracts should not lose their discriminating fields at a ref boundary. */
export function compactLeafSchema(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const schema = value as Record<string, unknown>;
  if (
    schema.type !== "object" ||
    !schema.properties ||
    typeof schema.properties !== "object" ||
    Array.isArray(schema.properties)
  )
    return false;
  const properties = Object.values(schema.properties);
  if (properties.length > 16 || JSON.stringify(schema).length > 4096) return false;
  if (
    Object.keys(schema).some((key) =>
      [
        "$ref",
        "allOf",
        "oneOf",
        "anyOf",
        "not",
        "additionalProperties",
        "patternProperties",
        "dependentSchemas",
      ].includes(key),
    )
  )
    return false;
  return properties.every((child) => {
    if (!child || typeof child !== "object" || Array.isArray(child)) return false;
    const field = child as Record<string, unknown>;
    return (
      ["string", "integer", "number", "boolean", "null"].includes(String(field.type)) &&
      Object.keys(field).every((key) =>
        [
          "type",
          "const",
          "enum",
          "format",
          "pattern",
          "minimum",
          "maximum",
          "minLength",
          "maxLength",
          "description",
          "title",
          "default",
          "example",
          "examples",
          "nullable",
        ].includes(key),
      )
    );
  });
}

/**
 * Collapse a vendor-declared "expandable" field (`x-expansionResources`
 * alongside an `anyOf`/`oneOf`) to just its non-expansion alternative(s) —
 * conservatively: only when at least one alternative is clearly *not* one of
 * the declared expansion variants, and at least one *is*, so this never
 * touches a plain `anyOf`/`oneOf` that isn't this specific pattern.
 */
export function collapseExpandable(
  node: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const expansion = node["x-expansionResources"];
  if (expansion === null || typeof expansion !== "object") return undefined;
  const variants = new Set<unknown>([
    ...(Array.isArray((expansion as Record<string, unknown>).oneOf)
      ? ((expansion as Record<string, unknown>).oneOf as unknown[])
      : []),
    ...(Array.isArray((expansion as Record<string, unknown>).anyOf)
      ? ((expansion as Record<string, unknown>).anyOf as unknown[])
      : []),
  ]);
  if (variants.size === 0) return undefined;
  const key = Array.isArray(node.anyOf) ? "anyOf" : Array.isArray(node.oneOf) ? "oneOf" : undefined;
  if (!key) return undefined;
  const alternatives = node[key] as unknown[];
  const compact = alternatives.filter((alt) => !variants.has(alt));
  if (compact.length === 0 || compact.length === alternatives.length) return undefined;

  const { "x-expansionResources": _drop, anyOf: _a, oneOf: _o, ...rest } = node;
  const note =
    "the full expanded object is available via the API's expand parameter; " +
    "Anvil keeps the compact (actual runtime default) shape here";
  return {
    ...rest,
    ...(compact.length === 1 ? (compact[0] as object) : { [key]: compact }),
    description: typeof node.description === "string" ? `${node.description} (${note})` : note,
  };
}
