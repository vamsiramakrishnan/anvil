import {
  type AsyncContract,
  type AuthPrincipal,
  type AuthType,
  type BodyField,
  type Confirmation,
  type Effect,
  type EffectKind,
  type HttpMethod,
  type Idempotency,
  type InteractionArchetype,
  isQueryPassthroughParam,
  type JsonSchema,
  type Operation,
  type OperationAction,
  type Param,
  type RetryBasis,
  type RetryCondition,
  type RetryPolicy,
  type RiskLevel,
  type SecretSource,
  snakeCase,
} from "@anvil/air";

/**
 * The effect/idempotency classifier — the semantics the source spec almost
 * never states but an agent must know before acting. Every inference here is
 * conservative: unknown side effect beats assumed safety (spec §2.4).
 */

/** Transient conditions retried by default for retry-safe operations (spec §11). */
export const TRANSIENT_CONDITIONS: RetryCondition[] = [
  "timeout",
  "connection_reset",
  "dns_failure",
  "http_408",
  "http_429",
  "http_500",
  "http_502",
  "http_503",
  "http_504",
];

const READ_METHODS: HttpMethod[] = ["get", "head", "options", "trace"];

// Matched against the snake_cased signal so camelCase operationIds ("createRefund")
// and plurals ("refunds") both hit.
const FINANCIAL = /(refund|charge|payment|payout|transfer|invoice|capture|debit|credit)/;
const DESTRUCTIVE = /(delete|remove|destroy|purge|revoke|terminate|cancel|drop)/;
const COMMS = /(send|email|notify|message|dispatch|publish|sms)/;

/**
 * Strong, declared evidence that a POST persists state. These are deliberately
 * matched only as the LEADING verb of an operationId/summary (see
 * `hasDeclaredMutationIntent`), not anywhere in a path-shaped signal:
 * `searchStoreInventory` still searches a store, while `createSavedFilter`
 * plainly creates state even when its route ends in `/filter`.
 */
const DECLARED_MUTATION_PREFIX =
  /^(create|creates|creating|save|saves|saving|persist|persists|persisting|store|stores|storing|upsert|upserts|upserting|update|updates|updating|delete|deletes|deleting|remove|removes|removing|replace|replaces|replacing|register|registers|registering|submit|submits|submitting|set)(_|$)/;

/** Infer blast radius from method + operation naming/path. */
export function classifyRisk(method: HttpMethod, effect: EffectKind, signal: string): RiskLevel {
  if (effect === "read") return "none";
  const s = snakeCase(signal);
  if (method === "delete" || DESTRUCTIVE.test(s)) return "destructive";
  if (FINANCIAL.test(s)) return "financial";
  if (COMMS.test(s)) return "high";
  return "medium";
}

/**
 * Infer idempotency from HTTP method semantics (spec §12):
 *   GET/HEAD, PUT, DELETE — naturally idempotent
 *   PATCH, POST           — not idempotent by default (conservative)
 */
export function classifyIdempotency(method: HttpMethod): Idempotency {
  switch (method) {
    case "get":
    case "head":
    case "options":
    case "trace":
    case "put":
    case "delete":
      return { mode: "natural", mechanism: "none", keyDerivation: "none" };
    default:
      // POST / PATCH: unknown — require a key we can derive so retries stay safe
      // only when the caller opts in, but default the mode to `none`.
      return { mode: "none", mechanism: "none", keyDerivation: "none" };
  }
}

/**
 * The one action-verb vocabulary (spec §10 richer vocabulary), shared by every
 * consumer that needs to recognize a verb in an operation's naming signal:
 * `classifyAction` (the semantic action), `classifyEffectKind` (a write-method
 * verb with `readIntent` overrides the HTTP-method default), and naming.ts (a
 * verb-shaped trailing path segment names an action, not a sub-resource — see
 * `deriveNames`). One table means these three call sites can never disagree
 * about what a given verb means, which is exactly the failure mode a Jira
 * `POST /search/jql` backtest surfaced: the effect said "read" while the CLI
 * command still said "create".
 *
 * `readIntent` marks the read-family verbs (export/search/poll) used by the
 * read branch of `classifyAction` for action naming. Effect-kind promotion is
 * far narrower than the flag: only the SEARCH family on POST may flip a write
 * method to a read (see `isReadIntentWriteMethod` — finding #25). Poll verbs
 * on a write method are state CHANGES (`PUT /tickets/{id}/status`), export on
 * POST creates a job/artifact, and simulate/validate/approve/cancel/send/
 * reserve/execute stay mutation-family because their real-world
 * implementations often have side effects (quota consumption, temporary
 * holds, audit trail) even when the name reads like an inspection.
 */
interface ActionVerb {
  action: OperationAction;
  pattern: RegExp;
  readIntent: boolean;
}

/**
 * Build a word-boundary-anchored alternation over the snake_cased signal: a
 * word must sit between `_`/start and `_`/end, so "research" can never match
 * "search" (a bare substring test would — "re" + "search"). This matters most
 * for `readIntent` verbs, since they can flip a mutation's effect kind to a
 * read; a substring false positive there would be a real safety regression,
 * not just a cosmetic mislabel.
 */
function wordBoundary(words: readonly string[]): RegExp {
  return new RegExp(`(^|_)(${words.join("|")})(_|$)`);
}

/**
 * The plain word lists behind each vocabulary family — the exact words the
 * `wordBoundary(...)` patterns below are built from. Exported so whole-spec
 * dialect inference (`dialect.ts`) can recognize "a known action verb" from
 * the SAME vocabulary instead of a second, drifting list. The ActionVerb table
 * (patterns + readIntent) stays the classifier's own, unchanged.
 */
export const ACTION_VERB_WORDS = {
  export: ["export", "download", "report", "dump"],
  search: ["search", "query", "find", "lookup", "filter"],
  poll: ["status", "poll", "wait", "progress", "health"],
  simulate: ["simulate", "preview", "dry_run", "estimate", "quote"],
  validate: ["validate", "verify", "check"],
  approve: ["approve", "authorize", "accept", "confirm", "grant"],
  cancel: ["cancel", "revoke", "terminate"],
  send: ["send", "email", "notify", "message", "dispatch", "publish", "sms"],
  reserve: ["reserve", "hold", "lock", "allocate"],
  execute: ["execute", "run", "trigger", "invoke", "start", "launch"],
} as const satisfies Record<string, readonly string[]>;

