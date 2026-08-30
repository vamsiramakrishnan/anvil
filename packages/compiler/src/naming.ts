import type { Diagnostic, HttpMethod, NameWeakness, Operation } from "@anvil/air";
import { nameWeaknesses, snakeCase } from "@anvil/air";
import {
  ACTION_VERB_WORDS,
  actionHasReadIntent,
  actionVerbFor,
  isReadIntentWriteMethod,
} from "./classify.js";

/**
 * The naming pass. Operation names are the agent-facing surface — a CLI that
 * "smells generated" is one an agent second-guesses. Naming therefore is a
 * first-class pass, not an inline heuristic: it derives names *with a confidence
 * and the signals behind it*, resolves collisions deterministically across all
 * three surfaces (id / CLI command / MCP tool) instead of silently suffixing
 * `_2`, and critiques agent-hostile names into reviewable diagnostics.
 */

export interface DerivedNames {
  id: string;
  canonicalName: string;
  displayName: string;
  cliCommand: string;
  toolName: string;
  resource: string;
  action: string;
  /** 0..1 confidence that these names are agent-friendly and stable. */
  confidence: number;
  /** Human-readable reasons behind the confidence (for review). */
  signals: string[];
}

export const singularize = (s: string): string => {
  if (/ies$/.test(s)) return s.replace(/ies$/, "y");
  // `-ches` words whose stem really ends in `-che` (GitHub's actions caches):
  // stripping the whole `es` would mint a non-word, the exact defect this
  // function exists to avoid, so these few known stems lose only the `s`.
  if (/(?:caches|niches|headaches|mustaches|avalanches)$/.test(s)) return s.replace(/s$/, "");
  // Sibilant stems take `-es`; stripping it restores the stem whole
  // (searches→search, branches→branch, boxes→box, addresses→address). A single
  // `z` is deliberately NOT in the class — `sizes`/`prizes` are `-e` stems and
  // a true z-sibilant plural doubles the z (`quizzes`).
  if (/(?:ch|sh|x|zz|ss)es$/.test(s)) return s.replace(/es$/, "");
  // Singular nouns ending in `-us` (status, bus, virus) pluralize to `-uses`;
  // strip the `es` so the singular keeps its final `s`.
  if (/uses$/.test(s)) return s.replace(/es$/, "");
  // Every other `-ses` is a `-se` stem plus a plural `s` (releases, databases,
  // cases, licenses): strip only the final `s`. The old blanket `-ses → -s`
  // branch over-stripped these to non-words (`releas`, `databas`) that no
  // operation's own name text can ever corroborate.
  if (/ses$/.test(s)) return s.replace(/s$/, "");
  if (/s$/.test(s) && !/(?:ss|us)$/.test(s)) return s.replace(/s$/, "");
  return s;
};

/**
 * The ONE projection from a (service, resource, action) triple to the four
 * routing names — id, canonicalName, CLI command, MCP tool name. `deriveNames`
 * produces these inline from a parsed operation (and honours a declared
 * operationId for the canonicalName); this is the same projection for the case
 * where those axes are supplied DIRECTLY — a manifest `resource`/`action`
 * override (overlay.ts) — so an override re-homes an operation onto names that
 * are byte-identical to what a spec naming that resource would have produced.
 * The canonicalName here is always synthesized `action_singular(resource)` (an
 * override names the routing, not an operationId), and every surface derives
 * from it, so the four names can never drift apart.
 */
export function projectRoutingNames(
  serviceId: string,
  resource: string,
  action: string,
): { id: string; canonicalName: string; cliCommand: string; toolName: string } {
  const canonicalName = `${action}_${singularize(resource)}`;
  return {
    id: `${serviceId}.${snakeCase(resource)}.${action}`,
    canonicalName,
    cliCommand: `${serviceId} ${resource} ${action}`,
    toolName: `${serviceId}_${canonicalName}`,
  };
}

/** An API-version path segment: `v1`, `v60`, `v60.0`, `2.0`. Never a resource. */
function isVersionLike(segment: string): boolean {
  return /^v?\d+(\.\d+)*$/i.test(segment);
}

/**
 * CRUD/method verbs that RPC-over-HTTP estates write as bare trailing path
 * segments: Plaid's `POST /transactions/get`, Zendesk's `GET /views/count`.
 * Deliberately NOT `ACTION_VERB_WORDS`: that vocabulary's words (trigger,
 * status, filter, query, report, message, lock) are real REST collections on
 * real estates, and disqualifying them as resources regresses more operations
 * than it repairs — measured in
 * docs/design/resource-derivation-and-tool-name-stutter.md §6. This closed
 * list holds only words that name a data operation and essentially never name
 * a collection.
 */
const CRUD_SEGMENT_WORDS = new Set([
  "get",
  "list",
  "create",
  "update",
  "delete",
  "remove",
  "destroy",
  "show",
  "insert",
  "count",
  "sync",
  "refresh",
  "upsert",
  "replace",
  "add",
  "set",
  "new",
  "restore",
  "recover",
]);

/** Quantity qualifiers that turn a verb segment into a bulk RPC method: `count_many`. */
const BULK_QUALIFIERS = new Set(["many", "all", "bulk", "batch", "multiple"]);

/** The flat action-verb vocabulary, for recognizing a verb-headed bulk segment. */
const ACTION_VERB_VOCAB = new Set<string>(Object.values(ACTION_VERB_WORDS).flat());

