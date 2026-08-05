const NEXT_FIELD_NAMES = new Set([
  "next_cursor",
  "nextcursor",
  "next_page",
  "nextpage",
  "next_page_token",
  "nextpagetoken",
  "next_token",
  "nexttoken",
]);

/** Infer collection and continuation paths only when each is unambiguous. */
export function inferPaginationResponseFields(outputSchema: Record<string, unknown> | undefined): {
  itemsField?: string;
  nextField?: string;
} {
  const paths: Array<{ path: string; schema: Record<string, unknown> }> = [];
  const visit = (schema: Record<string, unknown> | undefined, prefix: string[] = []): void => {
    if (!schema || prefix.length > 5) return;
    const properties = schema.properties;
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) return;
    for (const [name, child] of Object.entries(properties as Record<string, unknown>)) {
      if (!child || typeof child !== "object" || Array.isArray(child)) continue;
      const childPath = [...prefix, name];
      const childSchema = child as Record<string, unknown>;
      paths.push({ path: childPath.join("."), schema: childSchema });
      // Row-level markers do not paginate the collection itself.
      if (childSchema.type !== "array") visit(childSchema, childPath);
    }
  };
  visit(outputSchema);

  const arrays = paths.filter(({ schema }) => schema.type === "array");
  const continuations = paths.filter(({ path }) =>
    NEXT_FIELD_NAMES.has(path.split(".").at(-1)?.toLowerCase() ?? ""),
  );
  return {
    ...(arrays.length === 1 ? { itemsField: arrays[0]?.path } : {}),
    ...(continuations.length === 1 ? { nextField: continuations[0]?.path } : {}),
  };
}