const ACTION_VERBS: readonly ActionVerb[] = [
  { action: "export", pattern: wordBoundary(ACTION_VERB_WORDS.export), readIntent: true },
  { action: "search", pattern: wordBoundary(ACTION_VERB_WORDS.search), readIntent: true },
  { action: "poll", pattern: wordBoundary(ACTION_VERB_WORDS.poll), readIntent: true },
  { action: "simulate", pattern: wordBoundary(ACTION_VERB_WORDS.simulate), readIntent: false },
  { action: "validate", pattern: wordBoundary(ACTION_VERB_WORDS.validate), readIntent: false },
  { action: "approve", pattern: wordBoundary(ACTION_VERB_WORDS.approve), readIntent: false },
  { action: "cancel", pattern: wordBoundary(ACTION_VERB_WORDS.cancel), readIntent: false },
  { action: "send", pattern: wordBoundary(ACTION_VERB_WORDS.send), readIntent: false },
  { action: "reserve", pattern: wordBoundary(ACTION_VERB_WORDS.reserve), readIntent: false },
  { action: "execute", pattern: wordBoundary(ACTION_VERB_WORDS.execute), readIntent: false },
];

/** The first vocabulary verb (in table order) whose pattern matches the signal. */
function matchActionVerb(signal: string, wantReadIntent?: boolean): ActionVerb | undefined {
  const s = snakeCase(signal);
  return ACTION_VERBS.find(
    (v) => (wantReadIntent === undefined || v.readIntent === wantReadIntent) && v.pattern.test(s),
  );
}

/** A verb-shaped path segment or naming signal, regardless of read/mutation family (naming.ts). */
export function actionVerbFor(signal: string): OperationAction | undefined {
  return matchActionVerb(signal)?.action;
}

/** Whether an already-normalized action belongs to the shared read-intent vocabulary. */
export function actionHasReadIntent(action: OperationAction): boolean {
  return ACTION_VERBS.some((verb) => verb.action === action && verb.readIntent);
}

/**
 * True when a POST's naming signal carries a SEARCH-family verb — the one
 * documented exception where the verb overrides the HTTP-method default
 * (Elasticsearch `_search`, Jira `POST /search/jql`: the query rides a POST
 * body because it is too large for a query string, with no persisted side
 * effect).
 *
 * Deliberately narrow (finding #25, external review): search-family on POST
 * ONLY. Poll-family verbs must never flip a write method — a write-method
 * "status"/"progress" endpoint SETS state (`PUT /tickets/{id}/status`), it
 * doesn't check it — and export-family stays a mutation too (a POST export
 * typically creates a job/artifact). PUT never flips: real PUT-search
 * endpoints are practically nonexistent, and a wrong flip here erases the
 * mutation confirmation posture entirely. A genuinely read-only write-method
 * endpoint outside this rule is what the manifest's `side_effect: read`
 * override is for — explicit, reviewable evidence instead of a verb guess.
 */
function hasDeclaredMutationIntent(declaredIntentSignals: readonly string[]): boolean {
  return declaredIntentSignals.some((signal) => DECLARED_MUTATION_PREFIX.test(snakeCase(signal)));
}

export function isReadIntentWriteMethod(
  method: HttpMethod,
  signal: string,
  declaredIntentSignals: readonly string[] = [signal],
): boolean {
  return (
    method === "post" &&
    matchActionVerb(signal, true)?.action === "search" &&
    !hasDeclaredMutationIntent(declaredIntentSignals)
  );
}

/**
 * Effect kind from the HTTP method, sharpened by the naming signal for the one
 * documented exception: a write-method endpoint with a `readIntent` verb is
 * still a read. This never loosens safety — it corrects a false positive that
 * would otherwise gate a pure read behind `review_required` and confirmation.
 */
export function classifyEffectKind(
  method: HttpMethod,
  signal = "",
  declaredIntentSignals: readonly string[] = [signal],
): EffectKind {
  if (READ_METHODS.includes(method)) return "read";
  if (isReadIntentWriteMethod(method, signal, declaredIntentSignals)) return "read";
  return "mutation";
}

/**
 * The descriptive action verb. It refines discovery/naming/metadata but NEVER
 * the safety core — `kind` still decides retry/confirmation. Read methods map
 * to read-family verbs; write methods map to mutation-family verbs, with
 * naming/path keywords sharpening the choice.
 */
export function classifyAction(
  method: HttpMethod,
  kind: EffectKind,
  endsWithParam: boolean,
  signal: string,
): OperationAction {
  const verb = matchActionVerb(signal, kind === "read");
  if (verb) return verb.action;
  if (kind === "read") return endsWithParam ? "get" : "list";
  switch (method) {
    case "post":
      return "create";
    case "put":
      return "replace";
    case "patch":
      return "update";
    case "delete":
      return "delete";
    default:
      return "other";
  }
}

/**
 * Infer *whose authority* a call runs under and where the credential is sourced
 * (spec §11). The decisive question for agent tools; refined by enrichment.
 */
export function classifyAuth(type: AuthType): {
  principal: AuthPrincipal;
  secretSource: SecretSource;
} {
  switch (type) {
    case "none":
      return { principal: "anonymous", secretSource: "none" };
    case "workload_identity":
      return { principal: "service", secretSource: "workload_identity" };
    case "oauth2_on_behalf_of":
      return { principal: "delegated", secretSource: "env" };
    case "oauth2_authorization_code":
      return { principal: "end_user", secretSource: "env" };
    default:
      return { principal: "service", secretSource: "env" };
  }
}

