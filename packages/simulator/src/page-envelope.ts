/**
 * The page envelope a contract declares, written around a page of items.
 *
 * The simulator (or its provider) decides *which* items a page holds and
 * whether another page follows. Everything else a vendor's page carries is the
 * contract's shape, and is read from the operation's declared response: where
 * the items sit, where the continuation goes, and the page-level fields a
 * client reads to decide whether to ask again (Jira's `isLast`, Slack's
 * `has_more`).
 */
import {
  type AirDocument,
  isODataPaging,
  type JsonSchema,
  type Operation,
  responseFieldPath,
} from "@anvil/air";
import { declaredResponse } from "./runtime.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = responseFieldPath(path);
  let cursor = target;
  for (const key of keys.slice(0, -1)) {
    const next = cursor[key];
    if (!isRecord(next)) cursor[key] = {};
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[keys[keys.length - 1] as string] = value;
}

/** A schema's own properties merged with those of its `allOf` members. */
function propertiesOf(schema: unknown): Record<string, JsonSchema> {
  const props: Record<string, JsonSchema> = {};
  if (!isRecord(schema)) return props;
  const parts = [schema, ...(Array.isArray(schema.allOf) ? schema.allOf : [])];
  for (const part of parts) {
    if (isRecord(part) && isRecord(part.properties)) Object.assign(props, part.properties);
  }
  return props;
}

/** The declared object at a key path inside a response, when every step is declared. */
function schemaAt(schema: JsonSchema | undefined, path: readonly string[]): JsonSchema | undefined {
  let cursor: JsonSchema | undefined = schema;
  for (const key of path) {
    cursor = propertiesOf(cursor)[key];
    if (!isRecord(cursor)) return undefined;
  }
  return cursor;
}

/** The first array-valued property of a declared envelope, in declared order. */
function firstArrayField(schema: JsonSchema | undefined): string | undefined {
  for (const [name, prop] of Object.entries(propertiesOf(schema))) {
    if (prop && (prop.type === "array" || isRecord(prop.items))) return name;
  }
  return undefined;
}

/**
 * The one value a declared field can hold: its `const`, or the sole member of
 * its `enum` (Slack's `ok: {enum: [true]}`). With `defaults`, also a scalar
 * `default`, which JSON Schema reads as the value an absent field stands for
 * (Google Drive's `kind: {default: "drive#fileList"}`).
 */
function fixedValue(
  prop: JsonSchema | undefined,
  defaults: boolean,
): { value: unknown } | undefined {
  if (!isRecord(prop)) return undefined;
  if (prop.const !== undefined) return { value: prop.const };
  if (Array.isArray(prop.enum) && prop.enum.length === 1) return { value: prop.enum[0] };
  const dflt = prop.default;
  const scalar = typeof dflt === "string" || typeof dflt === "number" || typeof dflt === "boolean";
  return defaults && scalar ? { value: dflt } : undefined;
}

/**
 * Fill the top-level fields a declared object response fixes to one value and
 * the answer left out. Nothing is invented: a field whose value the contract
 * does not fix (Drive's `incompleteSearch`) stays absent, and a value already
 * present is never replaced. A page envelope also takes declared scalar
 * defaults, since the envelope is Anvil's to write; a provider's own `result`
 * gets only the fixed values, the ones no other value would satisfy.
 */
export function fillFixedFields(
  target: Record<string, unknown>,
  declared: JsonSchema | undefined,
  options: { defaults: boolean },
): void {
  for (const [name, prop] of Object.entries(propertiesOf(declared))) {
    if (target[name] !== undefined) continue;
    const fixed = fixedValue(prop, options.defaults);
    if (fixed) target[name] = fixed.value;
  }
}

/** Boolean fields that are true on the final page, and ones that are true while more follow. */
const LAST_PAGE_FIELDS = new Set(["isLast", "is_last"]);
const MORE_PAGES_FIELDS = new Set(["has_more", "hasMore"]);

/**
 * Write the page-level booleans the contract declares beside the items (or at
 * the top of the envelope): `isLast` is true on the last page, `has_more`
 * while another follows. Only a field declared as a boolean is written.
 */
function writePageMarkers(
  body: Record<string, unknown>,
  declared: JsonSchema | undefined,
  itemsPath: readonly string[],
  more: boolean,
): void {
  const parents = [[] as string[]];
  if (itemsPath.length > 1) parents.push(itemsPath.slice(0, -1));
  for (const parent of parents) {
    const props = propertiesOf(parent.length === 0 ? declared : schemaAt(declared, parent));
    for (const [name, prop] of Object.entries(props)) {
      if (prop?.type !== "boolean") continue;
      const value = LAST_PAGE_FIELDS.has(name) ? !more : MORE_PAGES_FIELDS.has(name) ? more : null;
      if (value !== null) setPath(body, [...parent, name].join("."), value);
    }
  }
}

/**
 * Write a page of items in the envelope the contract declares: a bare array
 * when the response is an array, else the items at `itemsField` (or the first
 * declared array property), the continuation at `nextField`, and the page
 * markers the envelope declares. A `link` pagination style gets a URL carrying
 * the cursor, as such APIs serve.
 */
export function pageEnvelope(
  air: AirDocument,
  op: Operation,
  items: unknown[],
  nextCursor: string | undefined,
  url: URL,
): { body: unknown; headers: Record<string, string> } {
  const declared = declaredResponse(air, op);
  const pagination = op.pagination;
  const bare = declared?.type === "array";
  const nextUrl = (cursor: string, cursorParam: string): string => {
    const link = new URL(url.toString());
    // The token names the whole continuation; an OData `$skip` the caller
    // sent is already folded into it and must not be applied twice.
    if (isODataPaging(pagination)) link.searchParams.delete("$skip");
    link.searchParams.set(cursorParam, cursor);
    return link.toString();
  };
  let next: string | undefined = nextCursor;
  // A `link` continuation is a URL; so is any continuation that can only
  // travel in a `Link` header (RFC 8288), which is where a bare array puts it.
  const asUrl = pagination?.style === "link" || (bare && pagination?.in !== "body");
  if (nextCursor !== undefined && asUrl && pagination?.cursorParam) {
    next = nextUrl(nextCursor, pagination.cursorParam);
  }
  if (bare) {
    return { body: items, headers: next ? { link: `<${next}>; rel="next"` } : {} };
  }
  const body: Record<string, unknown> = {};
  fillFixedFields(body, declared, { defaults: true });
  const itemsField = pagination?.itemsField ?? firstArrayField(declared) ?? "items";
  writePageMarkers(body, declared, responseFieldPath(itemsField), next !== undefined);
  setPath(body, itemsField, items);
  if (next !== undefined) setPath(body, pagination?.nextField ?? "next_cursor", next);
  else if (pagination?.nextField && requiredString(declared, pagination.nextField)) {
    // A continuation the contract requires is present on the last page too,
    // empty: Slack's `response_metadata.next_cursor` is `""` when no page
    // follows, and that is what its clients stop on.
    setPath(body, pagination.nextField, "");
  }
  return { body, headers: {} };
}

/** Whether a declared response requires a string at this field path, within its declared parent. */
function requiredString(declared: JsonSchema | undefined, field: string): boolean {
  const path = responseFieldPath(field);
  const name = path[path.length - 1] as string;
  const parent = path.length === 1 ? declared : schemaAt(declared, path.slice(0, -1));
  const required = isRecord(parent) && Array.isArray(parent.required) ? parent.required : [];
  return required.includes(name) && propertiesOf(parent)[name]?.type === "string";
}
