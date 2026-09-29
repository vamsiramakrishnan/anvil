/**
 * The manifest patches that describe an operation's inputs and how a read
 * pages: `pagination` and `params`. Split out of manifest.ts, which owns the
 * manifest's shape and its safety patches; these two only correct how the
 * wire is described, and each declines with a review note rather than bind
 * to an input the operation does not have.
 */
import { type Operation, operationInputSchema } from "@anvil/air";
import { z } from "zod";
import { type AlternativeNarrowing, narrowToAlternative } from "./schema-alternatives.js";

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
 * Retype an input the source types wrongly. Slack's contract types a message
 * timestamp (`chat.delete`'s `ts`, `"1700000000.123400"`) as a number, so it
 * would travel as a float and lose its trailing zeros; the timestamp is an id
 * and must be carried as the string it is. The new type replaces the old one
 * with its type-specific constraints; descriptions are kept.
 */
const ManifestRetype = z.strictObject({
  type: z.enum(["string", "number", "integer", "boolean"]),
  format: z.string().optional(),
  pattern: z.string().optional(),
});

/**
 * Narrow a union input (`oneOf`/`anyOf`) to one alternative, tighten-only.
 * Confluence's v2 page write types `body` as `oneOf[PageBodyWrite,
 * PageNestedBodyWrite]` and both accept any object, so a strict `oneOf`
 * refuses every body. `one_of` names the alternative the service reads, by
 * component name (or a `$ref` whose tail is one) or by branch index; the rest
 * may only tighten it (`schema-alternatives.ts`).
 */
const ManifestAlternative = z.strictObject({
  one_of: z.union([z.string().min(1), z.number().int().nonnegative()]),
  properties: z
    .record(
      z.string(),
      z.strictObject({
        enum: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).min(1),
      }),
    )
    .optional(),
  required: z.array(z.string()).min(1).optional(),
  additional_properties: z.literal(false).optional(),
});

/**
 * Correct how an input is typed, by its wire name: a query, path, header, or
 * cookie parameter, or a top-level body field. Either a scalar retype
 * (`type`) or a narrowing of a union to one alternative (`one_of`).
 */
export const ManifestParams = z.record(z.string(), z.union([ManifestRetype, ManifestAlternative]));
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
 * Retype or narrow inputs by wire name. A name that matches nothing, and a
 * narrowing that cannot apply everywhere the input appears, decline with the
 * reason rather than inventing an input or loosening one.
 */
export function applyParamsPatch(op: Operation, params: ManifestParams): void {
  for (const [name, patch] of Object.entries(params)) {
    if ("one_of" in patch) {
      note(op, narrowInput(op, name, patch));
      continue;
    }
    const retyped = retypeInput(op, name, patch);
    note(
      op,
      retyped
        ? `Input '${name}' retyped by manifest: ${retyped} → ${patch.type}.`
        : unmatched(name),
    );
  }
  // An operation that already carries its assembled input schema (one
  // re-enriched after compile) must not serve the schema from before.
  if (op.input.schema !== undefined) op.input.schema = operationInputSchema(op);
}

const unmatched = (name: string) =>
  `params manifest patch for '${name}' left unset: the operation has no parameter ` +
  "or top-level body field of that name.";

type Retype = z.infer<typeof ManifestRetype>;

/** Every schema slot that carries the input `name`, as a getter/setter pair. */
function inputSlots(op: Operation, name: string) {
  const slots: { schema: Record<string, unknown>; set: (s: Record<string, unknown>) => void }[] =
    [];
  for (const param of op.input.params) {
    if (param.name === name)
      slots.push({ schema: param.schema ?? {}, set: (s) => (param.schema = s) });
  }
  const body = op.input.body;
  if (!body) return slots;
  for (const field of body.fields) {
    if (field.name === name)
      slots.push({ schema: field.schema ?? {}, set: (s) => (field.schema = s) });
  }
  const props = body.schema.properties;
  const prop = isObject(props) ? props[name] : undefined;
  if (isObject(props) && isObject(prop))
    slots.push({ schema: prop, set: (s) => (props[name] = s) });
  return slots;
}

/**
 * Narrow every slot carrying `name` to the same alternative, or none of them:
 * a parameter and its body projection that disagreed would be two contracts.
 */
function narrowInput(op: Operation, name: string, narrowing: AlternativeNarrowing): string {
  const slots = inputSlots(op, name);
  if (slots.length === 0) return unmatched(name);
  const results = slots.map((slot) => narrowToAlternative(slot.schema, narrowing));
  const refused = results.find((r) => !r.ok);
  if (refused && !refused.ok) {
    return `params manifest patch for '${name}' left unset: ${refused.reason}.`;
  }
  let alternative = "";
  slots.forEach((slot, i) => {
    const result = results[i];
    if (result?.ok) {
      slot.set(result.schema);
      alternative = result.alternative;
    }
  });
  return `Input '${name}' narrowed by manifest to ${alternative}.`;
}

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
  for (const slot of inputSlots(op, name)) {
    previous ??= typeof slot.schema.type === "string" ? slot.schema.type : "untyped";
    slot.set(retypedSchema(slot.schema, retype));
  }
  return previous;
}
