/**
 * The manifest patches that describe an operation's inputs and how a read
 * pages: `pagination` and `params`. Split out of manifest.ts, which owns the
 * manifest's shape and its safety patches; these two only correct how the
 * wire is described, and each declines with a review note rather than bind
 * to an input the operation does not have.
 */
import type { Operation } from "@anvil/air";
import { z } from "zod";

/**
 * Declare how a paginated read is paged, when the spec did not make it
 * inferable (`classifyPagination`) and the refinement loop has not proposed
 * it. Style is required; the parameter names are validated against the
 * operation's real inputs, because a pagination contract bound to a phantom
 * parameter would teach every surface to pass an argument the wire ignores.
 */
export const ManifestPagination = z.strictObject({
  style: z.enum(["cursor", "page", "offset", "link"]),
  cursor_param: z.string().optional(),
  next_field: z.string().optional(),
  items_field: z.string().optional(),
  /** Where a page-numbered response reports `{page, count, pages, total}` (Slack's `messages.paging`). */
  paging_field: z.string().optional(),
  page_size_param: z.string().optional(),
  max_page_size: z.number().int().positive().optional(),
  default_page_size: z.number().int().positive().optional(),
});
export type ManifestPagination = z.infer<typeof ManifestPagination>;

/**
 * Retype an input the source types wrongly, by its wire name: a query, path,
 * header, or cookie parameter, or a top-level body field. Slack's contract
 * types a message timestamp (`chat.delete`'s `ts`, `"1700000000.123400"`) as
 * a number, so it would travel as a float and lose its trailing zeros; the
 * timestamp is an id and must be carried as the string it is. The new type
 * replaces the old one with its type-specific constraints; descriptions are
 * kept.
 */
export const ManifestParams = z.record(
  z.string(),
  z.strictObject({
    type: z.enum(["string", "number", "integer", "boolean"]),
    format: z.string().optional(),
    pattern: z.string().optional(),
  }),
);
export type ManifestParams = z.infer<typeof ManifestParams>;

function note(op: Operation, text: string): void {
  if (!op.reviewNotes.includes(text)) op.reviewNotes.push(text);
}

/**
 * Pagination is a fact about how a READ hands back a large result. On a
 * mutation it is meaningless, and a carrier parameter that names no real
 * input would teach every surface to pass an argument the wire ignores —
 * both decline with the reason, in the async_contract pattern, rather than
 * half-applying.
 */
export function applyPaginationPatch(op: Operation, pagination: ManifestPagination): void {
  const inputNames = new Set(op.input.params.map((p) => p.name));
  const phantom = [pagination.cursor_param, pagination.page_size_param].filter(
    (name): name is string => name !== undefined && !inputNames.has(name),
  );
  if (op.effect.kind !== "read") {
    note(
      op,
      "pagination manifest patch left unset: the operation is a mutation, and pagination " +
        "is a contract about how a read hands back a large result.",
    );
    return;
  }
  if (phantom.length > 0) {
    note(
      op,
      `pagination manifest patch left unset: parameter(s) ${phantom.map((n) => `'${n}'`).join(", ")} ` +
        `do not exist on this operation, and a pagination contract bound to a phantom parameter ` +
        `would teach every surface to pass an argument the wire ignores.`,
    );
    return;
  }
  op.pagination = {
    style: pagination.style,
    ...(pagination.cursor_param !== undefined ? { cursorParam: pagination.cursor_param } : {}),
    ...(pagination.next_field !== undefined ? { nextField: pagination.next_field } : {}),
    ...(pagination.items_field !== undefined ? { itemsField: pagination.items_field } : {}),
    ...(pagination.paging_field !== undefined ? { pagingField: pagination.paging_field } : {}),
    ...(pagination.page_size_param !== undefined
      ? { pageSizeParam: pagination.page_size_param }
      : {}),
    ...(pagination.max_page_size !== undefined ? { maxPageSize: pagination.max_page_size } : {}),
    ...(pagination.default_page_size !== undefined
      ? { defaultPageSize: pagination.default_page_size }
      : {}),
  };
  note(
    op,
    `Pagination declared by manifest: ${pagination.style}` +
      (pagination.cursor_param ? ` via '${pagination.cursor_param}'` : "") +
      ".",
  );
}

/**
 * Retype inputs by wire name. A name that matches nothing declines with the
 * reason rather than inventing an input the wire never carries.
 */
export function applyParamsPatch(op: Operation, params: ManifestParams): void {
  for (const [name, retype] of Object.entries(params)) {
    const retyped = retypeInput(op, name, retype);
    note(
      op,
      retyped
        ? `Input '${name}' retyped by manifest: ${retyped} → ${retype.type}.`
        : `params manifest patch for '${name}' left unset: the operation has no parameter ` +
            "or top-level body field of that name.",
    );
  }
}

type Retype = ManifestParams[string];

/** Keywords that describe a value without constraining its type; they survive a retype. */
const TYPE_NEUTRAL_KEYWORDS = new Set([
  "title",
  "description",
  "deprecated",
  "nullable",
  "readOnly",
  "writeOnly",
]);

function retypedSchema(schema: Record<string, unknown>, retype: Retype): Record<string, unknown> {
  const kept = Object.fromEntries(
    Object.entries(schema).filter(
      ([key]) => TYPE_NEUTRAL_KEYWORDS.has(key) || key.startsWith("x-"),
    ),
  );
  return {
    ...kept,
    type: retype.type,
    ...(retype.format !== undefined ? { format: retype.format } : {}),
    ...(retype.pattern !== undefined ? { pattern: retype.pattern } : {}),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Retype every input named `name`: parameters in any location, a projected
 * body field, and the body schema's property. Returns the type it had (or
 * `untyped`), or `undefined` when nothing carries that name.
 */
function retypeInput(op: Operation, name: string, retype: Retype): string | undefined {
  let previous: string | undefined;
  const typeOf = (schema: Record<string, unknown> | undefined) =>
    typeof schema?.type === "string" ? schema.type : "untyped";
  for (const param of op.input.params) {
    if (param.name !== name) continue;
    previous ??= typeOf(param.schema);
    param.schema = retypedSchema(param.schema ?? {}, retype);
  }
  const body = op.input.body;
  if (!body) return previous;
  for (const field of body.fields) {
    if (field.name !== name) continue;
    previous ??= typeOf(field.schema);
    field.schema = retypedSchema(field.schema ?? {}, retype);
  }
  const props = body.schema.properties;
  const prop = isObject(props) ? props[name] : undefined;
  if (isObject(props) && isObject(prop)) {
    previous ??= typeOf(prop);
    props[name] = retypedSchema(prop, retype);
  }
  return previous;
}
