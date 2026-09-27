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

/**
 * The object branches of an untyped `items` union: a schema with no `type` and
 * no properties whose `items` is an `anyOf`/`oneOf` of objects. Slack's
 * published spec writes a field that is one of several objects as a draft-04
 * tuple, `{items: [A, B]}` with no `type` (its `user`, `channel`, and
 * `response_metadata`), which the Swagger 2.0 converter turns into
 * `{items: {anyOf: [A, B]}}`. Without `type: array` the keyword constrains
 * only an array, and the service answers with one of the objects, so the
 * field is read as that union rather than as a list.
 */
export function untypedItemsUnion(schema: unknown): Record<string, unknown>[] | undefined {
  if (!isObject(schema) || schema.type !== undefined || schema.properties !== undefined) {
    return undefined;
  }
  const items = schema.items;
  if (!isObject(items)) return undefined;
  const branches = Array.isArray(items.anyOf)
    ? items.anyOf
    : Array.isArray(items.oneOf)
      ? items.oneOf
      : undefined;
  if (!branches || branches.length === 0) return undefined;
  const objects = branches.filter(
    (branch): branch is Record<string, unknown> =>
      isObject(branch) && (branch.type === "object" || isObject(branch.properties)),
  );
  return objects.length === branches.length ? objects : undefined;
}

/** Whether a declared field is an array: typed as one, or an untyped `items` that is not a union. */
export function isDeclaredArray(schema: unknown): boolean {
  if (!isObject(schema)) return false;
  if (schema.type === "array") return true;
  return schema.items !== undefined && untypedItemsUnion(schema) === undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parents of a `next` link: HAL-style `_links.next` (Confluence v2) and JSON:API `links.next`. */
const LINK_PARENTS = new Set(["_links", "links"]);

/**
 * Infer collection and continuation paths only when each is unambiguous.
 * `nextLinkField` is a continuation that is a URL (`_links.next`), reported
 * apart from a token-valued `nextField` because a client reads it differently.
 */
export function inferPaginationResponseFields(outputSchema: Record<string, unknown> | undefined): {
  itemsField?: string;
  nextField?: string;
  nextLinkField?: string;
} {
  // `alternative`: reached through one branch of a union, so an array there is
  // not the envelope's collection, while a continuation is still where the
  // service puts it (Slack's `response_metadata.next_cursor`).
  const paths: Array<{ path: string; schema: Record<string, unknown>; alternative: boolean }> = [];
  const visit = (
    schema: Record<string, unknown> | undefined,
    prefix: string[] = [],
    alternative = false,
  ): void => {
    if (!schema || prefix.length > 5) return;
    const branches = untypedItemsUnion(schema);
    if (branches) {
      for (const branch of branches) visit(branch, prefix, true);
      return;
    }
    const properties = schema.properties;
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) return;
    for (const [name, child] of Object.entries(properties as Record<string, unknown>)) {
      if (!child || typeof child !== "object" || Array.isArray(child)) continue;
      const childPath = [...prefix, name];
      const childSchema = child as Record<string, unknown>;
      paths.push({ path: childPath.join("."), schema: childSchema, alternative });
      // Row-level markers do not paginate the collection itself.
      if (childSchema.type !== "array") visit(childSchema, childPath, alternative);
    }
  };
  visit(outputSchema);

  const arrays = paths.filter(({ schema, alternative }) => !alternative && schema.type === "array");
  // One field reached through several union branches is still one field.
  const continuations = [
    ...new Set(
      paths
        .filter(({ path }) => NEXT_FIELD_NAMES.has(path.split(".").at(-1)?.toLowerCase() ?? ""))
        .map(({ path }) => path),
    ),
  ].map((path) => ({ path }));
  const links = paths.filter(({ path, schema }) => {
    const segments = path.split(".");
    return (
      segments.at(-1) === "next" &&
      LINK_PARENTS.has(segments.at(-2) ?? "") &&
      (schema.type === undefined || schema.type === "string")
    );
  });
  return {
    ...(arrays.length === 1 ? { itemsField: arrays[0]?.path } : {}),
    ...(continuations.length === 1 ? { nextField: continuations[0]?.path } : {}),
    ...(links.length === 1 ? { nextLinkField: links[0]?.path } : {}),
  };
}
