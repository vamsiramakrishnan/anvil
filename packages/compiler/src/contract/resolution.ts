/**
 * Overlay resolution — the heart of the contract layer.
 *
 * Given base AIR operations and a set of policy overlays, resolve each
 * `(operation, predicate)` to one effective value, honouring:
 *   - deterministic, order-independent combination (assertions are keyed and
 *     deduped; the result never depends on overlay array order);
 *   - restrictions combine (auth scopes union; safety booleans move to the safer
 *     pole) and never loosen;
 *   - safety asymmetry — loosening a safety-sensitive predicate needs an
 *     authoritative origin or high-reliability evidence, else the safer base wins;
 *   - contradictions on safety-sensitive predicates become conflicts (data), and
 *     a contested retry posture on a mutation blocks the operation.
 *
 * Resolved values are projected back into an `OperationManifest` and applied via
 * the one shared application path (`applyOperationManifest`), so overlays and the
 * legacy manifest mutate operations identically.
 */
import { type Diagnostic, type Operation, SOURCE_RELIABILITY } from "@anvil/air";
import { applyOperationManifest, operationMatchesKey } from "../manifest.js";
import type {
  ConflictSide,
  OverlayOrigin,
  PolicyOverlay,
  SemanticConflict,
  SemanticOverlayAssertion,
  SemanticPredicate,
} from "./model.js";
import {
  authorityFor,
  CONTRACT_SAFETY_PREDICATES,
  canLoosen,
  ORIGIN_AUTHORITY,
  projectOperationManifest,
} from "./overlay.js";

/** One assertion tagged with the origin of the overlay it came from. */
interface Tagged {
  assertion: SemanticOverlayAssertion;
  origin: OverlayOrigin;
  reliability: number;
}

export interface ResolvedOperation {
  operationId: string;
  /** Scalar predicate → effective value (excludes scopes and conflicted predicates). */
  values: Map<SemanticPredicate, unknown>;
  /** Effective required scopes when `auth.scopes` was touched. */
  scopes?: string[];
  /** Any unresolved safety-sensitive conflict blocks the operation. */
  blocked: boolean;
  /** The predicates whose contested safety semantics blocked this operation. */
  blockedByConflicts: string[];
}

export interface ResolveOutcome {
  perOperation: Map<string, ResolvedOperation>;
  conflicts: SemanticConflict[];
  diagnostics: Diagnostic[];
  /** Operation ids blocked because a safety-sensitive semantic is contested. */
  blockedOperationIds: string[];
}

/** The safer pole of a safety boolean/enum, when the predicate has one. */
function saferScalar(predicate: SemanticPredicate, a: unknown, b: unknown): unknown {
  switch (predicate) {
    case "confirmation.required":
    case "confirmation.human_approval":
      return a === true || b === true;
    case "effect.reversible":
      return !(a === false || b === false);
    case "retries.mode":
      return a === "none" || b === "none" ? "none" : "safe";
    case "effect.kind":
      return a === "mutation" || b === "mutation" ? "mutation" : "read";
    default:
      return b; // no defined pole; a restrict behaves like a later value
  }
}

/** True when moving base→candidate loosens a safety predicate that has a pole. */
function isLoosening(predicate: SemanticPredicate, base: unknown, candidate: unknown): boolean {
  switch (predicate) {
    case "confirmation.required":
    case "confirmation.human_approval":
      return base === true && candidate === false;
    case "effect.reversible":
      return base === false && candidate === true;
    case "retries.mode":
      return base === "none" && candidate === "safe";
    case "effect.kind":
      return base === "mutation" && candidate === "read";
    case "idempotency.mode":
      // "none" is the safe posture: never auto-retry, always confirm a mutation.
      // Any move away from "none" makes the operation retry-eligible and can drop
      // the non-idempotent confirmation trigger — a loosening that needs authority.
      return base === "none" && candidate !== "none";
    default:
      return false;
  }
}