/**
 * A bulk-qualified RPC method segment (rule A of the resource-derivation design
 * doc): a multi-token segment whose head is a verb — from the shared action
 * vocabulary or the CRUD list above — and whose EVERY remaining token is a
 * quantity qualifier (`count_many`, `show_many`, `destroy_many`). This is a
 * strict generalisation of the bare-trailing-verb rule in `deriveNames`,
 * relaxing its single-word guard for this one closed shape only: the guard
 * exists because GraphQL/gRPC lower every operation to a multi-word field
 * segment (`acceptEnterpriseAdminInvitation`) that must stay the resource, and
 * no such field ends in `_many`.
 */
function isBulkVerbSegment(segment: string): boolean {
  const tokens = snakeCase(segment).split("_").filter(Boolean);
  if (tokens.length < 2) return false;
  const head = tokens[0] as string;
  return (
    (ACTION_VERB_VOCAB.has(singularize(head)) || CRUD_SEGMENT_WORDS.has(head)) &&
    tokens.slice(1).every((t) => BULK_QUALIFIERS.has(t))
  );
}

/**
 * Estate-wide path knowledge for `deriveNames`: which concrete words appear as
 * a NON-terminal path segment somewhere in the estate. A verb word that also
 * names a real collection here (`/reports/{id}/lines` makes `reports` one) must
 * never be re-homed off a path that merely ends in it — this is the cheap
 * statistical pre-filter applied BEFORE the bare-CRUD-verb rule, insurance
 * against the one shape that rule could misread. It fired zero times on all six
 * estates the design doc measured; it exists so the seventh estate is safe too.
 *
 * The context is also the "this estate's paths follow resource grammar" signal:
 * `normalize` builds one only for source kinds whose paths ARE resource paths
 * (OpenAPI/Swagger, Discovery, Postman, OData). An adapter-lowered RPC kind
 * (WSDL, GraphQL, protobuf, MCP) writes `/<SyntheticWrapper>/<methodName>`
 * paths, where re-homing a bare verb name (NetSuite's `get`, `add`, `getAll`)
 * would collapse every such operation onto the wrapper as its resource — the
 * exact failure the trailing-verb rule's single-word guard exists to prevent.
 * No context, no re-homing.
 */
export interface EstatePathContext {
  /** Lower-cased concrete non-terminal segments across every path in the estate. */
  nonTerminalSegments: ReadonlySet<string>;
}

/** Concrete, version-stripped path segments, cleaned the way naming reads them. */
function concreteResourceSegments(path: string): string[] {
  return (path.split("?")[0] as string)
    .split("/")
    .filter((s) => s && !s.startsWith("{"))
    .map((s) => s.replace(FORMAT_SUFFIX, "").replace(/\(.*\)$/, ""))
    .filter((s) => s && !isVersionLike(s));
}

/** Build the estate-wide context from every path the compile will name. */
export function estatePathContext(paths: Iterable<string>): EstatePathContext {
  const nonTerminalSegments = new Set<string>();
  for (const path of paths) {
    const segments = concreteResourceSegments(path);
    for (let i = 0; i < segments.length - 1; i++) {
      nonTerminalSegments.add((segments[i] as string).toLowerCase());
    }
  }
  return { nonTerminalSegments };
}

/**
 * Re-home a resource that is really a trailing method segment (rules A and C of
 * docs/design/resource-derivation-and-tool-name-stutter.md): walk left from the
 * segment that produced the resource while it is a bulk-qualified verb (rule A)
 * or a bare CRUD verb the estate never uses as a collection (rule C), and name
 * the first real segment instead — `POST /transactions/get` is an operation on
 * `transactions`, not on a resource called `get`.
 *
 * Resource-ONLY by design: `effect.action` stays whatever the HTTP method (or
 * an explicit verb) produced. `OperationAction` has no `count`/`show`/`sync`
 * member, and colliding results (`/activities` and `/activities/count` both
 * landing on `activities.list`) are separated by the collision resolver's own
 * distinguishing-token logic — the honest name for "a count of activities" is
 * a variant of the activities read, which is exactly what that produces.
 *
 * Rule C runs only with estate-wide path knowledge (`estate`), because its
 * guard needs to see every path; without the context the rule stays off rather
 * than running unguarded.
 */
function rehomeMethodSegments(
  resource: string,
  path: string,
  estate: EstatePathContext | undefined,
): string {
  const segments = concreteResourceSegments(path);
  // Anchor on the segment that actually produced the resource (rightmost
  // match), so the walk is a delta on real behaviour — the same anchoring the
  // design doc's measurements used.
  let i = -1;
  for (let k = segments.length - 1; k >= 0; k--) {
    if (singularize(decomposeSegment(segments[k] as string).resource) === singularize(resource)) {
      i = k;
      break;
    }
  }
  if (i < 0) return resource;
  // Both rules need the estate context — for rule C's non-terminal guard, and
  // because its absence marks an adapter-lowered RPC estate (see
  // `EstatePathContext`) whose method-name segments must stay the resource.
  if (!estate) return resource;
  const start = i;
  // Rule A: bulk-qualified verb segments are methods.
  while (i > 0 && isBulkVerbSegment(segments[i] as string)) i--;
  // Rule C: bare CRUD-verb segments are methods — unless the word names a real
  // collection somewhere in this estate (the non-terminal guard).
  while (i > 0) {
    const word = (segments[i] as string).toLowerCase();
    if (!CRUD_SEGMENT_WORDS.has(word) || estate.nonTerminalSegments.has(word)) break;
    i--;
  }
  return i === start ? resource : decomposeSegment(segments[i] as string).resource;
}