export function classifyEffect(
  method: HttpMethod,
  signal: string,
  endsWithParam = false,
  effectHint?: EffectKind,
  declaredIntentSignals: readonly string[] = [signal],
): { effect: Effect; idempotency: Idempotency } {
  // `effectHint` is an authoritative adapter assertion (`x-anvil-effect`): a
  // protocol adapter that lowers everything to its one truthful wire method
  // (SOAP/GraphQL/gRPC are all POST) states the effect explicitly instead of
  // smuggling it through a fake GET. When present it decides the kind
  // regardless of HTTP method; unhinted operations classify exactly as before.
  const kind = effectHint ?? classifyEffectKind(method, signal, declaredIntentSignals);
  const risk = classifyRisk(method, kind, signal);
  const reversible = !(risk === "financial" || risk === "destructive");
  // A write-method search endpoint reclassified to `read` above is inherently
  // repeatable — its idempotency posture follows the effect, not the raw verb.
  // The same holds for adapter-asserted POST-reads: retry/idempotency derive
  // from the effect kind, never from the raw wire method.
  const idempotency =
    kind === "read"
      ? { mode: "natural" as const, mechanism: "none" as const, keyDerivation: "none" as const }
      : classifyIdempotency(method);
  const action = classifyAction(method, kind, endsWithParam, signal);
  return { effect: { kind, action, resource: undefined, risk, reversible }, idempotency };
}

/** The descriptive basis behind a retry-safe posture, given how safety was proven. */
function retryBasisFor(effect: Effect, idempotency: Idempotency): RetryBasis {
  if (effect.kind === "read") return "read_safe";
  if (idempotency.mode === "natural") return "natural_idempotent";
  if (idempotency.mode === "required" || idempotency.mode === "key_supported") {
    return "idempotency_key";
  }
  if (idempotency.mode === "client_id") return "natural_idempotent";
  return "unproven";
}

/** Derive a retry policy consistent with the operation's idempotency (spec §11). */
export function classifyRetry(effect: Effect, idempotency: Idempotency): RetryPolicy {
  const basis = retryBasisFor(effect, idempotency);
  const proven = basis !== "unproven";
  if (!proven) {
    return {
      mode: "none",
      basis: "unproven",
      maxAttempts: 1,
      backoff: "none",
      baseDelayMs: 200,
      maxDelayMs: 20_000,
      retryOn: [],
    };
  }
  return {
    mode: "safe",
    basis,
    maxAttempts: 3,
    backoff: "exponential_jitter",
    baseDelayMs: 200,
    maxDelayMs: 20_000,
    retryOn: [...TRANSIENT_CONDITIONS],
  };
}

/** Require confirmation for irreversible, high-risk, or non-idempotent mutations. */
export function classifyConfirmation(effect: Effect, idempotency: Idempotency): Confirmation {
  if (effect.kind !== "mutation") return { required: false };
  const risky =
    effect.risk === "financial" ||
    effect.risk === "destructive" ||
    effect.risk === "high" ||
    effect.reversible === false ||
    idempotency.mode === "none";
  if (!risky) return { required: false };
  const reason = !effect.reversible
    ? `This operation is an irreversible ${effect.risk} mutation.`
    : `This operation is an unsafe ${effect.risk} mutation.`;
  return { required: true, risk: effect.risk, reason };
}

/**
 * Classify the interaction archetype — how an agent should interact with the operation.
 * Returns undefined for operations that match no rule (unclassified).
 *
 * Parameters and body fields can be passed to detect query-language passthrough:
 * operations with unconstrained query-language parameters get classified as
 * query_passthrough, which blocks them by default. This dominates search/transaction
 * but not long_running.
 *
 * `isWebhookReceiver` dominates every other rule, including `longRunning`. It is
 * never inferred from an operation's shape (a webhook payload can look exactly
 * like an ordinary read response) — it is set only when the operation was
 * compiled from the spec's own `webhooks:` map (`protocols/webhooks.ts`), which
 * makes it structurally certain rather than guessed. See
 * `packages/air/src/enums.ts`'s `InteractionArchetype` doc: a webhook receiver
 * is never a directly-callable MCP tool, so nothing gains from also checking it
 * against the other archetype rules below.
 */
export function classifyArchetype(
  effect: Effect,
  action: OperationAction,
  longRunning: boolean,
  params?: readonly Param[],
  body?: { projection: string; fields?: readonly BodyField[] },
  isWebhookReceiver?: boolean,
): InteractionArchetype | undefined {
  if (isWebhookReceiver) return "webhook_receiver";
  // Long-running operations dominate other classifications.
  if (longRunning) return "long_running";

  // Check for unconstrained query-language passthrough in params
  if (params) {
    for (const p of params) {
      if (isQueryPassthroughParam(p.name, p.schema, "param")) return "query_passthrough";
    }
  }

  // Check for unconstrained query-language passthrough in body fields
  if (body && body.projection === "fields" && body.fields) {
    for (const f of body.fields) {
      if (isQueryPassthroughParam(f.name, f.schema, "body")) return "query_passthrough";
    }
  }

  // Search-family reads (searches and list operations).
  if (effect.kind === "read" && (action === "search" || action === "list")) return "search";
  // All mutations are transactions.
  if (effect.kind === "mutation") return "transaction";
  // Everything else: unclassified (bulk and file_transfer are Phase 3+ features).
  return undefined;
}

/* --- pagination inference ------------------------------------------------- */

/**
 * Continuation-param names by style, most specific first. Cursor-style names
 * beat page-style when both are present (e.g. Twilio carries PageToken AND
 * Page — PageToken is the operative continuation). Measured against the real
 * corpus: starting_after (Stripe), cursor (Slack), PageToken (Twilio),
 * page/per_page (GitHub), startAt/maxResults (Jira).
 */
const CURSOR_PARAM_NAMES = new Set([
  "cursor",
  "starting_after",
  "page_token",
  "pagetoken",
  "next_token",
  "nexttoken",
  "after",
]);
const PAGE_PARAM_NAMES = new Set(["page"]);
const OFFSET_PARAM_NAMES = new Set(["offset", "startat"]);