function baseValue(op: Operation, predicate: SemanticPredicate): unknown {
  switch (predicate) {
    case "effect.kind":
      return op.effect.kind;
    case "effect.risk":
      return op.effect.risk;
    case "effect.reversible":
      return op.effect.reversible;
    case "effect.action":
      return op.effect.action;
    case "displayName":
      return op.displayName;
    case "description":
      return op.description;
    case "state":
      return op.state;
    // The current routing name's parts — the leading token is the verb, the
    // rest the resource — so a `set` override has a base to replace and an
    // `assert` a base to conflict against, like every other predicate.
    case "name.resource":
      return op.canonicalName.split("_").slice(1).join("_");
    case "name.verb":
      return op.canonicalName.split("_")[0] ?? "";
    case "auth.type":
      return op.auth.type;
    case "auth.credentialProfile":
      return op.auth.credentialProfile;
    case "auth.provider":
      return op.auth.provider;
    case "auth.principal":
      return op.auth.principal;
    case "auth.issuer":
      return op.auth.issuer;
    case "auth.audience":
      return op.auth.audience;
    case "auth.carrier":
      return op.auth.carrier;
    case "auth.secretSource":
      return op.auth.secretSource;
    case "auth.tenant":
      return op.auth.tenant;
    case "auth.actor":
      return op.auth.delegation?.actor;
    case "auth.subject":
      return op.auth.delegation?.subject;
    case "auth.scopes":
      return op.auth.scopes;
    case "idempotency.mode":
      return op.idempotency.mode;
    case "idempotency.mechanism":
      return op.idempotency.mechanism;
    case "idempotency.key":
      return op.idempotency.key;
    case "confirmation.required":
      return op.confirmation.required;
    case "confirmation.human_approval":
      return op.confirmation.humanApproval;
    case "confirmation.risk":
      return op.confirmation.risk;
    case "confirmation.reason":
      return op.confirmation.reason;
    case "retries.mode":
      return op.retries.mode;
    case "retries.maxAttempts":
      return op.retries.maxAttempts;
    case "retries.retryOn":
      return op.retries.retryOn;
  }
}

const canon = (v: unknown): string => JSON.stringify(v ?? null);

function maxReliability(tagged: Tagged[]): number {
  return tagged.reduce((acc, t) => Math.max(acc, t.reliability), 0);
}

function sideOf(value: unknown, tagged: Tagged[]): ConflictSide {
  return {
    value,
    origins: [...new Set(tagged.map((t) => t.origin))].sort(),
    operation: tagged[0]?.assertion.operation ?? "set",
    authority: tagged.reduce((acc, t) => Math.max(acc, ORIGIN_AUTHORITY[t.origin]), 0),
    evidenceReliability: maxReliability(tagged),
    evidenceRefs: [...new Set(tagged.flatMap((t) => t.assertion.evidenceRefs))].sort(),
  };
}

interface ScalarResolution {
  value?: unknown;
  conflict?: SemanticConflict;
  diagnostics: Diagnostic[];
}