/**
 * OData addresses a single entity with a key predicate in the SAME segment —
 * `A_BusinessPartner('0001')` or `Address(Partner='1',ID='2')` — where REST
 * would use a separate `/{id}` segment. The predicate is the identity, not part
 * of the resource name, and its presence means the segment addresses one item
 * (so the action is get/update/delete, never list). Returns the bare resource
 * name and whether a key predicate was present.
 */
function stripODataKey(segment: string): { resource: string; keyed: boolean } {
  // The name may itself be dotted: a bound operation's segment is the
  // namespace-qualified `Trippin.Nearby(radiusKm={radiusKm})`, and its inline
  // argument list is wire syntax exactly like a key predicate — never name text.
  const match = /^([A-Za-z_][\w.]*)\(.*\)$/.exec(segment);
  return match
    ? { resource: match[1] as string, keyed: true }
    : { resource: segment, keyed: false };
}

/**
 * A custom method (AIP-136) hangs a verb off the end of the path with a colon —
 * `/v1/items/{item_id}:adjust`, `/v1/orders:search`. The verb names the action
 * over the resource the rest of the path addresses; it is not a segment of its
 * own, and it is the dominant shape in an annotated proto, where anything that
 * is not plain CRUD gets one.
 *
 * Unread, every custom method on a collection collapses onto that collection's
 * POST — `CreateItem` and `AdjustQuantity` both become `items create` — and the
 * disambiguator then has to invent `direct_2`, which is precisely the kind of
 * name an agent has to guess at.
 *
 * Deliberately narrow: only a lowerCamel verb, only after the final segment. A
 * colon anywhere else in a path is not a custom method, and a URI scheme
 * (`https://`) never reaches here because a path is what is passed in.
 */
function stripCustomMethod(path: string): { path: string; action?: string } {
  const idx = path.lastIndexOf(":");
  if (idx < 0) return { path };
  const verb = path.slice(idx + 1);
  if (!/^[a-z][A-Za-z0-9]*$/.test(verb)) return { path };
  // A colon before the last `/` belongs to some earlier segment, not to a
  // trailing custom method.
  if (path.slice(idx).includes("/")) return { path };
  return { path: path.slice(0, idx), action: verb };
}

export function actionFor(method: HttpMethod, endsWithParam: boolean): string {
  switch (method) {
    case "get":
    case "head":
      return endsWithParam ? "get" : "list";
    case "post":
      return "create";
    case "put":
      return "replace";
    case "patch":
      return "update";
    case "delete":
      return "delete";
    default:
      return method;
  }
}

// A REST format-selector suffix on a path segment (Twilio's `.json`, some
// APIs' `.xml`) is not part of the resource name — it selects a wire format.
// It must not leak into the agent-facing resource/CLI/tool names, and leaving
// it in also makes the *same* resource render two ways depending on whether a
// given operation's path carries the suffix (Twilio `Messages.json` for
// list/create vs `Messages` for fetch/delete, whose suffix sits on the id
// segment). Only the derived NAME is cleaned; the wire path (`sourceRef.path`)
// the runtime calls is untouched.
const FORMAT_SUFFIX = /\.(json|xml|csv|ya?ml|txt|html?|proto)$/i;

/**
 * The true action verb from an operationId when the HTTP method genuinely
 * can't express it: a POST reused for update/delete (Twilio's `UpdateMessage`,
 * `DeleteX` are all `POST`, since Twilio — like several REST APIs — reuses
 * POST for mutation-that-isn't-create). Scoped deliberately to POST and to
 * update/delete only: POST already defaults to "create", and this is exactly
 * the ambiguity the method drops. It does NOT trust a leading verb in general
 * — Stripe's `GetCustomers` is really a *list*, so honoring "get" there would
 * be worse than the method+path inference — so only these two method-defeating
 * cases are overridden, keeping the CLI action aligned with the
 * operationId-derived tool name (`twilio_update_message`, not a `_post`
 * disambiguation suffix) and preventing the create/update collision.
 */
function postVerbFromOperationId(operationId: string | undefined): string | undefined {
  if (!operationId) return undefined;
  const s = snakeCase(operationId);
  if (/^(update|edit|modify|patch)(_|$)/.test(s)) return "update";
  if (/^(delete|remove|destroy)(_|$)/.test(s)) return "delete";
  return undefined;
}

/**
 * The action for a PATCH/PUT whose operationId names an *upsert* — the
 * idempotent create-or-update by an external key (Salesforce's
 * `upsertAccountByExternalId`, many OData/REST APIs). The HTTP method collapses
 * it to "update", so a plain `updateX` and an `upsertX` on the same resource
 * would collide onto one command and disambiguate with a meaningless `_patch`
 * suffix. Honouring the operationId verb keeps them distinct and truthful
 * (`account update` vs `account upsert`). Scoped to the one verb the method
 * genuinely drops, mirroring `postVerbFromOperationId`.
 */
function upsertVerbFromOperationId(operationId: string | undefined): string | undefined {
  if (!operationId) return undefined;
  return /^upsert(_|$)/.test(snakeCase(operationId)) ? "upsert" : undefined;
}