/**
 * Page-*size* names, in two ranked tiers. The tiering is not cosmetic: a name
 * with "page" in it can only mean the size of one page, whereas a bare bound
 * like `limit` means "at most this many results" and in some dialects bounds
 * the whole result set rather than one page. When a spec carries both, the
 * page-scoped name is the one that is definitionally a page size, so it wins.
 *
 * Every name here had to survive one test: read alone, out of context, does it
 * plainly name *how many results come back*? That is a much higher bar than
 * "some real API uses it as a page size", and it is the right bar, because the
 * cost of a false positive is not a missing field — it is a serving surface
 * rewriting a domain parameter to hit a token budget, silently changing what
 * the caller asked for.
 */
const PAGE_SIZE_PARAM_NAMES = new Set([
  "per_page", // GitHub, Bitbucket-adjacent; "per page" admits no other reading
  "perpage",
  "page_size", // Google APIs (AIP-158), Notion; likewise unambiguous
  "pagesize",
  "pagelen", // Bitbucket
  "page_len",
]);
const RESULT_LIMIT_PARAM_NAMES = new Set([
  "limit", // Stripe, Slack, Twilio, Shopify — and see the `size` note below
  "max_results", // Jira maxResults, Google Calendar/YouTube maxResults
  "maxresults",
  "top", // OData $top; the `$` is stripped before lookup (also covers Socrata $limit)
]);

/**
 * Names deliberately NOT treated as page sizes, each with the corpus instance
 * that makes it tempting and the reason it still loses:
 *
 *  - `count` — reads as a *question* at least as often as a quantity. OData's
 *    `$count` is a boolean asking for a total (and would normalize to `count`
 *    under `$`-stripping, so it collides exactly), and plenty of specs use
 *    `count` as a filter. Rewriting it changes what is being asked, not how
 *    much of it comes back. X/Twitter v1.1 is the tempting instance.
 *  - `size` — the most collision-prone name in the candidate set: file size,
 *    image size, instance size, apparel size. Spring Data's `page`+`size` and
 *    Elasticsearch's `from`+`size` are real and common, which is precisely why
 *    getting it wrong is expensive. The distinction against `limit`: `limit` is
 *    a *bound* word, and a bound on a list query can only bound the list;
 *    `size` is a *magnitude* word that attaches to any noun in the domain.
 *  - `num` — Google Custom Search really does use it, but "num" names no noun
 *    at all, so there is nothing in the name to check the reading against.
 *  - `rows` — Solr's `rows` is a genuine page size, yet the word names the
 *    *things*, not how many of them; a `rows` param could as easily select rows
 *    or carry them.
 *  - `maxRecords` — the trap in this list. Airtable's `maxRecords` caps the
 *    TOTAL across the whole paged iteration; its page size is `pageSize`. A
 *    surface that wrote a token budget into `maxRecords` would silently
 *    truncate the result *set*, and page two would come back empty while
 *    looking complete — the exact failure class `maxPageSize` exists to expose.
 *
 * None of these are "wrong forever": they are unproven here, which is what the
 * `document-pagination` refinement skill is for. Evidence can promote them;
 * a name guess must not.
 */

/**
 * Declared types a page size cannot have, however size-ish the name reads —
 * a boolean `count`-style flag or a structured value wearing a size name.
 * `string` is tolerated on purpose: AIR defaults an untyped param to
 * `type: string` and many specs type every query param as a string, so
 * rejecting it would drop honest page sizes to catch nothing.
 */
const NON_SIZE_SCHEMA_TYPES = new Set(["boolean", "array", "object", "null"]);
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
 * Rank a parameter as a page-size control, lower being more specific, or
 * `undefined` when the name is not one we will act on.
 *
 * The leading `$` is stripped because two dialects put their paging knobs in a
 * reserved namespace — OData (`$top`) and Socrata (`$limit`) — and the sigil is
 * syntax, not meaning. Stripping is confined to this lookup rather than shared
 * with the continuation-param lookup above, so the change cannot move an
 * existing style classification.
 */
function pageSizeRank(param: Param): number | undefined {
  const declaredType = param.schema?.type;
  if (typeof declaredType === "string" && NON_SIZE_SCHEMA_TYPES.has(declaredType)) return undefined;
  const n = param.name.toLowerCase().replace(/^\$/, "");
  if (PAGE_SIZE_PARAM_NAMES.has(n)) return 0;
  if (RESULT_LIMIT_PARAM_NAMES.has(n)) return 1;
  return undefined;
}

/**
 * Read the upstream's own stated bounds off the size parameter's schema. These
 * are facts the contract declares, not inferences from it — which is the whole
 * reason they are safe to record here rather than defer to refinement.
 *
 * `maximum` matters more than it looks: exceeding a page-size cap is *silent*.
 * An agent that asks for 500 and gets 100 cannot distinguish a full page from a
 * capped one and will report a partial read as complete — a confidently wrong
 * answer, which is worse than an error. Recording the cap lets a serving
 * surface clamp before it asks, and lets certification reason about the page it
 * will actually get.
 */
function pageSizeBounds(schema: Record<string, unknown> | undefined): {
  maxPageSize?: number;
  defaultPageSize?: number;
} {
  const positiveInt = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;

  // `exclusiveMaximum` is a boolean modifier on `maximum` in draft-04 and a
  // number in its own right from draft-06 on. The two readings differ by one,
  // and the wrong one reintroduces exactly the silent-cap error this field
  // exists to prevent — so when it is present in any form we decline to state a
  // cap at all rather than state one that may be off by one.
  const max = "exclusiveMaximum" in (schema ?? {}) ? undefined : positiveInt(schema?.maximum);
  let dflt = positiveInt(schema?.default);

  // A default above the stated cap is a self-contradictory contract. Keep the
  // cap (it is the safety-relevant half) and drop the default, because
  // `safePageSize` treats `defaultPageSize` as the upstream's own honest
  // answer, and feeding it a value the upstream will silently clamp would
  // manufacture the capped-page failure from inside Anvil.
  if (max !== undefined && dflt !== undefined && dflt > max) dflt = undefined;

  return {
    ...(max !== undefined ? { maxPageSize: max } : {}),
    ...(dflt !== undefined ? { defaultPageSize: dflt } : {}),
  };
}

