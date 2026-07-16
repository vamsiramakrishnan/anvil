/**
 * Overlay construction and the manifest→overlay migration bridge.
 *
 * The supplemental Anvil manifest is no longer an independent override channel:
 * `manifestToOverlay` re-expresses it as a `PolicyOverlay` (origin `manifest`),
 * and `projectOperationManifest` turns resolved assertions back into an
 * `OperationManifest` that is applied through the one shared application path
 * (`applyOperationManifest`). Manifest and gateway/investigation overlays thus
 * share both resolution and application — there is no second mechanism.
 */
import type { IdempotencyMode } from "@anvil/air";
import type { AnvilManifest, OperationManifest } from "../manifest.js";
import { overlayDigest } from "./digest.js";
import type {
  OverlayOrigin,
  PolicyOverlay,
  SemanticOverlayAssertion,
  SemanticPredicate,
} from "./model.js";

/**
 * Authority of an origin when two `set` assertions disagree. Operator config and
 * the manifest are deliberate human intent; a gateway is a control-plane fact;
 * investigation and observed traffic are evidence-weighted and rank lowest, so
 * they can tighten freely but only loosen with strong evidence.
 */
export const ORIGIN_AUTHORITY: Record<OverlayOrigin, number> = {
  operator: 100,
  manifest: 90,
  gateway: 80,
  investigation: 50,
  observed_traffic: 40,
};

/**
 * How much a source can *prove* about a predicate — not a total ordering of
 * source names (see review finding #2). Authority is predicate-specific: a
 * gateway is authoritative for the scopes it enforces and the route it exposes,
 * but it cannot prove backend idempotency, business reversibility, or that a
 * confirmation is semantically unnecessary. Only an `authoritative` source may
 * *loosen* a safety-sensitive predicate.
 */
export type SafetyAuthority = "authoritative" | "corroborating" | "insufficient";

export function authorityFor(origin: OverlayOrigin, predicate: SemanticPredicate): SafetyAuthority {
  // Operator and manifest are deliberate human configuration — authoritative for
  // any predicate (an operator may knowingly override any control).
  if (origin === "operator" || origin === "manifest") return "authoritative";

  if (origin === "gateway") {
    switch (predicate) {
      // Control-plane facts the gateway actually enforces.
      case "auth.scopes":
        return "authoritative";
      // The gateway observes requests but cannot prove backend duplicate-safety.
      case "idempotency.mode":
        return "corroborating";
      // Backend/business semantics a gateway cannot prove.
      default:
        return "insufficient";
    }
  }

  // investigation / observed_traffic: an observation, not a proof of safety.
  // Loosening a safety control from these requires verified evidence, which the
  // overlay evidence model does not yet carry — so they are insufficient here.
  return "insufficient";
}

/** True when at least one contributing origin can authoritatively loosen `predicate`. */
export function canLoosen(
  origins: readonly OverlayOrigin[],
  predicate: SemanticPredicate,
): boolean {
  return origins.some((o) => authorityFor(o, predicate) === "authoritative");
}

/**
 * Predicates where a contradiction must not be silently decided. Mirrors AIR's
 * `SAFETY_SENSITIVE_PREDICATES`, plus `auth.scopes` (dropping a required scope is
 * a loosening) and `effect.reversible`.
 */
export const CONTRACT_SAFETY_PREDICATES: ReadonlySet<SemanticPredicate> =
  new Set<SemanticPredicate>([
    "effect.kind",
    "effect.reversible",
    "idempotency.mode",
    "confirmation.required",
    "confirmation.human_approval",
    "retries.mode",
    "auth.principal",
    "auth.scopes",
  ]);

type ManifestStrategy = NonNullable<NonNullable<OperationManifest["idempotency"]>["strategy"]>;

/** The manifest's `STRATEGY_TO_MODE` (manifest strategy → AIR mode). */
const STRATEGY_TO_MODE: Record<ManifestStrategy, IdempotencyMode> = {
  natural: "natural",
  required_request_key: "required",
  key_supported: "key_supported",
  client_id: "client_id",
  none: "none",
};

/** Reverse of `STRATEGY_TO_MODE` (AIR mode → manifest strategy). */
const MODE_TO_STRATEGY: Record<IdempotencyMode, ManifestStrategy> = {
  natural: "natural",
  required: "required_request_key",
  key_supported: "key_supported",
  client_id: "client_id",
  none: "none",
};