/**
 * Decompose a concrete path segment into a resource token and, when the
 * segment is an RPC-style dotted method (Slack's `chat.postMessage`,
 * `users.profile.set`), the method name that should drive the action. A plain
 * REST segment (no dot after stripping any format suffix) yields the segment
 * itself as the resource and no rpc action.
 *
 * This is the general form of the same principle behind the verb-trailing-
 * segment handling below: the agent-facing name must reflect what the
 * operation *is*, not the literal shape of one URL segment — and it keeps the
 * CLI command aligned with the operationId-derived MCP tool name (Slack's
 * `chat.postMessage` → CLI `slack chat post_message`, tool
 * `slack_chat_post_message`) instead of drifting to `chat.postMessage send`.
 */
function decomposeSegment(segment: string): { resource: string; rpcAction?: string } {
  const noSuffix = segment.replace(FORMAT_SUFFIX, "");
  // A dotted API-version segment (`v60.0`, `2.0`) is not an RPC dotted method —
  // splitting it would make the version ("v60") the resource and its minor
  // ("0") the action. It is not a resource at all; return it whole so the
  // caller's version guard can skip it.
  if (isVersionLike(noSuffix)) return { resource: noSuffix };
  if (noSuffix.includes(".")) {
    const parts = noSuffix.split(".").filter(Boolean);
    if (parts.length >= 2) {
      // Last component is the method (drives the action); EVERYTHING before it
      // is the resource namespace, joined — not just the immediate parent.
      // Slack has both `conversations.archive` and `admin.conversations.archive`;
      // keeping only `conversations` would collapse them onto one name (a
      // spurious collision), so the resource is `conversations` vs
      // `admin_conversations` — distinct, and each still reads as what it is.
      return {
        resource: parts.slice(0, -1).join("_"),
        rpcAction: parts[parts.length - 1],
      };
    }
  }
  return { resource: noSuffix || segment };
}

interface RawForNaming {
  operationId?: string;
  summary?: string;
}

/**
 * Derive the names for one operation, scoring how trustworthy the result is.
 * A declared `operationId` is the strongest signal; a name synthesized purely
 * from an HTTP verb over a service-level fallback resource is the weakest.
 */