/**
 * Infer pagination for a search-archetype read from unambiguous parameter
 * names, so generated surfaces can teach paging (and the MCP truncation
 * marker can name the cursor param) without waiting for enrichment. Inference
 * is deliberately conservative — a name that plainly IS a continuation param,
 * nothing fuzzier; anything ambiguous stays unset for the document-pagination
 * refinement skill to prove from evidence. Emits only fields it can ground:
 * itemsField only when the response object has exactly one array property,
 * nextField only when exactly one next-marker property matches.
 *
 * `pageSizeParam` is grounded the same way and matters for a different reason
 * than the rest. `cursorParam` only controls *continuation* — with it alone the
 * sole way to hold a response inside a context budget is to fetch everything
 * and cut it afterwards, paying the upstream cost regardless and handing the
 * agent a truncated payload. A size param is the one knob that lets a surface
 * ask for less. Detected only alongside a continuation param, so an operation
 * that merely happens to carry a `limit` is never reinterpreted as paginated.
 */
export function classifyPagination(
  effect: Effect,
  action: OperationAction,
  params: readonly Param[],
  outputSchema: Record<string, unknown> | undefined,
):
  | {
      style: "cursor" | "page" | "offset";
      cursorParam: string;
      nextField?: string;
      itemsField?: string;
      pageSizeParam?: string;
      maxPageSize?: number;
      defaultPageSize?: number;
    }
  | undefined {
  if (effect.kind !== "read" || (action !== "search" && action !== "list")) return undefined;

  const styleOf = (name: string): "cursor" | "page" | "offset" | undefined => {
    const n = name.toLowerCase();
    if (CURSOR_PARAM_NAMES.has(n)) return "cursor";
    if (PAGE_PARAM_NAMES.has(n)) return "page";
    if (OFFSET_PARAM_NAMES.has(n)) return "offset";
    return undefined;
  };

  let match: { style: "cursor" | "page" | "offset"; cursorParam: string } | undefined;
  for (const p of params) {
    const style = styleOf(p.name);
    if (!style) continue;
    // Cursor-style names win over page/offset when a spec carries both.
    if (!match || (style === "cursor" && match.style !== "cursor")) {
      match = { style, cursorParam: p.name };
    }
  }
  if (!match) return undefined;

  // Take a size param only when exactly one candidate holds the most specific
  // rank. Two equally-plausible size names on one operation is a real ambiguity
  // (one may bound the page and the other the whole set), and picking either is
  // a coin flip a serving surface would then act on — so we stay silent, the
  // same rule the itemsField/nextField "exactly one" tests apply below.
  let best: { param: Param; rank: number } | undefined;
  let tied = false;
  for (const p of params) {
    const rank = pageSizeRank(p);
    if (rank === undefined) continue;
    if (!best || rank < best.rank) {
      best = { param: p, rank };
      tied = false;
    } else if (rank === best.rank) {
      tied = true;
    }
  }
  const size =
    best && !tied
      ? { pageSizeParam: best.param.name, ...pageSizeBounds(best.param.schema) }
      : undefined;

  let nextField: string | undefined;
  let itemsField: string | undefined;
  const props = outputSchema?.properties as Record<string, Record<string, unknown>> | undefined;
  if (props) {
    const arrays = Object.entries(props).filter(([, v]) => v?.type === "array");
    if (arrays.length === 1) itemsField = arrays[0]?.[0];
    const nexts = Object.keys(props).filter((k) => NEXT_FIELD_NAMES.has(k.toLowerCase()));
    if (nexts.length === 1) nextField = nexts[0];
  }

  return {
    ...match,
    ...(nextField ? { nextField } : {}),
    ...(itemsField ? { itemsField } : {}),
    ...(size ?? {}),
  };
}

/* --- long-running (asynchronous) inference --------------------------------- */

/**
 * What an operation's OWN declared responses say about finishing after it
 * returns. Passed in rather than read from AIR because AIR keeps no response
 * headers and folds 200/201/202 into one `output` — the two facts that carry
 * nearly all of the declared evidence for asynchrony. Everything here is a
 * quotation from the document, never an inference over it; the inference is
 * `classifyLongRunning`'s job and stays in one place.
 */
export interface AsyncResponseSignals {
  /**
   * Declared response header names, snake_cased, keyed by the status code as
   * the document wrote it: `{ "202": ["location", "retry_after"] }`. Per-status
   * rather than flattened because the same header means opposite things on
   * different codes — see the `Location` note in `classifyLongRunning`.
   */
  headersByStatus: Readonly<Record<string, readonly string[]>>;
  /** Every declared response status code, as written ("202", "default", …). */
  statusCodes: readonly string[];
  /**
   * A positive integer `default` declared for a `Retry-After` response header on
   * the 202. The server stating how long to wait — not a value we computed.
   */
  retryAfterDefaultSeconds?: number;
}

/** Declared evidence that an operation returns before its work is finished. */
export interface LongRunningDetection {
  /** The declared facts that fired, in a fixed order, for the evidence claim. */
  signals: string[];
  /** Carried into the contract only when the document stated it. */
  pollIntervalSeconds?: number;
}

/** 2xx keys in a `responses` map. `default` and ranges (`2XX`) are not 2xx facts. */
const isSuccessStatus = (code: string): boolean => /^2\d\d$/.test(code);

