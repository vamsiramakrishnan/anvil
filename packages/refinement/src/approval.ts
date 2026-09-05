import type { Claim } from "@anvil/air";
import type { ApprovalDecision } from "./model.js";
import type { SkillProposal, VerifiableArtifact } from "./skills/contract.js";
import { isVerifiedGrounding, meetsStrength, strengthOf } from "./skills/validate.js";

export interface ApprovalInput {
  skill: string;
  proposal: SkillProposal;
  evidence: Claim[];
  /**
   * The frozen artifacts that actually ground the patched values (see
   * `groundingArtifacts`). Supplied on the case path; omitted on the deterministic
   * heuristic path, where there are no frozen artifacts and the verification guard is
   * inert. Only these artifacts count toward verification — never an unrelated verified
   * artifact from elsewhere in the case.
   */
  groundingArtifacts?: VerifiableArtifact[];
}

/** The skills whose output is eligible for automatic approval. */
const AUTO_APPROVAL_SKILLS = new Set([
  "describe-field",
  "describe-operation",
  "generate-examples",
  "enrich-errors",
  "author-intent-examples",
  "author-routing-phrases",
]);

/**
 * Patch-set keys that touch `AsyncContract.webhook` — see Rule 0c's comment
 * for the full grounding of why these particular spellings, and why there
 * are several rather than one. Checked on the FIELD, exactly like the
 * idempotency-carrier and query-policy keys above, so this list stays
 * correct even before any skill produces a matching proposal.
 */
const ASYNC_WEBHOOK_PATCH_KEYS = [
  // The whole `WebhookContract` object, proposed atomically — the
  // `query_policy` shape.
  "async_webhook",
  // Per-leaf-field, mirroring `classify-idempotency`'s granularity, in case
  // a future skill proposes the linkage field-by-field instead.
  "webhook_operation_id",
  "webhook_job_id_field",
  "webhook_state_field",
  "webhook_signature_verification",
];

/**
 * The auto-approval policy: decides `auto` vs `review`, never `reject` — a
 * proposal that fails validation or regresses an eval never reaches this
 * function to begin with, so there is nothing left here to reject.
 *
 * Safety is asymmetric by design: tightening a safety semantic (refusing more,
 * retrying less) is always cheap to approve, because the worst case is an
 * unnecessary human review. Loosening one (enabling retries) is exactly
 * backwards — the worst case is a non-idempotent mutation firing twice — so it
 * demands the strongest evidence bar (`authoritative`) regardless of which
 * skill proposed it. That guard runs first and wins over every other rule.
 */