export function deriveNames(
  serviceId: string,
  path: string,
  method: HttpMethod,
  raw: RawForNaming,
  estate?: EstatePathContext,
): DerivedNames {
  // A coordinate may carry query text an adapter compiled into it — an OData v2
  // function import is addressed as `/ActivateProduct?ProductID='{id}'`. That
  // is wire syntax, never part of a resource name, so naming never sees it.
  // A trailing `:verb` is then read off before any segment reasoning: it names
  // the action, and everything before it is the resource path as usual.
  const custom = stripCustomMethod(path.split("?")[0] as string);
  const segments = custom.path.split("/").filter(Boolean);
  const concrete = segments.filter((s) => !s.startsWith("{"));
  const hasResource = concrete.length > 0;
  // Clean the trailing segment before reading anything off it: strip a REST
  // format suffix (`Messages.json` → `Messages`) and split an RPC-style dotted
  // method (`chat.postMessage` → resource `chat`, method `postMessage`). Both
  // otherwise leak the literal URL shape into the agent-facing names.
  // An OData key predicate rides on the segment (`Set('id')`); strip it to the
  // bare resource name before any other segment reasoning, and remember that the
  // segment addresses a single item.
  const lastStripped = concrete[concrete.length - 1];
  const odata = lastStripped !== undefined ? stripODataKey(lastStripped) : undefined;
  const lastRaw = odata?.resource ?? concrete[concrete.length - 1];
  let decomposed = lastRaw !== undefined ? decomposeSegment(lastRaw) : undefined;
  // An OData *bound* operation rides as `/Set(key)/Namespace.Operation`. The
  // dotted segment's prefix is the schema namespace — never a resource — and
  // the entity the operation acts on is the keyed set right before it. So the
  // set names the resource and the operation names the action, which is how
  // the same call reads in OData's own documentation. The keyed previous
  // segment is what makes this unambiguous: only OData writes a key predicate
  // into a segment, so a Slack-style `chat.postMessage` (no keyed segment
  // before it) never takes this branch.
  if (decomposed?.rpcAction !== undefined && concrete.length > 1) {
    const prev = stripODataKey(concrete[concrete.length - 2] as string);
    if (prev.keyed) {
      decomposed = {
        resource: decomposeSegment(prev.resource).resource,
        rpcAction: decomposed.rpcAction,
      };
    }
  }
  // A static trailing path segment that names a verb from the shared action
  // vocabulary (classify.ts) is a verb over the resource before it, not a
  // sub-resource itself — e.g. `GET /field/search` searches fields, it does not
  // read a resource called "search". Naively taking the last segment as the
  // resource misreads these ("search list field" instead of "field search").
  // Reusing classify.ts's table (rather than a second, parallel keyword list)
  // is what keeps this verb and `effect.action` from ever disagreeing.
  const lastConcrete = decomposed?.resource;
  // Only a *bare* trailing verb (a single-word segment that IS the verb, like
  // `/field/search`) names an action over the resource before it. A multi-word
  // segment that merely *contains* a vocab verb is a full operation name, not a
  // verb: GraphQL/gRPC lower every operation to `/graphql/Mutation/<field>` or
  // `/<pkg.Service>/<Method>`, and a field like `acceptEnterpriseAdminInvitation`
  // (contains "accept") or `issueFigmaFileKeySearch` (ends "search") must stay
  // the resource, or every field collapses onto the synthetic `Mutation`/`Query`
  // wrapper as its resource and collides — then disambiguation re-appends the
  // field name and the tool name doubles.
  // A bare trailing verb names an action over the segment BEFORE it — but only
  // when that segment is a real resource. When it is an API version (or absent),
  // the trailing segment IS the resource: `/data/v60.0/query` is the `query`
  // resource, not a `search` over the version.
  const beforeLast = concrete.length > 1 ? concrete[concrete.length - 2] : undefined;
  const beforeIsResource = beforeLast !== undefined && !isVersionLike(beforeLast);
  const trailingVerb =
    decomposed?.rpcAction === undefined &&
    lastConcrete !== undefined &&
    beforeIsResource &&
    !snakeCase(lastConcrete).includes("_")
      ? actionVerbFor(lastConcrete)
      : undefined;
  const declaredIntentSignals = [raw.operationId, raw.summary].filter((value): value is string =>
    Boolean(value),
  );
  const semanticSignal = `${raw.operationId ?? ""} ${raw.summary ?? ""} ${path}`;
  // Read-family path words are also frequently persisted sub-resources:
  // `PUT .../status`, `POST .../filter`. On a write method they name an action
  // only when the narrow effect classifier also proved a read (POST search
  // without declared persistence intent). Otherwise the HTTP write action wins
  // and the last segment remains the resource, keeping CLI routing aligned
  // with the final effect instead of emitting `orders poll` for
  // `replaceOrderStatus`.
  const effectiveTrailingVerb =
    trailingVerb !== undefined &&
    actionHasReadIntent(trailingVerb) &&
    !["get", "head"].includes(method) &&
    !isReadIntentWriteMethod(method, semanticSignal, declaredIntentSignals)
      ? undefined
      : trailingVerb;
  const segmentResource =
    effectiveTrailingVerb && concrete.length > 1
      ? decomposeSegment(concrete[concrete.length - 2] as string).resource
      : hasResource
        ? (lastConcrete as string)
        : undefined;
  // A trailing method segment (bulk-qualified verb, or bare CRUD verb — rules
  // A/C) names an operation, not a thing; re-home the resource onto the real
  // segment before it. Resource-only: the action below is untouched.
  const resource =
    segmentResource !== undefined
      ? rehomeMethodSegments(segmentResource, custom.path, estate)
      : serviceId;
  // The path addresses a single item when it ends in a `/{param}` segment or an
  // OData key predicate (`Set('id')`) — either way the action is get/update/
  // delete, not list.
  const lastSegment = segments[segments.length - 1] as string | undefined;
  const endsWithParam =
    lastSegment !== undefined && (lastSegment.startsWith("{") || stripODataKey(lastSegment).keyed);
  // A write-method endpoint with a readIntent verb (see classify.ts) is
  // reclassified to a read; the action verb must agree, or the CLI/MCP surface
  // would call a read "create" while its own safety posture says otherwise.
  const readIntentSignal = semanticSignal;
  // Priority: a custom method (`:adjust`) and an RPC method name (Slack
  // `postMessage`) both name the action directly; then a verb-trailing segment;
  // then a read-intent write; then the HTTP-method default. Both are
  // snake_cased so they read as one CLI token (`post_message`) matching the
  // operationId-derived tool name.
  const action = custom.action
    ? snakeCase(custom.action)
    : decomposed?.rpcAction
      ? snakeCase(decomposed.rpcAction)
      : effectiveTrailingVerb
        ? effectiveTrailingVerb
        : isReadIntentWriteMethod(method, readIntentSignal, declaredIntentSignals)
          ? (actionVerbFor(readIntentSignal) as string)
          : method === "post"
            ? (postVerbFromOperationId(raw.operationId) ?? actionFor(method, endsWithParam))
            : method === "patch" || method === "put"
              ? (upsertVerbFromOperationId(raw.operationId) ?? actionFor(method, endsWithParam))
              : actionFor(method, endsWithParam);

  const fromOperationId = Boolean(raw.operationId);
  const canonicalName = raw.operationId
    ? snakeCase(raw.operationId)
    : `${action}_${singularize(resource)}`;
  const displayName =
    raw.summary ?? canonicalName.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

  // Confidence + the signals behind it.
  const signals: string[] = [];
  let confidence = 0.6;
  if (fromOperationId) {
    confidence = 0.9;
    signals.push("name derived from a declared operationId");
  } else {
    signals.push("name synthesized from HTTP method + path");
  }
  // The ONE weakness predicate (shared with the refinement detector via
  // @anvil/air) decides which names an agent cannot route on; the confidence
  // deltas live here because they are a naming-pass concern. Emitted in a fixed
  // order (resource-shape, then verb) so a spec's signals are input-independent.
  // `bare_noun` carries no confidence delta — a single-token name is a review
  // *signal* the detector raises, not on its own a low-confidence one (a bare
  // `refund` from a strong operationId is fine); the other three each pull the
  // score, and `vague_verb`'s -0.45 is large enough to drag even a declared
  // operationId (0.9) below the 0.5 review threshold. Jira's own `doTransition`
  // is exactly that case — Atlassian's community MCP server renames it to
  // `transition_issue` for the same reason this must not stay confident.
  const weaknesses = new Set(nameWeaknesses({ canonicalName, resource, action, hasResource }));
  const verb = canonicalName.split("_")[0] ?? "";
  const WEAKNESS_DELTA: ReadonlyArray<{ w: NameWeakness; delta: number; signal: string }> = [
    {
      w: "no_resource",
      delta: -0.25,
      signal: "no concrete path segment — resource fell back to the service name",
    },
    {
      w: "generic_resource",
      delta: -0.3,
      signal: `generic resource "${snakeCase(resource)}" — names no concrete thing an agent can route on`,
    },
    {
      w: "vague_verb",
      delta: -0.45,
      signal: `vague verb "${verb}" — hard for an agent to route on`,
    },
  ];
  for (const { w, delta, signal } of WEAKNESS_DELTA) {
    if (weaknesses.has(w)) {
      confidence += delta;
      signals.push(signal);
    }
  }

  return {
    id: `${serviceId}.${snakeCase(resource)}.${action}`,
    canonicalName,
    displayName,
    cliCommand: `${serviceId} ${resource} ${action}`,
    toolName: `${serviceId}_${canonicalName}`,
    resource,
    action,
    confidence: Math.max(0, Math.min(1, confidence)),
    signals,
  };
}