/**
 * Decide whether an operation hands back before the work is done.
 *
 * The bar is the same one `classifyPagination` sets: a signal must *definitionally*
 * mean the thing, not merely co-occur with it. A false positive here is not a
 * missing field — it tells an agent to poll a call that already returned its
 * answer, so it either loops against a status route that does not exist or, worse,
 * reports "still running" for work that finished. Anything short of a declared
 * fact stays unset for the refinement layer to prove from live evidence.
 *
 * ACCEPTED, each with why the name can only be read one way:
 *
 *  - **A declared `202`.** RFC 9110 defines 202 as "the request has been accepted
 *    for processing, but the processing has not been completed" — that sentence
 *    *is* the definition of `longRunning`. It is declared by the document, not
 *    read off a name. The residual risk is a spec that pastes a shared response
 *    table onto every route; the mutation gate below is what keeps that from
 *    spreading across an estate.
 *  - **An `Operation-Location` response header** on any 2xx. Azure's async
 *    convention, and a header invented for exactly one purpose: it carries the
 *    URL of the *operation's* status monitor. There is no synchronous reading of
 *    it, so it stands alone even without a 202 (some Azure routes answer 200).
 *  - **A `Location` header ON THE 202.** RFC 9110 gives `Location` two different
 *    meanings by status: on a 201 it is the created resource (a *synchronous*
 *    create — the single largest false-positive source in this whole area), and
 *    on a 202 it "refers to a status monitor". So it counts only where the
 *    document put it, which is why `headersByStatus` is keyed by code.
 *
 * REJECTED, each with the tempting real-world instance and why it still loses:
 *
 *  - **Name-shaped signals** — `async`, `job`, `batch`, `import`, `submit`,
 *    `*Async` operationIds. The strongest of them (`async`) still names a
 *    *client* calling convention as often as a server one, `exportUsers` is
 *    routinely a synchronous download, and `createBatch` routinely returns the
 *    batch inline. A name asserts nothing about when the work finishes, and
 *    unlike a status code nothing in the document contradicts a wrong guess.
 *  - **`Retry-After` on its own.** Overwhelmingly a 429/503 backoff header; on
 *    those codes it means "your request did not happen", the opposite of "your
 *    request is running". It is read only for its *value*, and only off a 202.
 *  - **A `status`/`state`/`id` field in the response body.** Nearly every create
 *    returns an id, and plenty of domain objects carry their own `status`
 *    (`order.status`), which has nothing to do with a background job. These are
 *    used to *locate* the job handle once asynchrony is already established —
 *    never to establish it.
 *  - **The mere existence of a sibling status route.** `POST /jobs` +
 *    `GET /jobs/{id}` is also the shape of an ordinary synchronous create plus
 *    an ordinary item read. The pairing tells us where to poll *if* the call is
 *    async; it cannot tell us that it is.
 *  - **`204 No Content` / an empty 200.** A body-less success says the response
 *    carries nothing, not that the work is unfinished — fire-and-forget and
 *    completed-with-nothing-to-say are indistinguishable here.
 *
 * Gated on `effect.kind === "mutation"` on purpose. A read that returns 202 is
 * reporting on *someone else's* job — an Azure status route answers 202 while
 * the work runs — so marking it long-running would tell an agent to poll the
 * poller, and would flip its archetype to `long_running` away from the search
 * or read semantics its callers depend on. The gate is stated in terms of the
 * classified effect rather than the HTTP method so a POST search reclassified to
 * a read (or an adapter-asserted read) is excluded by the same rule.
 */
export function classifyLongRunning(
  effect: Effect,
  signals: AsyncResponseSignals,
): LongRunningDetection | undefined {
  if (effect.kind !== "mutation") return undefined;

  const accepted = signals.headersByStatus["202"] ?? [];
  // A 202 counts whether the document listed it in `responses` or only ever
  // attached headers to it; both are the document saying the code exists.
  const declares202 = signals.statusCodes.includes("202") || "202" in signals.headersByStatus;

  const evidence: string[] = [];
  if (declares202) evidence.push("declares a 202 Accepted response");
  const operationLocation = Object.entries(signals.headersByStatus).some(
    ([code, headers]) => isSuccessStatus(code) && headers.includes("operation_location"),
  );
  if (operationLocation) evidence.push("declares an Operation-Location response header");
  if (declares202 && accepted.includes("location")) {
    evidence.push("declares a Location header on its 202 (a status monitor, per RFC 9110)");
  }
  if (evidence.length === 0) return undefined;

  // An operation that declares 200/201 *and* 202 may answer either way. It is
  // still reported as long-running: an agent prepared to poll handles the
  // synchronous answer fine (it simply has nothing to poll for), while an agent
  // that assumed synchrony is stranded the first time a 202 comes back. Same
  // asymmetry the rest of the classifier runs on — the unsafe assumption loses.
  return {
    signals: evidence,
    ...(declares202 && signals.retryAfterDefaultSeconds !== undefined
      ? { pollIntervalSeconds: signals.retryAfterDefaultSeconds }
      : {}),
  };
}

/**
 * Nouns that name a unit of *background work*. A handle field or wrapper object
 * built from one of these is a job handle by construction, which is what lets
 * `<noun>_id` be trusted where a bare `id` cannot be.
 *
 * `request`, `correlation` and `trace` are deliberately absent: `request_id` /
 * `correlation_id` / `trace_id` are support and observability identifiers,
 * present on synchronous responses too, and pointing an agent at one to poll
 * with would send it round a loop with a value the status route never knew.
 * `result` is absent for the mirror reason — a `result_id` names the artifact
 * the work produces, which may not exist until the work is over.
 */
const JOB_NOUNS = [
  "job",
  "task",
  "operation",
  "batch",
  "execution",
  "run",
  "import",
  "export",
  "transfer",
  "process",
  "workflow",
] as const;
const JOB_NOUN_SET: ReadonlySet<string> = new Set(JOB_NOUNS);
const JOB_HANDLE_NAMES: ReadonlySet<string> = new Set(JOB_NOUNS.map((noun) => `${noun}_id`));

/**
 * Job states that mean the work has STOPPED — success and failure alike, since
 * either ends the poll. Every word had to pass the same test as the page-size
 * names: read alone, out of context, does it plainly mean the job is over?
 */
const TERMINAL_STATE_WORDS: ReadonlySet<string> = new Set([
  "succeeded",
  "success",
  "successful",
  "completed",
  "complete",
  "done",
  "finished",
  "failed",
  "failure",
  "error",
  "errored",
  "cancelled",
  "canceled",
  "aborted",
  "terminated",
  "expired",
  "timed_out",
  "rejected",
]);

