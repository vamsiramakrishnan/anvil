import {
  type AuthPrincipal,
  type AuthType,
  type Confirmation,
  type Effect,
  type EffectKind,
  type HttpMethod,
  type Idempotency,
  type OperationAction,
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
export function isReadIntentWriteMethod(method: HttpMethod, signal: string): boolean {
  return method === "post" && matchActionVerb(signal, true)?.action === "search";
}

/**
 * Effect kind from the HTTP method, sharpened by the naming signal for the one
 * documented exception: a write-method endpoint with a `readIntent` verb is
 * still a read. This never loosens safety — it corrects a false positive that
 * would otherwise gate a pure read behind `review_required` and confirmation.
 */
export function classifyEffectKind(method: HttpMethod, signal = ""): EffectKind {
  if (READ_METHODS.includes(method)) return "read";
  if (isReadIntentWriteMethod(method, signal)) return "read";
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
): { effect: Effect; idempotency: Idempotency } {
  // `effectHint` is an authoritative adapter assertion (`x-anvil-effect`): a
  // protocol adapter that lowers everything to its one truthful wire method
  // (SOAP/GraphQL/gRPC are all POST) states the effect explicitly instead of
  // smuggling it through a fake GET. When present it decides the kind
  // regardless of HTTP method; unhinted operations classify exactly as before.
  const kind = effectHint ?? classifyEffectKind(method, signal);
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