/** Globally-minimal candidate order: shortest first, ties lexicographic. */
const byShortestThenLex = (a: string, b: string): number =>
  a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);

/**
 * The canonical processing order inside a collision group. Every step of the
 * repair (token choice, `usedTokens` dedupe, index fallback) iterates the group
 * in this order, so the final assignment is a pure function of the group's
 * MEMBERSHIP — never of the order operations arrived from the source file.
 */
const byStableIdentity = (a: Operation, b: Operation): number =>
  (a.sourceRef.path ?? "").localeCompare(b.sourceRef.path ?? "") ||
  (a.sourceRef.method ?? "").localeCompare(b.sourceRef.method ?? "") ||
  (a.sourceRef.operationId ?? "").localeCompare(b.sourceRef.operationId ?? "");

/**
 * The projected surfaces on which every operation name must be unique. This set
 * must stay in lockstep with the uniqueness checks in `validate.ts` — the
 * resolver has to repair every surface the validator will hard-error on, or a
 * collision the resolver cannot see becomes a compile error instead of a
 * deterministic rename. `validate.ts` enforces three: operation id, MCP tool
 * name, and CLI command. All three can collide INDEPENDENTLY, because each is
 * projected through a DIFFERENT normalization:
 *
 * - CLI command vs MCP tool name: Linear's GraphQL schema has both
 *   `Query.initiativeUpdate` and `Mutation.initiativeUpdate`, whose commands
 *   differ (`… list` vs `… create`) while both derive the same canonicalName and
 *   hence the same tool name — grouping by command alone never sees them.
 * - operation id vs both: the id snake-cases the resource
 *   (`${service}.${snakeCase(resource)}.${action}`) while the CLI command keeps
 *   the raw resource token and the tool name derives from the operationId. So
 *   two resources that differ ONLY by a separator that snake-case folds —
 *   Datadog's `apm/config/retention-filters` vs `rum/.../retention_filters` —
 *   share one id but have distinct commands and tool names. Neither of the other
 *   two surfaces groups them, so without the id surface the id collision is
 *   never repaired and the spec fails on `duplicate_operation_id`.
 *
 * Ordering: id is checked LAST, so a collision already repairable via the more
 * meaningful command/tool surfaces is handled there first; the id surface only
 * catches the residue those two cannot see. This keeps every previously-green
 * spec byte-identical (its id surface finds nothing new) while turning the
 * id-only class from a hard error into a deterministic disambiguation.
 */
const SURFACES: ReadonlyArray<{ label: string; keyOf: (op: Operation) => string }> = [
  { label: "CLI command", keyOf: (op) => op.cli.command },
  { label: "MCP tool name", keyOf: (op) => op.mcp.toolName },
  { label: "operation id", keyOf: (op) => op.id },
];

/**
 * Resolve name collisions across the whole operation set, coherently across id,
 * CLI command, and MCP tool name (they must not drift apart). Uniqueness is
 * enforced on EVERY projected surface (command and tool name), not just the CLI
 * command. Disambiguation is deterministic, input-order-independent, and
 * meaningful: the globally-minimal path token that distinguishes the clashing
 * operations (shortest, ties lexicographic), then the shortest distinguishing
 * token pair, then the HTTP method, then a stable index. Every rename is
 * surfaced as a diagnostic — never silent.
 */