/** Stamp an overlay with its content digest, deriving an id when none is given. */
export function makeOverlay(input: {
  origin: OverlayOrigin;
  assertions: SemanticOverlayAssertion[];
  evidence?: PolicyOverlay["evidence"];
  id?: string;
}): PolicyOverlay {
  const evidence = input.evidence ?? [];
  const digest = overlayDigest({ origin: input.origin, assertions: input.assertions, evidence });
  return {
    schemaVersion: 1,
    id: input.id ?? `overlay_${input.origin}_${digest.slice(0, 12)}`,
    origin: input.origin,
    assertions: input.assertions,
    evidence,
    digest,
  };
}

function set(ref: string, predicate: SemanticPredicate, value: unknown): SemanticOverlayAssertion {
  return {
    target: { scope: "operation", ref },
    predicate,
    operation: "set",
    value,
    evidenceRefs: [],
  };
}

/**
 * Represent an Anvil manifest as a policy overlay. Every operation entry becomes
 * a set of authoritative `set` assertions; the mapping is the exact inverse of
 * `projectOperationManifest`, so a round trip through the resolver reproduces the
 * manifest's effect. Only fields the manifest actually sets emit assertions
 * (mirroring `enrich`'s gates — e.g. idempotency only when a strategy is given).
 */
export function manifestToOverlay(manifest: AnvilManifest): PolicyOverlay {
  const assertions: SemanticOverlayAssertion[] = [];
  for (const [ref, m] of Object.entries(manifest.operations)) {
    if (m.side_effect) assertions.push(set(ref, "effect.kind", m.side_effect));
    if (m.risk) assertions.push(set(ref, "effect.risk", m.risk));
    if (m.reversible !== undefined) assertions.push(set(ref, "effect.reversible", m.reversible));
    if (m.action) assertions.push(set(ref, "effect.action", m.action));
    if (m.display_name) assertions.push(set(ref, "displayName", m.display_name));
    if (m.description) assertions.push(set(ref, "description", m.description));
    if (m.name?.resource) assertions.push(set(ref, "name.resource", m.name.resource));
    if (m.name?.verb) assertions.push(set(ref, "name.verb", m.name.verb));

    if (m.auth?.principal) assertions.push(set(ref, "auth.principal", m.auth.principal));
    if (m.auth?.audience) assertions.push(set(ref, "auth.audience", m.auth.audience));
    if (m.auth?.secret_source) assertions.push(set(ref, "auth.secretSource", m.auth.secret_source));
    if (m.auth?.tenant) assertions.push(set(ref, "auth.tenant", m.auth.tenant));
    if (m.auth?.actor) assertions.push(set(ref, "auth.actor", m.auth.actor));
    if (m.auth?.subject) assertions.push(set(ref, "auth.subject", m.auth.subject));

    if (m.idempotency?.strategy) {
      assertions.push(set(ref, "idempotency.mode", STRATEGY_TO_MODE[m.idempotency.strategy]));
      if (m.idempotency.key_location) {
        assertions.push(set(ref, "idempotency.mechanism", m.idempotency.key_location));
      }
      if (m.idempotency.header) assertions.push(set(ref, "idempotency.key", m.idempotency.header));
    }

    if (m.confirmation?.required !== undefined) {
      assertions.push(set(ref, "confirmation.required", m.confirmation.required));
    }
    if (m.confirmation?.risk) assertions.push(set(ref, "confirmation.risk", m.confirmation.risk));
    if (m.confirmation?.reason) {
      assertions.push(set(ref, "confirmation.reason", m.confirmation.reason));
    }
    if (m.confirmation?.human_approval !== undefined) {
      assertions.push(set(ref, "confirmation.human_approval", m.confirmation.human_approval));
    }

    if (m.retries) {
      if (m.retries.enabled !== undefined) {
        assertions.push(set(ref, "retries.mode", m.retries.enabled ? "safe" : "none"));
      }
      if (m.retries.only_on) assertions.push(set(ref, "retries.retryOn", m.retries.only_on));
      if (m.retries.max_attempts !== undefined) {
        assertions.push(set(ref, "retries.maxAttempts", m.retries.max_attempts));
      }
    }

    if (m.state) assertions.push(set(ref, "state", m.state));
  }
  return makeOverlay({ origin: "manifest", assertions });
}