export function classifyApproval(input: ApprovalInput): ApprovalDecision {
  const strength = strengthOf(input.evidence);
  const set = input.proposal.patch.set;

  // Whether the evidence that grounds THIS proposal's patched values is unverified-only.
  // Undefined groundingArtifacts = the heuristic path (no frozen artifacts) — the guard
  // stays inert there. An empty grounding set is not treated as unverified-only (there is
  // nothing to be unverified); ungrounded proposals fail validation before reaching here.
  const grounding = input.groundingArtifacts;
  const unverifiedOnly =
    grounding !== undefined &&
    grounding.length > 0 &&
    // "verified" here means re-hashable (a forgeable pathless "verified" artifact does
    // not count), so a proposal backed only by such artifacts still routes to review.
    !grounding.some(isVerifiedGrounding);

  // Rule 0 — idempotency classification guard: AIR's own default for an
  // unclassified mutation is `idempotency.mode: "none"`, already the most
  // conservative state possible (no auto-retry). Every reclassification a
  // `classify-idempotency` proposal can make moves away from that default,
  // never further from it — there is no "tightening" direction here the way
  // `retryable=false` tightens error handling, so unlike every other rule
  // below, this one is not an evidence-strength threshold. It always routes
  // to review, regardless of skill name, strength, or verification: checked
  // on the FIELD, not on skill membership in AUTO_APPROVAL_SKILLS, so this
  // stays true even if a future skill is added that also happens to touch
  // these keys.
  if (
    "idempotency_mode" in set ||
    "idempotency_mechanism" in set ||
    "idempotency_key" in set ||
    "idempotency_key_derivation" in set
  ) {
    return {
      tier: "review",
      reason: "an idempotency classification is always a person's decision, never automatic",
    };
  }

  // Rule 0b — query-policy guard: proposing a grammar policy UNBLOCKS a
  // query-passthrough surface. Exposing a query surface to an agent is a human
  // decision on the same footing as idempotency — checked on the FIELD, so it
  // holds regardless of which skill produced it.
  if ("query_policy" in set) {
    return {
      tier: "review",
      reason: "exposing a query-passthrough surface is always a person's decision, never automatic",
    };
  }

  // Rule 0c — async webhook / job-answer-authorization guard: turning on a
  // push-completion path (or changing who may answer a paused job) is new
  // trust surface into the ledger, on the same footing as idempotency and
  // query-passthrough above — checked on the FIELD, unconditionally, so it
  // holds even before any skill exists that actually proposes one.
  //
  // Key naming, grounded rather than guessed: this file governs
  // `SkillProposal.patch.set`, a TARGET-RELATIVE flat key namespace — NOT
  // the manifest overlay system's camelCase `"asyncContract"` field key
  // (`packages/compiler/src/contract/overlay.ts` / `resolution.ts`'s
  // `case "asyncContract":`), which a human hand-writes and `anvil compile`
  // applies; that system is untouched by this guard. The refinement patch
  // namespace has its own established convention instead, set by the two
  // existing safety-sensitive rules above: `classify-idempotency` (Rule 0)
  // granularizes a nested AIR shape into one snake_case key per leaf field
  // (`idempotency_mode`, `idempotency_mechanism`, ...), while
  // `review-query-passthrough` (Rule 0b) uses one snake_case key for a whole
  // nested object set atomically (`query_policy` for `op.queryPolicy`). No
  // refinement skill proposes anything under an async/webhook key today —
  // this guard is deliberately ahead of any producer, closing the gate
  // before Phase 3's generated receiver can reach a deployment un-gated
  // (design doc §15) — so both naming shapes are covered rather than
  // guessed at: `async_webhook` for a proposal that sets
  // `AsyncContract.webhook` wholesale (the `query_policy` shape, since a
  // signature-verification scheme is itself an atomic decision no more
  // divisible than a query grammar policy), and one key per
  // `WebhookContract` leaf (the `classify-idempotency` shape) in case a
  // future skill instead proposes the linkage field-by-field.
  //
  // Job-answer authorization: the design doc also asks for "any job-answer
  // authorization-touching patch" to route here. Investigated and found to
  // be a genuine gap, not a naming choice: no refinement skill, patch key,
  // or `apply.ts` write path exists anywhere in this package for an
  // operation's `AuthRequirement` (general or job-answer-specific) — grep
  // for "auth"/"scopes"/"authRequirement" across `skills/registry.ts` and
  // `apply.ts` turns up nothing. There is therefore no way today to
  // distinguish "an auth patch for job-answer" from "an auth patch in
  // general", and inventing a key nothing produces would be guessing, which
  // the task instructions explicitly warn against. This is reported as an
  // open gap rather than closed here; when a job-answer-auth-authoring skill
  // is added, its patch key(s) must be added to `ASYNC_WEBHOOK_PATCH_KEYS`
  // (or a sibling set) at that time, unconditionally routed to review, same
  // as everything else in this rule.
  if (ASYNC_WEBHOOK_PATCH_KEYS.some((key) => key in set)) {
    return {
      tier: "review",
      reason:
        "a webhook completion path (or its signature verification) is always a person's decision, never automatic",
    };
  }

  // Rule 0d — resource re-homing guard: `effect.resource` is the axis the
  // manifest `name: { resource }` override projects every routing surface from
  // at the next compile. The deficiency behind it is detected by name-text
  // corroboration, and corroboration measures agreement with the operation's
  // own name, NOT truth — vendors use synonyms (GitHub's `hooks` path vs
  // "webhook" name), which is exactly why rule B was rejected as a compiler
  // rule (design doc §6, ~15/28 sampled auto-fixes semantically wrong). So a
  // resource patch always routes to review, regardless of which skill or
  // executor produced it and however strong its evidence: checked on the
  // FIELD, like the idempotency guard above, so a future skill touching this
  // key cannot slip past by omission.
  if ("resource" in set) {
    return {
      tier: "review",
      reason:
        "re-homing an operation's routing resource is always a person's decision, never automatic",
    };
  }

  // Rule 0e — group composition guard: a `workflow` patch changes what the
  // served MCP surface LISTS (a composite registers, its superseded members
  // stop being listed); a `capability` patch declares a new grouping the
  // capability lifecycle will review; and a `disambiguate` patch rewrites what
  // several served tools SAY at once — the text `mcpToolDescription` composes,
  // read by every agent routing over them, changed for K operations under one
  // decision. All three reshape the surface an agent routes over, and the
  // benchmark delta the CLI attaches is EVIDENCE for the reviewer, never an
  // approval — a measured uplift does not make surface reshaping automatic, any
  // more than authoritative evidence makes an idempotency call automatic.
  // Checked on the FIELD, like every guard above, so a future skill touching
  // these keys cannot slip past by omission.
  if ("workflow" in set || "capability" in set || "disambiguate" in set) {
    return {
      tier: "review",
      reason:
        "composing, regrouping, or rewording the served tool surface is always a person's decision, never automatic",
    };
  }

  // Rule 1 — safety loosening guard: enabling retries reduces safety, so it is
  // never auto-approved on anything less than authoritative evidence.
  if (set.retryable === true && strength !== "authoritative") {
    return {
      tier: "review",
      reason: "loosening retry (retryable=true) requires authoritative evidence",
    };
  }

  // Rule 1b — verification guard: an auto-eligible proposal grounded ONLY by unverified
  // external evidence never auto-approves, however strong its aggregate strength. Verified
  // grounding is necessary (not sufficient) for automatic approval. For retryable=true this
  // stacks on Rule 1's authoritative bar; for retryable=false it prevents an unverified
  // claim from inventing non-retryability (validation also rejects that upstream).
  if (AUTO_APPROVAL_SKILLS.has(input.skill) && unverifiedOnly) {
    return {
      tier: "review",
      reason: "proposal is grounded only by unverified external evidence",
    };
  }

  // Rule 2 — plain descriptions: corroborated+ evidence is enough to trust a
  // human-readable summary that carries no safety weight.
  if (input.skill === "describe-field" || input.skill === "describe-operation") {
    return meetsStrength(strength, "corroborated")
      ? { tier: "auto", reason: "description grounded by corroborated+ evidence" }
      : { tier: "review", reason: "description needs corroborating evidence for auto-approval" };
  }

  // Rule 3 — example values: low-risk documentation of shape, not behavior, so
  // any grounding evidence at all is sufficient.
  if (input.skill === "generate-examples") {
    return input.evidence.length > 0
      ? { tier: "auto", reason: "example values grounded by evidence/schema" }
      : { tier: "review", reason: "example lacks grounding" };
  }

  // Rule 4 — error enrichment: a grounded message is auto at corroborated+
  // strength; tightening retryability to `false` is always safe to auto-apply
  // (loosening was already routed to review by rule 1, above).
  if (input.skill === "enrich-errors") {
    if (typeof set.message === "string" && meetsStrength(strength, "corroborated")) {
      return { tier: "auto", reason: "error message grounded by corroborated+ evidence" };
    }
    if (set.retryable === false) {
      return { tier: "auto", reason: "tightening retryability is always safe" };
    }
    return { tier: "review", reason: "error enrichment needs corroborating evidence" };
  }

  // Rule 4b — intent examples: routing phrases templated from the operation's
  // own spec semantics. Same risk class as example values — documentation of
  // intent, not behavior — so grounding evidence is sufficient.
  if (input.skill === "author-intent-examples" || input.skill === "author-routing-phrases") {
    return input.evidence.length > 0
      ? { tier: "auto", reason: "intent phrases templated from spec-derived semantics" }
      : { tier: "review", reason: "intent phrases lack grounding" };
  }

  // Rule 5 — default: no rule above matched, so a human decides.
  return { tier: "review", reason: "no auto-approval rule matched; human review required" };
}