/** Resolve one scalar predicate for one operation. */
function resolveScalar(
  op: Operation,
  predicate: SemanticPredicate,
  tagged: Tagged[],
): ScalarResolution {
  const diagnostics: Diagnostic[] = [];
  const safety = CONTRACT_SAFETY_PREDICATES.has(predicate);
  const base = baseValue(op, predicate);

  const sets = tagged.filter((t) => t.assertion.operation === "set");
  const asserts = tagged.filter((t) => t.assertion.operation === "assert");
  const restricts = tagged.filter((t) => t.assertion.operation === "restrict");

  // Group the authoritative candidates (set, else assert) by distinct value.
  const primary = sets.length > 0 ? sets : asserts;
  let candidate: { value: unknown; origins: OverlayOrigin[]; reliability: number } | undefined;

  if (primary.length > 0) {
    const byValue = new Map<string, Tagged[]>();
    for (const t of primary) {
      const key = canon(t.assertion.value);
      byValue.set(key, [...(byValue.get(key) ?? []), t]);
    }
    const groups = [...byValue.entries()]
      .map(([key, ts]) => ({
        key,
        value: ts[0]?.assertion.value,
        authority: ts.reduce((acc, t) => Math.max(acc, ORIGIN_AUTHORITY[t.origin]), 0),
        reliability: maxReliability(ts),
        tagged: ts,
      }))
      .sort(
        (a, b) =>
          b.authority - a.authority || b.reliability - a.reliability || a.key.localeCompare(b.key),
      );

    const top = groups[0];
    const runnerUp = groups[1];
    if (top) {
      const tiedByAuthority = runnerUp && sets.length > 0 && runnerUp.authority === top.authority;
      const tiedByEvidence =
        runnerUp && sets.length === 0 && runnerUp.reliability >= top.reliability;
      if (tiedByAuthority || tiedByEvidence) {
        if (safety) {
          return {
            conflict: {
              target: { scope: "operation", ref: op.id },
              predicate,
              safetySensitive: true,
              sides: groups
                .filter((g) => g.authority === top.authority || sets.length === 0)
                .map((g) => sideOf(g.value, g.tagged)),
              allowedResolutions:
                predicate === "retries.mode" ? ["set", "block", "escalate"] : ["set", "escalate"],
              message: `Contested ${predicate} on ${op.id}: ${groups
                .map((g) => `${canon(g.value)} (${g.tagged.map((t) => t.origin).join("/")})`)
                .join(" vs ")}`,
            },
            diagnostics,
          };
        }
        diagnostics.push({
          level: "info",
          code: "overlay/resolved_by_order",
          operationId: op.id,
          message: `Non-safety predicate ${predicate} had competing values; picked ${canon(top.value)} deterministically.`,
        });
      }
      candidate = {
        value: top.value,
        origins: [...new Set(top.tagged.map((t) => t.origin))],
        reliability: top.reliability,
      };
    }
  }

  // Restrictions tighten toward the safer pole and always apply (never loosen).
  if (restricts.length > 0) {
    let safer: unknown = candidate?.value ?? base;
    for (const r of restricts) safer = saferScalar(predicate, safer, r.assertion.value);
    candidate = {
      value: safer,
      origins: [...new Set([...(candidate?.origins ?? []), ...restricts.map((r) => r.origin)])],
      reliability: Math.max(candidate?.reliability ?? 0, maxReliability(restricts)),
    };
  }

  if (candidate === undefined) return { diagnostics };

  // Note: a value equal to the *normalized* base is still applied. The compiler
  // recomputes derived policy (retry/confirmation) after this slot, so an
  // explicit override that momentarily matches the base can still be the decisive
  // value once idempotency/effect change around it — exactly the manifest's job.

  // Safety asymmetry: a set/assert that loosens is allowed only when a
  // contributing origin is authoritative *for that predicate* (see #2). Caller-
  // authored `reliability` is advisory and never authorizes a loosening — a
  // source can only loosen what it can prove.
  if (safety && isLoosening(predicate, base, candidate.value)) {
    if (!canLoosen(candidate.origins, predicate)) {
      diagnostics.push({
        level: "warning",
        code: "overlay/loosen_refused",
        operationId: op.id,
        message: `Refused to loosen ${predicate} on ${op.id} from ${canon(base)} to ${canon(candidate.value)}: no origin is authoritative for this predicate (${candidate.origins.join("/")}).`,
      });
      return { diagnostics };
    }
  }

  return { value: candidate.value, diagnostics };
}

/** Resolve `auth.scopes`: restrict/set combine to a union; remove subtracts. */
function resolveScopes(
  op: Operation,
  tagged: Tagged[],
): { scopes: string[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const required = new Set<string>(op.auth.scopes);

  // A `set` only replaces the baseline when it comes from an authoritative origin
  // — replacing is a potential loosening (it can drop required scopes), so an
  // inferred overlay setting `[]` must never silently strip OAuth scopes. Its
  // scopes are unioned in instead (it can tighten, never weaken).
  const sets = tagged.filter((t) => t.assertion.operation === "set");
  const authoritativeSets = sets.filter(
    (t) => authorityFor(t.origin, "auth.scopes") === "authoritative",
  );
  if (authoritativeSets.length > 0) {
    required.clear();
    for (const s of authoritativeSets) {
      for (const scope of asStringArray(s.assertion.value)) required.add(scope);
    }
  }
  for (const s of sets) {
    if (authorityFor(s.origin, "auth.scopes") === "authoritative") continue;
    const proposed = new Set(asStringArray(s.assertion.value));
    const dropped = [...required].filter((scope) => !proposed.has(scope));
    if (dropped.length > 0) {
      diagnostics.push({
        level: "warning",
        code: "overlay/loosen_refused",
        operationId: op.id,
        message: `Refused to drop required scope(s) ${canon(dropped)} on ${op.id}: a non-authoritative ${s.origin} 'set' may only add scopes.`,
      });
    }
    for (const scope of proposed) required.add(scope);
  }

  // restrict combines: every restricted scope becomes required (tightening).
  for (const t of tagged.filter((t) => t.assertion.operation === "restrict")) {
    for (const scope of asStringArray(t.assertion.value)) required.add(scope);
  }
  // remove drops a required scope — a loosening, allowed only from an authoritative origin.
  for (const t of tagged.filter((t) => t.assertion.operation === "remove")) {
    if (authorityFor(t.origin, "auth.scopes") !== "authoritative") {
      diagnostics.push({
        level: "warning",
        code: "overlay/loosen_refused",
        operationId: op.id,
        message: `Refused to remove scope(s) ${canon(t.assertion.value)} on ${op.id} from non-authoritative origin ${t.origin}.`,
      });
      continue;
    }
    for (const scope of asStringArray(t.assertion.value)) required.delete(scope);
  }
  return { scopes: [...required].sort(), diagnostics };
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value === "string") return [value];
  return [];
}

