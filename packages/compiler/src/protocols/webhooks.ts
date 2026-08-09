/**
 * OpenAPI 3.1 `webhooks:` — the compiler's other outbound-in direction.
 *
 * Every other module in this directory (`wsdl.ts`, `graphql.ts`, `grpc.ts`, …)
 * lowers a genuinely foreign spec format into an OpenAPI Path Item so the rest
 * of the pipeline never has to learn a second grammar. `webhooks:` needs none
 * of that: OpenAPI 3.1 §4.8.20 defines the Webhooks Object as structurally
 * IDENTICAL to the Paths Object — a map of name to Path Item Object, with the
 * same method-keyed operations, parameters, requestBody, and responses. The
 * only thing that distinguishes a `webhooks:` entry from a `paths:` entry is
 * provenance: it describes a request the *upstream* sends inbound, not one
 * Anvil sends outbound. So this module does not reimplement Effect/input/
 * output inference at all — normalize.ts's existing per-path loop already
 * does that correctly for any Path Item, webhook or not. It only:
 *
 *   1. Reprojects `webhooks:` into the same `{ path -> Path Item }` shape
 *      `paths:` already is, so it can be merged straight into normalize.ts's
 *      loop input.
 *   2. Stamps two vendor extensions on each operation, the same mechanism
 *      GraphQL/gRPC/SOAP already use to assert a fact the wire shape alone
 *      cannot carry (`x-anvil-effect`), plus a webhook-specific one
 *      (`x-anvil-webhook`) that classify.ts reads to force
 *      `archetype: "webhook_receiver"` unconditionally — structurally
 *      certain from where the operation came from, never inferred from its
 *      shape.
 *
 * `x-anvil-effect: "read"` is asserted because a webhook receiver never calls
 * upstream — there is no outbound mutation regardless of the HTTP method the
 * vendor's convention happens to use to reach US (almost always POST). This is
 * definitional, on the same footing as a GraphQL query's read assertion, not
 * a heuristic.
 */
import type { OpenApiDocument } from "../parse.js";

/**
 * Vendor extension normalize.ts's per-path loop reads to force
 * `archetype: "webhook_receiver"` (see `classify.ts#classifyArchetype`).
 * Exported so normalize.ts and this module can never spell it differently.
 */
export const WEBHOOK_ARCHETYPE_EXTENSION = "x-anvil-webhook" as const;

/** The HTTP-method keys a Path Item Object may carry (same set normalize.ts iterates for `paths:`). */
const PATH_ITEM_METHOD_KEYS = ["get", "put", "post", "delete", "patch", "head"] as const;

/**
 * Reproject `document.webhooks` into a `paths:`-shaped map normalize.ts's
 * existing loop can consume unchanged, stamping each method-keyed operation
 * with the vendor extensions described above.
 *
 * Synthetic path keys are `/webhooks/<name>`, deliberately NOT a claim about a
 * real URL a client could call — webhook names live in the spec's own
 * `webhooks:` namespace, not on the wire. This is also why it is safe from
 * colliding with a REAL `/webhooks` REST path some vendors expose for
 * *managing webhook subscriptions* (Slack, Twilio): that is an ordinary
 * `paths:` entry compiled through the ordinary loop, landing in `operations`
 * as a normal transaction/search operation, never touching this module at
 * all. Only entries that actually live under the spec's `webhooks:` key ever
 * get the `x-anvil-webhook` stamp — path text is never the signal.
 */
export function webhookPathItems(
  document: OpenApiDocument,
): Record<string, Record<string, unknown>> {
  const webhooks = document.webhooks;
  if (!webhooks || typeof webhooks !== "object") return {};

  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, pathItem] of Object.entries(webhooks)) {
    if (!pathItem || typeof pathItem !== "object") continue;
    const stamped: Record<string, unknown> = { ...(pathItem as Record<string, unknown>) };
    for (const method of PATH_ITEM_METHOD_KEYS) {
      const op = (pathItem as Record<string, unknown>)[method];
      if (!op || typeof op !== "object") continue;
      stamped[method] = {
        ...(op as Record<string, unknown>),
        [WEBHOOK_ARCHETYPE_EXTENSION]: true,
        "x-anvil-effect": "read",
      };
    }
    out[`/webhooks/${name}`] = stamped;
  }
  return out;
}

/** Deterministic deep-equality key: object key order never changes what a value IS. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeysDeep(v)]),
    );
  }
  return value;
}

/**
 * Resolve an operation's `callbacks:` object to the `webhooks:` entry it
 * names — the ONLY link `normalize.ts` is allowed to draw between a
 * `longRunning` operation and a compiled webhook operation (§10 of the async
 * design doc). Returns the webhook's name (a key of `document.webhooks`), or
 * `undefined` when no explicit reference exists — never a guess based on
 * naming or resource similarity.
 *
 * OpenAPI's Callback Object shape is `{ <callbackName>: { <runtimeExpr>:
 * PathItem } }`. The spec-native way to point a callback at an ALREADY
 * documented `webhooks:` entry is `<runtimeExpr>: { $ref: '#/webhooks/<name>'
 * }`. By the time this module sees the document, `$ref` has already been
 * fully dereferenced (parse.ts's `dereference()` step runs before
 * `normalize()`), and `@scalar/openapi-parser` clones a fresh copy of the
 * target for every `$ref` occurrence rather than sharing one object instance
 * (`decycle.ts` hit the same fact building `bundleDocument`) — so the literal
 * pointer string is gone by the time we get here, and object identity cannot
 * recover it either.
 *
 * The link is instead recovered structurally: a callback's resolved Path Item
 * is treated as a match for a `webhooks:` entry if and only if its content is
 * byte-for-byte identical (order-insensitive) to that entry's own Path Item.
 * A `$ref` to the same source location always produces identical content;
 * nothing short of that does. This is deliberately NOT fuzzy — a near-miss
 * (one extra header, a renamed field, a hand-duplicated copy that later
 * drifted) is not a match, because a maybe-link is worse than no link (the
 * doctrine this whole area runs on: half a contract is worse than none).
 */
export function callbackWebhookLink(
  rawCallbacks: unknown,
  webhooks: Record<string, Record<string, unknown>> | undefined,
): string | undefined {
  if (!webhooks || Object.keys(webhooks).length === 0) return undefined;
  if (!rawCallbacks || typeof rawCallbacks !== "object") return undefined;

  const byContent = new Map<string, string>();
  for (const [name, pathItem] of Object.entries(webhooks)) {
    byContent.set(canonicalJson(pathItem), name);
  }

  for (const expressions of Object.values(rawCallbacks as Record<string, unknown>)) {
    if (!expressions || typeof expressions !== "object") continue;
    for (const pathItem of Object.values(expressions as Record<string, unknown>)) {
      const match = byContent.get(canonicalJson(pathItem));
      if (match) return match;
    }
  }
  return undefined;
}
