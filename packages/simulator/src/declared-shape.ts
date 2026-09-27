/**
 * The response shape an operation declares, read the way the simulator serves
 * it: the whole envelope (the HTTP layer reads its field names) and the one
 * item inside a page. Split out of runtime.ts, which owns serving.
 */
import type { AirDocument, JsonSchema, Operation } from "@anvil/air";
import { materializeSchema } from "@anvil/compiler";
import { servesItems } from "./provider.js";
import { isRecord, nonEmpty } from "./synthesize.js";

/* -------------------------------------------------------------------------- */
/* Declared-shape response bodies                                              */
/* -------------------------------------------------------------------------- */

/**
 * WHY the store and the response are not the same object.
 *
 * The store holds *state*: an id and whatever the domain state machine and a
 * caller's mutations have written. That is the part of a response the simulator
 * is authoritative about, and the part its behavioural guarantees (transitions,
 * replay, pagination) rest on. It is deliberately tiny.
 *
 * The response an agent receives is a *representation* of that state, and the
 * only authority on its shape is the operation's own declared response schema.
 * Two operations on one resource routinely declare different representations of
 * it — a list that returns summaries and a get that returns the full record —
 * so a single stored body could not be faithful to both, and merging their
 * fields would invent a payload neither one serves. Each operation therefore
 * projects its own declared shape over the shared state at response time, with
 * stored fields winning so the state machine, the ids and a mutation's echo
 * remain authoritative over anything synthesis produced.
 *
 * This is not cosmetic. Response cost is a certified property, and it is
 * measured by driving this simulator (see `disclosureSample`). While every body
 * was `{id, status}` a page could not exceed any plausible context budget, so
 * the over-budget verdict was unreachable and a green row certified nothing.
 * The rule that keeps the fix honest: a payload's simulated size must track its
 * *declared* size. A thin contract stays cheap, a 400-field contract simulates
 * as expensive, and nothing is padded to make a budget fail — that would be the
 * same lie pointed the other way.
 *
 * When the contract declares nothing usable, projection is skipped entirely and
 * the response is byte-identical to what the simulator served before. Most
 * contracts are in exactly that state, and their numbers must not move.
 */

/**
 * The declared shape of ONE item in an operation's response, `$ref`-free and
 * bounded, or `undefined` when the contract says nothing usable.
 *
 * `materializeSchema` (the compiler's, not a local copy) does the resolution:
 * it is already the function that turns a possibly-`$ref`-bearing schema into a
 * self-contained one, and it carries the two bounds a synthesizer needs anyway
 * — a ref-depth cap for deep chains and a node cap for broad ones. Reusing it
 * also means the simulator sees the *same* bounded schema the compiler recorded
 * on the operation, so a payload cannot be faithful to a schema no other part
 * of Anvil agrees exists.
 */
export function declaredItemSchema(air: AirDocument, op: Operation): JsonSchema | undefined {
  const schema = declaredResponse(air, op);
  if (!schema) return undefined;
  // A paginated read's declared schema describes the *envelope*; `read` builds
  // the envelope itself, so what it needs is the element type inside it. A
  // single-entity read or a mutation declares the item directly.
  return nonEmpty(servesItems(op) ? unwrapItems(schema, op) : schema);
}

/**
 * An operation's whole declared response schema, `$ref`-free and bounded. The
 * HTTP serving layer reads the page envelope's field names out of it.
 */
export function declaredResponse(air: AirDocument, op: Operation): JsonSchema | undefined {
  const declared = declaredResponseSchema(air, op);
  if (!declared) return undefined;
  const { schema } = materializeSchema(declared, air.schemas);
  return isRecord(schema) ? nonEmpty(schema) : undefined;
}

/** An operation's declared response schema: inline if present, else by named ref. */
function declaredResponseSchema(air: AirDocument, op: Operation): JsonSchema | undefined {
  const inline = nonEmpty(op.output.schema);
  if (inline) return inline;
  const ref = op.output.schemaRef;
  if (!ref) return undefined;
  // A ref is stored either as the bare component name or as a JSON pointer into
  // it; both name the same entry, and a lookup that only understood one of them
  // would silently drop half the documents that carry a ref at all.
  return nonEmpty(air.schemas[ref] ?? air.schemas[ref.split("/").pop() ?? ref]);
}

/**
 * The element schema inside a declared page envelope.
 *
 * `pagination.itemsField` is the contract's own answer and wins when it names a
 * declared property. Otherwise the first array-valued property in declared
 * order is the item array — declared order, not a guess ranked by name, so the
 * choice is a function of the document rather than of a vocabulary we invented.
 * A declared envelope with no array in it is not an envelope we can read, and
 * we return nothing rather than treat the envelope's own fields as an item's:
 * `read` repeats an item once per page slot, so a wrong item shape here is
 * multiplied into a wrong page cost.
 */
function unwrapItems(schema: JsonSchema, op: Operation): JsonSchema | undefined {
  if (schema.type === "array" || isRecord(schema.items)) {
    return isRecord(schema.items) ? (schema.items as JsonSchema) : undefined;
  }
  if (!isRecord(schema.properties)) return undefined;
  const props = schema.properties as Record<string, JsonSchema | undefined>;
  const named = op.pagination?.itemsField;
  const declaredArray = named !== undefined ? props[named] : undefined;
  const candidates = isRecord(declaredArray) ? [declaredArray] : Object.values(props);
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    if (candidate.type !== "array" && !isRecord(candidate.items)) continue;
    if (isRecord(candidate.items)) return candidate.items as JsonSchema;
  }
  return undefined;
}