/** Resolve overlays against operations into per-operation effective values. */
export function resolveOverlays(
  operations: readonly Operation[],
  overlays: readonly PolicyOverlay[],
): ResolveOutcome {
  const perOperation = new Map<string, ResolvedOperation>();
  const conflicts: SemanticConflict[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const op of operations) {
    // Gather every assertion (across overlays) that targets this operation.
    const tagged: Tagged[] = [];
    for (const overlay of overlays) {
      const reliability = SOURCE_RELIABILITY[overlayEvidenceKind(overlay.origin)] ?? 0.5;
      for (const a of overlay.assertions) {
        if (a.target.scope !== "operation") continue;
        if (!operationMatchesKey(op, a.target.ref)) continue;
        tagged.push({
          assertion: a,
          origin: overlay.origin,
          reliability: assertionReliability(overlay, a, reliability),
        });
      }
    }
    if (tagged.length === 0) continue;

    const byPredicate = new Map<SemanticPredicate, Tagged[]>();
    for (const t of tagged) {
      byPredicate.set(t.assertion.predicate, [
        ...(byPredicate.get(t.assertion.predicate) ?? []),
        t,
      ]);
    }

    const values = new Map<SemanticPredicate, unknown>();
    let scopes: string[] | undefined;
    const blockedByConflicts: string[] = [];

    for (const [predicate, group] of byPredicate) {
      if (predicate === "auth.scopes") {
        const r = resolveScopes(op, group);
        scopes = r.scopes;
        diagnostics.push(...r.diagnostics);
        continue;
      }
      const r = resolveScalar(op, predicate, group);
      diagnostics.push(...r.diagnostics);
      if (r.conflict) {
        // Every conflict resolveScalar raises is safety-sensitive (it only raises
        // one for a safety predicate). An unresolved safety conflict must block the
        // operation from public exposure — not just a contested retry posture (#4).
        conflicts.push(r.conflict);
        blockedByConflicts.push(predicate);
        continue;
      }
      if (r.value !== undefined) values.set(predicate, r.value);
    }

    perOperation.set(op.id, {
      operationId: op.id,
      values,
      scopes,
      blocked: blockedByConflicts.length > 0,
      blockedByConflicts,
    });
  }

  const blockedOperationIds = [...perOperation.values()]
    .filter((r) => r.blocked)
    .map((r) => r.operationId)
    .sort();
  return { perOperation, conflicts, diagnostics, blockedOperationIds };
}

/** Apply a resolved outcome to operations, producing the effective operations. */
export function applyResolved(
  operations: readonly Operation[],
  outcome: ResolveOutcome,
): Operation[] {
  return operations.map((op) => {
    const resolved = outcome.perOperation.get(op.id);
    if (!resolved) return op;
    // Manifest-projectable predicates flow through the one application path.
    // Skip it entirely when only scopes/blocked changed, so a non-manifest
    // refinement does not spuriously stamp a manifest "enriched" claim.
    const manifest = projectOperationManifest(resolved.values);
    let next = Object.keys(manifest).length > 0 ? applyOperationManifest(op, manifest) : op;
    if (resolved.scopes) next = { ...next, auth: { ...next.auth, scopes: resolved.scopes } };
    if (resolved.blocked) next = { ...next, state: "blocked" };
    return next;
  });
}

/** Map an overlay origin to the AIR evidence kind that models its reliability. */
function overlayEvidenceKind(origin: OverlayOrigin): keyof typeof SOURCE_RELIABILITY {
  switch (origin) {
    case "gateway":
      return "source_impl";
    case "investigation":
      return "inferred";
    case "observed_traffic":
      return "recorded_traffic";
    case "operator":
    case "manifest":
      return "spec";
  }
}

/** Reliability of one assertion: the max of its cited evidence, else the origin default. */
function assertionReliability(
  overlay: PolicyOverlay,
  assertion: SemanticOverlayAssertion,
  originDefault: number,
): number {
  if (assertion.evidenceRefs.length === 0) return originDefault;
  const cited = overlay.evidence.filter((e) => assertion.evidenceRefs.includes(e.id));
  if (cited.length === 0) return originDefault;
  return cited.reduce(
    (acc, e) => Math.max(acc, e.reliability ?? SOURCE_RELIABILITY[e.kind] ?? originDefault),
    0,
  );
}