/** States that plainly mean "still working". Advisory only (see `AsyncContract`). */
const PENDING_STATE_WORDS: ReadonlySet<string> = new Set([
  "pending",
  "queued",
  "waiting",
  "scheduled",
  "accepted",
  "submitted",
  "created",
  "not_started",
  "notstarted",
  "starting",
  "started",
  "running",
  "in_progress",
  "inprogress",
  "processing",
  "working",
  "active",
  "retrying",
]);

/**
 * Property names that carry a job's current state: `status`/`state` themselves,
 * or a qualified form of one (`processing_status`, `job_state`, `upload_status`).
 *
 * The qualified form is not a loosening in practice, because two further gates
 * stand behind it: only ONE such property may exist on the response (two is an
 * ambiguity, and ambiguity yields no contract), and its declared enum must carry
 * a value from the terminal vocabulary. An `order.payment_status` would have to
 * be the sole state-shaped field on an operation already established as a poll
 * target AND declare job-completion states before it could mislead anyone.
 * GitHub's SARIF upload status — `processing_status: [pending, complete, failed]`
 * — is the corpus case that showed the bare-name-only rule leaving real, fully
 * declared contracts on the floor.
 */
function isStateFieldName(name: string): boolean {
  const n = snakeCase(name);
  return n === "status" || n === "state" || n.endsWith("_status") || n.endsWith("_state");
}

const propertiesOf = (schema: JsonSchema | undefined): Record<string, JsonSchema> | undefined => {
  const props = schema?.properties;
  if (!props || typeof props !== "object" || Array.isArray(props)) return undefined;
  return props as Record<string, JsonSchema>;
};

/** The last segment of a dotted path — the part a parameter name is matched against. */
const leafOf = (path: string): string => snakeCase(path.slice(path.lastIndexOf(".") + 1));

/**
 * Find the response field carrying the job handle, as a dotted path.
 *
 * Ranked, most-specific-first, and silent on ambiguity — the same posture the
 * page-size tiers take. Two candidates of equal specificity is a genuine
 * ambiguity (which id does the status route want?), and picking either is a coin
 * flip an agent would then act on, so we pick neither and emit no contract.
 *
 * Tier 1 is a `<job noun>_id`: the noun makes it a background-work identifier by
 * construction. Tier 1b is the same fact spelled as a wrapper — `{ job: { id } }`
 * — where the *parent* carries the noun. Tier 2 is a bare `id`, admissible only
 * because this function is unreachable unless a declared 202 or Operation-Location
 * has already established that the call is asynchronous; under that gate the id
 * a 202 hands back is the handle for the accepted work.
 *
 * Google's LRO shape (`{ name, done, metadata }`) is deliberately NOT detected:
 * its handle is a bare `name`, which on an ordinary create is the resource's
 * display name, and its state is a boolean `done` that declares no terminal
 * state *string* — so no contract could resolve even if the handle were found.
 * Refinement, which can read a real response, is the right layer for it.
 *
 * Exported so `normalize.ts` can reuse the exact same tiered heuristic against
 * a `webhooks:` operation's *input* schema when deriving a candidate
 * `webhookJobIdField` for a `callbacks:`-linked contract — "derived the same
 * way `jobIdField` is derived elsewhere" is the literal design requirement,
 * not a parallel, possibly-drifting reimplementation.
 */
export function findJobHandleField(schema: JsonSchema | undefined): string | undefined {
  const props = propertiesOf(schema);
  if (!props) return undefined;
  const names = Object.keys(props);

  const explicit = names.filter((name) => JOB_HANDLE_NAMES.has(snakeCase(name)));
  if (explicit.length > 0) return explicit.length === 1 ? explicit[0] : undefined;

  const wrapped: string[] = [];
  for (const name of names) {
    if (!JOB_NOUN_SET.has(snakeCase(name))) continue;
    const inner = propertiesOf(props[name]);
    if (!inner) continue;
    const innerKey = Object.keys(inner).find(
      (key) => snakeCase(key) === "id" || JOB_HANDLE_NAMES.has(snakeCase(key)),
    );
    if (innerKey) wrapped.push(`${name}.${innerKey}`);
  }
  if (wrapped.length > 0) return wrapped.length === 1 ? wrapped[0] : undefined;

  const bare = names.filter((name) => snakeCase(name) === "id");
  return bare.length === 1 ? bare[0] : undefined;
}

/**
 * Whether a status operation's parameter accepts the handle we found.
 *
 * Exact (case- and separator-insensitive) match first: `job_id` accepts a
 * `jobId` path param. The one relaxation is the resource-shortening every REST
 * dialect does — `POST /jobs` returns `{ job_id }` and the status route spells
 * the same value `{id}` because the route already says "jobs". It is allowed
 * only when the dropped token IS the status route's own resource, so `id` on
 * `/jobs/{id}` accepts a `job_id` while `id` on `/users/{id}` never does.
 */
function paramAcceptsHandle(param: Param, handleLeaf: string, statusOp: Operation): boolean {
  const name = snakeCase(param.name);
  if (name === handleLeaf) return true;
  const resource = snakeCase(statusOp.effect.resource ?? "");
  if (!resource) return false;
  if (name === "id" && handleLeaf === `${resource}_id`) return true;
  if (handleLeaf === "id" && name === `${resource}_id`) return true;
  return false;
}

/** `/jobs` → `/jobs/{jobId}`: the status path is the submit path plus one template segment. */
function isItemReadOf(submitPath: string, statusPath: string): boolean {
  const submit = submitPath.split("/").filter(Boolean);
  const status = statusPath.split("/").filter(Boolean);
  if (status.length !== submit.length + 1) return false;
  if (!(status[status.length - 1] ?? "").startsWith("{")) return false;
  return submit.every((segment, i) => segment === status[i]);
}