/**
 * Project a resolved set of per-predicate values for one operation back into an
 * `OperationManifest`, so it can be applied through the one manifest-application
 * path. `auth.scopes` is intentionally excluded — it is not an `OperationManifest`
 * field and is applied to `op.auth.scopes` directly by the resolver.
 */
export function projectOperationManifest(
  values: ReadonlyMap<SemanticPredicate, unknown>,
): OperationManifest {
  const m: OperationManifest = {};
  const v = <T>(p: SemanticPredicate): T | undefined =>
    values.has(p) ? (values.get(p) as T) : undefined;

  const sideEffect = v<OperationManifest["side_effect"]>("effect.kind");
  if (sideEffect) m.side_effect = sideEffect;
  const risk = v<OperationManifest["risk"]>("effect.risk");
  if (risk) m.risk = risk;
  const reversible = v<boolean>("effect.reversible");
  if (reversible !== undefined) m.reversible = reversible;
  const action = v<OperationManifest["action"]>("effect.action");
  if (action) m.action = action;
  const displayName = v<string>("displayName");
  if (displayName) m.display_name = displayName;
  const description = v<string>("description");
  if (description) m.description = description;

  const nameResource = v<string>("name.resource");
  const nameVerb = v<string>("name.verb");
  if (nameResource !== undefined || nameVerb !== undefined) {
    m.name = {};
    if (nameResource !== undefined) m.name.resource = nameResource;
    if (nameVerb !== undefined) m.name.verb = nameVerb;
  }

  const auth: NonNullable<OperationManifest["auth"]> = {};
  const principal = v<NonNullable<OperationManifest["auth"]>["principal"]>("auth.principal");
  if (principal) auth.principal = principal;
  const audience = v<string>("auth.audience");
  if (audience) auth.audience = audience;
  const secretSource =
    v<NonNullable<OperationManifest["auth"]>["secret_source"]>("auth.secretSource");
  if (secretSource) auth.secret_source = secretSource;
  const tenant = v<string>("auth.tenant");
  if (tenant) auth.tenant = tenant;
  const actor = v<string>("auth.actor");
  if (actor) auth.actor = actor;
  const subject = v<string>("auth.subject");
  if (subject) auth.subject = subject;
  if (Object.keys(auth).length > 0) m.auth = auth;

  const mode = v<IdempotencyMode>("idempotency.mode");
  if (mode) {
    m.idempotency = { strategy: MODE_TO_STRATEGY[mode] };
    const mechanism =
      v<NonNullable<OperationManifest["idempotency"]>["key_location"]>("idempotency.mechanism");
    if (mechanism) m.idempotency.key_location = mechanism;
    const key = v<string>("idempotency.key");
    if (key) m.idempotency.header = key;
  }

  const confRequired = v<boolean>("confirmation.required");
  const confRisk = v<NonNullable<OperationManifest["confirmation"]>["risk"]>("confirmation.risk");
  const confReason = v<string>("confirmation.reason");
  const confHuman = v<boolean>("confirmation.human_approval");
  if (confRequired !== undefined || confRisk || confReason || confHuman !== undefined) {
    m.confirmation = {};
    if (confRequired !== undefined) m.confirmation.required = confRequired;
    if (confRisk) m.confirmation.risk = confRisk;
    if (confReason) m.confirmation.reason = confReason;
    if (confHuman !== undefined) m.confirmation.human_approval = confHuman;
  }

  const retryMode = v<"safe" | "none">("retries.mode");
  const retryOnly = v<string[]>("retries.retryOn");
  const retryMax = v<number>("retries.maxAttempts");
  if (retryMode !== undefined || retryOnly || retryMax !== undefined) {
    m.retries = {};
    if (retryMode !== undefined) m.retries.enabled = retryMode === "safe";
    if (retryOnly) m.retries.only_on = retryOnly;
    if (retryMax !== undefined) m.retries.max_attempts = retryMax;
  }

  const state = v<OperationManifest["state"]>("state");
  if (state) m.state = state;

  return m;
}