export function resolveNameCollisions(operations: Operation[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  // A rename triggered by one surface updates all three names, which the next
  // surface's grouping must see — so re-derive groups and repeat to a fixpoint.
  // Termination: a pass only acts on a colliding group and leaves that group's
  // keys unique, and suffixed names only ever grow; in practice this settles in
  // one or two sweeps. The bound is a safety net — validate() still hard-errors
  // on any duplicate that could somehow survive it.
  for (let sweep = 0; sweep < 10; sweep++) {
    let changed = false;
    for (const surface of SURFACES) {
      changed = resolveSurfaceCollisions(operations, surface, diagnostics) || changed;
    }
    if (!changed) break;
  }
  return diagnostics;
}

/** One repair pass over one surface. Returns whether any group was renamed. */
function resolveSurfaceCollisions(
  operations: Operation[],
  surface: { label: string; keyOf: (op: Operation) => string },
  diagnostics: Diagnostic[],
): boolean {
  const groups = new Map<string, Operation[]>();
  for (const op of operations) {
    const key = surface.keyOf(op);
    const list = groups.get(key) ?? [];
    list.push(op);
    groups.set(key, list);
  }

  // Order-independence: group membership is a set (keyed by the surface name,
  // which cannot depend on input order), groups are processed in sorted-key
  // order, and members in `byStableIdentity` order. Shuffling the input spec
  // therefore yields byte-identical assignments.
  let changed = false;
  const keys = [...groups.keys()].sort();
  for (const key of keys) {
    const group = groups.get(key) as Operation[];
    if (group.length < 2) continue;
    changed = true;
    group.sort(byStableIdentity);
    const usedTokens = new Set<string>();
    for (const [index, op] of group.entries()) {
      // A candidate the operation's own canonicalName already ends with would
      // stutter at the join (`count_activities` + `activities` →
      // `…_count_activities_activities`), so take the next candidate instead:
      // first non-stuttering distinguishing token, then a non-stuttering subset
      // fallback (its stuttering lead word elided, if the elision is still
      // free in this group). Only when EVERY meaningful token stutters is the
      // original stuttering choice kept — a doubled word still beats the
      // meaningless method/index fallbacks, and beats a numbered blank.
      const candidates = distinguishingTokenCandidates(op, group);
      const fallback = subsetFallbackToken(op, group);
      const fallbackStutters = fallback !== undefined && suffixStutters(op, fallback);
      const elided =
        fallback !== undefined && fallbackStutters ? elideStutter(op, fallback) : undefined;
      let token =
        candidates.find((candidate) => !suffixStutters(op, candidate)) ??
        (fallback !== undefined && !fallbackStutters ? fallback : undefined) ??
        (elided !== undefined && !usedTokens.has(elided) ? elided : undefined) ??
        candidates[0] ??
        fallback ??
        op.sourceRef.method ??
        String(index + 1);
      let candidate = token;
      let n = 2;
      while (usedTokens.has(candidate)) candidate = `${token}_${n++}`;
      token = candidate;
      usedTokens.add(token);

      const suffix = snakeCase(token);
      const before = op.id;
      op.canonicalName = `${op.canonicalName}_${suffix}`;
      op.id = `${op.id}.${suffix}`;
      op.cli.command = `${op.cli.command} ${suffix}`;
      op.mcp.toolName = `${op.mcp.toolName}_${suffix}`;
      diagnostics.push({
        level: "info",
        code: "naming_collision_resolved",
        message: `${surface.label} "${key}" was shared; disambiguated "${before}" with "${suffix}".`,
        operationId: op.id,
      });
    }
  }
  return changed;
}

/**
 * A truthful token for the subset-shaped remainder: an operation whose token
 * pool is a strict subset of a sibling's has no positive distinguisher (POST
 * `/refunds` vs POST `/refunds/{refund}`), so name what it IS — an item op
 * takes `by_<last param>`, a collection op takes its distinctive concrete
 * segments (those not shared by the whole group) plus `direct`, or bare
 * `direct` at the group's root. Deterministic, and glanceable where the old
 * method fallback was noise.
 */
function subsetFallbackToken(op: Operation, group: Operation[]): string | undefined {
  const segments = (op.sourceRef.path ?? "").split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  if (last?.startsWith("{") && last.endsWith("}")) {
    return `by_${snakeCase(last.slice(1, -1))}`;
  }
  // A token is distinctive when at least one group member's path lacks it — the
  // complement of "shared by all". Testing membership directly avoids rebuilding
  // an intersection Set per member, and avoids a reduce with no initial value
  // (which would throw on an empty group rather than return a token).
  const groupTokens = group.map((o) => new Set(cleanPathTokens(o.sourceRef.path)));
  const distinctive = cleanPathTokens(op.sourceRef.path).filter((t) =>
    groupTokens.some((tokens) => !tokens.has(t)),
  );
  return distinctive.length > 0 ? `${distinctive.join("_")}_direct` : "direct";
}

/** Concrete path segments as cleaned word-tokens: format suffix stripped, RPC
 * dotted segments split into their parts. So a distinguishing token is always
 * a real word (`admin`, `local`), never a raw `Messages.json` or a whole
 * dotted method — the same cleaning the derived names already got. */
function cleanPathTokens(path: string | undefined): string[] {
  return (path ?? "")
    .split("/")
    .filter((s) => s && !s.startsWith("{"))
    .flatMap((s) => s.replace(FORMAT_SUFFIX, "").split(".").filter(Boolean));
}

/**
 * The globally-minimal tokens that distinguish `op` from the rest of its
 * collision group, in preference order: among ALL of the operation's own
 * cleaned path tokens that no other group member's path contains, shortest
 * first (ties break lexicographically) — not first-in-path-order, which on
 * real specs drags in long prefix segments (`administrative_gateway`) when a
 * short unique token (`v2`) exists further along. Single tokens come before
 * distinguishing PAIRS of own tokens (joined `_`, kept in path order); an
 * empty result sends the caller to the HTTP method / stable index fallbacks.
 * Returned as an ordered list so the caller can skip a candidate that would
 * stutter against the operation's own name (`suffixStutters`).
 */
/** Path parameter names as `by_<name>` pseudo-tokens (`/refunds/{refund}` →
 * `by_refund`). Concrete tokens alone cannot distinguish routes that differ
 * only in their parameters — Stripe's `/application_fees/{fee}/refunds/{id}`
 * vs `/application_fees/{id}/refunds` clean to identical token lists — and the
 * old method+counter fallback produced the meaningless `post`/`post_2` names a
 * consuming agent cannot choose between. */
function paramTokens(path: string | undefined): string[] {
  return (path ?? "")
    .split("/")
    .filter((s) => s.startsWith("{") && s.endsWith("}"))
    .map((s) => `by_${snakeCase(s.slice(1, -1))}`);
}

function distinguishingTokenCandidates(op: Operation, group: Operation[]): string[] {
  const mine = [...cleanPathTokens(op.sourceRef.path), ...paramTokens(op.sourceRef.path)];
  const others = group
    .filter((o) => o !== op)
    .map((o) => new Set([...cleanPathTokens(o.sourceRef.path), ...paramTokens(o.sourceRef.path)]));

  const unique = [...new Set(mine.filter((seg) => others.every((set) => !set.has(seg))))];

  // Pairs of own tokens (in path order) that no other member's path contains in
  // full — the recourse when no single token distinguishes.
  const pairs: string[] = [];
  for (let i = 0; i < mine.length; i++) {
    for (let j = i + 1; j < mine.length; j++) {
      const a = mine[i] as string;
      const b = mine[j] as string;
      if (a === b) continue;
      if (others.every((set) => !(set.has(a) && set.has(b)))) pairs.push(`${a}_${b}`);
    }
  }
  return [...unique.sort(byShortestThenLex), ...[...new Set(pairs)].sort(byShortestThenLex)];
}

/**
 * Whether appending `token` to the operation's canonicalName would stutter,
 * compared word-by-word singularized. Two shapes qualify: an adjacent repeat at
 * the join (`count_activities` + `activities`,
 * `apps_get_webhook_config_for_app` + `app`), and a token the canonicalName
 * already ENDS with (`asset_report_create` + the pair `asset_report_create`,
 * which would double the whole phrase). Only the operation's own name is
 * checked — a repeat the vendor wrote into its operationId
 * (`copilot/copilot-…`) is the vendor's name and is never rewritten here.
 */
function suffixStutters(op: Operation, token: string): boolean {
  const nameWords = op.canonicalName.split("_").filter(Boolean).map(singularize);
  const tokenWords = snakeCase(token).split("_").filter(Boolean).map(singularize);
  const last = nameWords[nameWords.length - 1];
  if (last === undefined || tokenWords.length === 0) return false;
  if (tokenWords[0] === last) return true;
  if (tokenWords.length <= nameWords.length) {
    const tail = nameWords.slice(nameWords.length - tokenWords.length);
    if (tail.every((word, i) => word === tokenWords[i])) return true;
  }
  return false;
}

/**
 * A composite token (the subset fallback's `<distinctive>_direct`) with its
 * stuttering lead word(s) dropped: `get_direct` after `transactions_get` →
 * `direct`. Undefined when nothing survives the elision — the caller then
 * decides between the stuttering original and its other candidates.
 */
function elideStutter(op: Operation, token: string): string | undefined {
  const nameWords = op.canonicalName.split("_").filter(Boolean);
  const last = nameWords[nameWords.length - 1];
  if (last === undefined) return undefined;
  const words = snakeCase(token).split("_").filter(Boolean);
  while (words.length > 0 && singularize(words[0] as string) === singularize(last)) words.shift();
  return words.length > 0 ? words.join("_") : undefined;
}

/** An immediately repeated word anywhere in a snake_cased name. */
function hasAdjacentRepeat(name: string): boolean {
  const words = name.split("_").filter(Boolean);
  return words.some((word, i) => i > 0 && word === words[i - 1]);
}

/**
 * A compile-time warning when the operator's chosen service id duplicates the
 * leading word of the spec's own operationIds, so the
 * `${serviceId}_${canonicalName}` tool-name join stutters. The join itself is
 * deliberately left alone: the operationId is the vendor's declared name and
 * the service id is the operator's choice — rewriting either would be exactly
 * the guessing Anvil exists to stop, so the operator gets a loud signal
 * instead. The measured case is BigQuery under `--service bigquery` over
 * Discovery operationIds like `bigquery.models.get`: 42 of 42 tool names
 * stutter (`bigquery_bigquery_models_get`), and zero do when the service id is
 * left to be derived (`big_query_api`).
 */
export function servicePrefixStutterDiagnostic(
  serviceId: string,
  operations: readonly Operation[],
): Diagnostic | undefined {
  const stuttering = operations.filter((op) => {
    const operationId = op.sourceRef.operationId;
    if (!operationId) return false;
    const canonical = snakeCase(operationId);
    // Only a repeat the JOIN introduces counts — a repeat already inside the
    // vendor's own operationId is the vendor's name, not the operator's choice.
    return !hasAdjacentRepeat(canonical) && hasAdjacentRepeat(`${serviceId}_${canonical}`);
  });
  if (stuttering.length === 0) return undefined;
  const example = stuttering[0] as Operation;
  return {
    level: "warning",
    code: "service_prefix_stutter",
    message:
      `Service id "${serviceId}" duplicates the leading word of ${stuttering.length} ` +
      `operationId${stuttering.length === 1 ? "" : "s"} ` +
      `(e.g. "${example.sourceRef.operationId}"), so every affected MCP tool name stutters ` +
      `("${example.mcp.toolName}"). The vendor's operationIds are kept verbatim; pick a ` +
      `different service id, or omit it to let Anvil derive one from the spec title.`,
  };
}

/**
 * Critique the final names for agent-friendliness, emitting reviewable
 * diagnostics. This is the "review output" a human reads instead of the YAML:
 * which operations have weak or ambiguous names, and why.
 */
export function critiqueNames(
  operations: Operation[],
  nameConfidence: Map<string, number>,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const op of operations) {
    const conf = nameConfidence.get(op.id);
    if (conf !== undefined && conf < 0.5) {
      diagnostics.push({
        level: "info",
        code: "weak_operation_name",
        message: `Operation "${op.id}" has a low-confidence name (${conf.toFixed(2)}). Consider a manifest display_name / operationId so agents can route on it.`,
        operationId: op.id,
      });
    }
  }
  return diagnostics;
}