/**
 * The status field on the poll response, plus the states it declares.
 *
 * Terminal states are taken ONLY from an enum the document declares. There is no
 * fallback vocabulary, by design: a guessed `"succeeded"` that the service spells
 * `"COMPLETE"` makes an agent poll forever, and a guessed `"failed"` that is
 * really an intermediate makes it stop early and report a half-finished job as
 * done — the confidently-wrong failure this codebase treats as worse than an
 * error. No enum therefore means no contract, and refinement proves the states
 * from a real response later.
 *
 * A declared value in neither vocabulary is listed as NEITHER terminal nor
 * pending. That is the deliberate direction to fail in: an unlisted state that
 * was really terminal leaves the agent polling, which fails loudly and visibly,
 * whereas calling it terminal would stop the poll early and hand back a partial
 * result dressed as a complete one. One recognized terminal state is still a
 * usable stopping condition, so an odd extra value does not sink the contract.
 *
 * Exported for the same reason `findJobHandleField` is: `normalize.ts` reuses
 * it against a `webhooks:` operation's input schema for a candidate
 * `webhookStateField`.
 */
export function findStateField(
  schema: JsonSchema | undefined,
): { path: string; terminal: string[]; pending: string[] } | undefined {
  const props = propertiesOf(schema);
  if (!props) return undefined;

  const candidates: Array<{ path: string; schema: JsonSchema }> = [];
  for (const [name, propSchema] of Object.entries(props)) {
    if (isStateFieldName(name)) candidates.push({ path: name, schema: propSchema });
  }
  // Only descend when the top level offers nothing, so `{ status, job: { status } }`
  // resolves to the outer one rather than becoming an artificial ambiguity.
  if (candidates.length === 0) {
    for (const [name, propSchema] of Object.entries(props)) {
      if (!JOB_NOUN_SET.has(snakeCase(name))) continue;
      const inner = propertiesOf(propSchema);
      if (!inner) continue;
      for (const [innerName, innerSchema] of Object.entries(inner)) {
        if (isStateFieldName(innerName)) {
          candidates.push({ path: `${name}.${innerName}`, schema: innerSchema });
        }
      }
    }
  }
  // Two state fields on one response is an ambiguity, not a choice to make.
  if (candidates.length !== 1) return undefined;
  const found = candidates[0] as { path: string; schema: JsonSchema };

  const declared = found.schema.enum;
  if (!Array.isArray(declared)) return undefined;
  const values = declared.filter((value): value is string => typeof value === "string");
  if (values.length === 0) return undefined;

  // Declaration order is preserved so the same document always yields the same
  // arrays (and the same content hash downstream).
  const terminal = values.filter((value) => TERMINAL_STATE_WORDS.has(snakeCase(value)));
  const pending = values.filter((value) => PENDING_STATE_WORDS.has(snakeCase(value)));
  if (terminal.length === 0) return undefined;
  return { path: found.path, terminal, pending };
}

/**
 * Build the contract an agent follows to finish a long-running call — or nothing.
 *
 * Every coordinate has to be grounded in the document before any of it is
 * emitted: the handle field in this operation's response, a real read operation
 * to poll, a parameter on it that accepts the handle, and at least one declared
 * terminal state. Missing any one of them means the agent could not follow the
 * contract anyway, and a contract it cannot follow is strictly worse than none
 * (see the header of `@anvil/air`'s `async-contract.ts`) — so this returns
 * `undefined` rather than a partial answer, and never invents a coordinate.
 *
 * Pure and order-independent: it reads only declared structure, resolves ties by
 * refusing rather than by position, and preserves declaration order in the state
 * lists. The same document always produces the same contract.
 */
export function classifyAsyncContract(
  operation: Operation,
  operations: readonly Operation[],
  pollIntervalSeconds?: number,
): AsyncContract | undefined {
  const jobIdField = findJobHandleField(operation.output.schema);
  if (!jobIdField) return undefined;
  const handleLeaf = leafOf(jobIdField);

  // Score the poll candidates rather than take the first plausible one: the
  // relations below are independent kinds of evidence, and an operation that
  // satisfies several is more surely the status route than one that squeaks past
  // a single test. A tie means the document does not distinguish them, which is
  // the case where guessing hurts most — so a tie yields no contract.
  let best: { op: Operation; param: Param; score: number } | undefined;
  let tied = false;
  // Optional in AIR because non-REST sources have no path; a missing path simply
  // withholds the item-read evidence rather than disqualifying the candidate.
  const submitPath = operation.sourceRef.path;
  for (const candidate of operations) {
    // A call cannot poll itself, and the poll target must be a read — polling
    // repeats by definition, so anything with an effect would apply it over and
    // over. `resolveAsyncContract` refuses this too; refusing here as well means
    // the compiler never writes a contract it knows is unusable.
    if (candidate.id === operation.id) continue;
    if (candidate.effect.kind !== "read") continue;
    const param = candidate.input.params.find((p) => paramAcceptsHandle(p, handleLeaf, candidate));
    if (!param) continue;

    let score = 0;
    // The submitted collection's item read — `POST /jobs` → `GET /jobs/{jobId}`.
    const statusPath = candidate.sourceRef.path;
    if (
      submitPath !== undefined &&
      statusPath !== undefined &&
      isItemReadOf(submitPath, statusPath)
    ) {
      score += 2;
    }
    // A poll-family verb in its name/path (`status`, `progress`, `poll`, `wait`),
    // via the one shared action vocabulary so this can never drift from naming.
    if (candidate.effect.action === "poll") score += 2;
    // Same resource family: a job's status route lives with the job, not across
    // the estate. Weakest of the three, so it never carries a match alone.
    if (
      operation.effect.resource !== undefined &&
      candidate.effect.resource === operation.effect.resource
    ) {
      score += 1;
    }
    if (score === 0) continue;

    if (!best || score > best.score) {
      best = { op: candidate, param, score };
      tied = false;
    } else if (score === best.score) {
      tied = true;
    }
  }
  if (!best || tied) return undefined;

  const state = findStateField(best.op.output.schema);
  if (!state) return undefined;

  return {
    statusOperationId: best.op.id,
    jobIdField,
    statusJobIdParam: best.param.name,
    stateField: state.path,
    terminalStates: state.terminal,
    pendingStates: state.pending,
    ...(pollIntervalSeconds !== undefined ? { pollIntervalSeconds } : {}),
  };
}
