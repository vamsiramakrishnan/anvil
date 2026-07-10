import type { AirDocument, Claim } from "@anvil/air";
import type { JsonValue } from "../skills/contract.js";
import { skillByName } from "../skills/registry.js";
import {
  isVerifiedGrounding,
  meetsStrength,
  strengthOf,
  validateProposal,
} from "../skills/validate.js";
import { allowedPredicates } from "./evidence.js";
import { bindProposalToCase, caseIdentity, contextForCase } from "./identity-binding.js";
import type { Conflict, InvestigationStatus } from "./investigation.js";
import {
  freezeStage,
  isStageFrozen,
  readProposalValidation,
  recordProposalValidation,
  transition,
  verifyFrozenStage,
  verifyFrozenStages,
} from "./lifecycle.js";
import {
  CASE_AUX,
  CASE_OUTPUT,
  type CaseProposal,
  type CaseTargetDoc,
  type ClaimSet,
  type EvidenceArtifact,
  type EvidencePolicyDoc,
  type EvidenceReport,
  parseCaseProposal,
  parseClaimSet,
  parseEvidenceReport,
  type ValidationReport,
} from "./model.js";
import { loadPolicy, loadTargetDoc, loadTask, readOptionalJson, writeJson } from "./store.js";

/**
 * **Proposal synthesis, validation, and finalization** — the back half of a case run,
 * as rails rather than hand-written JSON. Each rail advances the run's explicit
 * lifecycle and, before it consumes a frozen stage, re-verifies that stage's
 * integrity, so a rewritten `evidence.json`/`claims.json`/`proposal.json` can never
 * slip past a state transition. The agent owns synthesis and critique in prose; these
 * functions own admissibility, boundary, freezing, and the honest final status.
 */

/* ------------------------------- synthesize ------------------------------- */

/**
 * Compose `output/proposal.json` from the gathered claims — the Synthesizer phase.
 * Keys outside the skill's writable fields are refused here (the boundary is a rail,
 * not a post-hoc rejection); grounding is checked by `validate-proposal`. Freezes the
 * research stage and advances the run to `research_frozen`, so the synthesizer cannot
 * rewrite its own evidence afterwards.
 */
export function synthesizeProposal(dir: string, set: Record<string, JsonValue>): string {
  if (isStageFrozen(dir, "synthesis")) {
    throw new Error(
      "The synthesis stage is frozen (the proposal was validated). Open a new run to revise it.",
    );
  }
  const task = loadTask(dir);
  const tdoc = loadTargetDoc(dir);
  const policy = loadPolicy(dir);
  const outside = Object.keys(set).filter((k) => !policy.writableFields.includes(k));
  if (outside.length > 0) {
    throw new Error(
      `Cannot write ${outside.join(", ")}: outside this skill's boundary (${policy.writableFields.join(", ") || "none"}).`,
    );
  }
  const claims = (readOptionalJson<ClaimSet>(dir, CASE_OUTPUT.extract) ?? { claims: [] }).claims;
  const proposal: CaseProposal = {
    skill: task.skill,
    skillVersion: task.skillVersion,
    deficiency: task.deficiency,
    target: tdoc.target,
    claims,
    patch: { target: tdoc.target, set },
  };
  writeJson(dir, CASE_OUTPUT.synthesize, proposal);
  // Freeze research+claims, then advance: the synthesizer cannot rewrite its evidence.
  freezeStage(dir, "research");
  transition(dir, "research_frozen");
  const kv = Object.entries(set)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(" ");
  return `Wrote ${CASE_OUTPUT.synthesize} (${claims.length} claim(s)): ${kv}. Research is now frozen; run \`anvil case validate-proposal\`.`;
}

/* ---------------------------- validate-claims ----------------------------- */

/** Detect claims about one predicate that assert different values — a contradiction. */
export function detectConflicts(claims: Claim[]): Conflict[] {
  const byPredicate = new Map<string, Claim[]>();
  for (const c of claims) {
    const arr = byPredicate.get(c.predicate) ?? [];
    arr.push(c);
    byPredicate.set(c.predicate, arr);
  }
  const conflicts: Conflict[] = [];
  for (const [predicate, group] of byPredicate) {
    const distinct = new Set(group.map((c) => JSON.stringify(c.value)));
    if (distinct.size > 1) conflicts.push({ predicate, claims: group });
  }
  return conflicts;
}

export function validateClaims(dir: string): string {
  const policy = loadPolicy(dir);
  const set = readOptionalJson<ClaimSet>(dir, CASE_OUTPUT.extract);
  if (!set || set.claims.length === 0)
    return "No claims recorded yet. Use `anvil case add-evidence`.";
  const claims = parseClaimSet(set).claims;

  const lines: string[] = [];
  const inadmissible = claims.filter((c) => !policy.allowedSources.includes(c.source));
  // Independent predicate-policy enforcement: even a hand-written claims.json is
  // held to the same output/supporting predicate policy add-evidence enforces.
  const allowed = allowedPredicates(policy);
  const offPolicy = claims.filter((c) => !allowed.has(c.predicate));
  const strength = strengthOf(claims);
  const meets = meetsStrength(strength, policy.minimumStrength);
  const conflicts = detectConflicts(claims);

  lines.push(
    `${claims.length} claim(s); aggregate strength: ${strength} (need ${policy.minimumStrength}).`,
  );
  lines.push(meets ? "  ✓ meets minimum strength" : "  ✗ below minimum strength");
  if (inadmissible.length > 0) {
    lines.push(
      `  ✗ ${inadmissible.length} claim(s) from inadmissible sources: ${[...new Set(inadmissible.map((c) => c.source))].join(", ")}`,
    );
  } else {
    lines.push("  ✓ every claim is from an admissible source");
  }
  if (offPolicy.length > 0) {
    lines.push(
      `  ✗ ${offPolicy.length} claim(s) assert off-policy predicates: ${[...new Set(offPolicy.map((c) => c.predicate))].join(", ")}`,
    );
  } else {
    lines.push("  ✓ every claim asserts an allowed predicate");
  }
  if (conflicts.length > 0) {
    lines.push(`  ⚠ ${conflicts.length} contradiction(s):`);
    for (const c of conflicts) {
      const vals = c.claims.map((cl) => `${JSON.stringify(cl.value)}@${cl.source}`).join(" vs ");
      lines.push(`    ${c.predicate}: ${vals}`);
    }
    lines.push("  → finalize with status 'conflicted' unless one source is clearly authoritative.");
  } else {
    lines.push("  ✓ no contradictions among claims");
  }
  return lines.join("\n");
}

/* --------------------------- validate-proposal ---------------------------- */

/**
 * Run the skill's deterministic validation against the case's `output/proposal.json`
 * and write `output/critique.json`. Verifies the frozen research stage first (the
 * evidence the proposal rests on must not have changed since synthesis), then freezes
 * the proposal and advances to `proposal_frozen` so the critic examines an artifact
 * it cannot rewrite. Requires AIR to rebuild the real skill context.
 */
export function validateCaseProposal(
  air: AirDocument,
  dir: string,
): { report: ValidationReport; text: string } {
  const raw = readOptionalJson<CaseProposal>(dir, CASE_OUTPUT.synthesize);
  if (!raw) throw new Error(`No ${CASE_OUTPUT.synthesize} in ${dir}. Synthesize a proposal first.`);
  // Integrity gate: the evidence frozen at synthesis must be unchanged.
  verifyFrozenStage(dir, "research");
  const proposal = parseCaseProposal(raw);
  bindProposalToCase(proposal, caseIdentity(dir));
  const { task, context } = contextForCase(air, dir);
  const skill = skillByName(task.skill);
  if (!skill) throw new Error(`Unknown skill '${task.skill}'.`);

  // Resolve grounding claims against the FROZEN evidence report so verification-sensitive
  // checks hold each patched value to its field's trust bar (verified vs allow_unverified).
  // Parse it through the schema so a forged artifact (e.g. a pathless "verified" one) is
  // rejected at the trust boundary rather than trusted here.
  const frozenRaw = readOptionalJson(dir, CASE_OUTPUT.research);
  const frozenEvidence = frozenRaw ? parseEvidenceReport(frozenRaw) : { artifacts: [] };
  const validated = validateProposal(skill, proposal, context, {
    artifacts: frozenEvidence.artifacts,
  });
  const clauses = Object.entries(proposal.patch.set).map(([key, value]) => {
    const failing = validated.outcomes.find(
      (o) =>
        !o.ok && (o.check === "evidence_supports_value" || o.check === "patch_within_boundary"),
    );
    return {
      clause: `${key} = ${JSON.stringify(value)}`,
      supported: !failing,
      reason: failing ? failing.reason : "grounded and in-boundary",
    };
  });
  const report: ValidationReport = {
    clauses,
    checks: validated.outcomes,
    status: validated.status,
  };
  writeJson(dir, CASE_OUTPUT.critique, report);
  // Freeze the proposal and advance: the critic examines a frozen artifact.
  freezeStage(dir, "synthesis");
  transition(dir, "proposal_frozen");
  // Record validated/rejected separately from the state name, so a reader always
  // knows the outcome without re-parsing critique.json.
  recordProposalValidation(dir, validated.status);

  const failed = validated.outcomes.filter((o) => !o.ok);
  const text = [
    `Validation: ${validated.status.toUpperCase()} (${validated.outcomes.length} checks)`,
    ...failed.map((o) => `  ✗ ${o.check}: ${o.reason}`),
    ...(failed.length === 0 ? ["  ✓ all checks passed"] : []),
    `Wrote ${CASE_OUTPUT.critique}.`,
  ].join("\n");
  return { report, text };
}

/* --------------------------- supported evidence --------------------------- */

/**
 * The output predicate and *current* value a `supported` finalize must prove is already
 * correct, read from the case's frozen target snapshot. Returns `undefined` when the
 * target carries no current value for the skill's output (a missing description, an
 * error with no message, …) — in which case `supported` is impossible: there is nothing
 * to support. An empty/whitespace description counts as absent for exactly this reason.
 */
function currentSemanticValue(
  skill: string,
  tdoc: CaseTargetDoc,
): { predicate: string; field: string; value: unknown } | undefined {
  const nonEmpty = (v: string | undefined): string | undefined =>
    v !== undefined && v.trim().length > 0 ? v : undefined;
  switch (skill) {
    case "describe-field": {
      const v = nonEmpty(tdoc.field?.existingDescription);
      return v === undefined
        ? undefined
        : { predicate: "field.description", field: "description", value: v };
    }
    case "describe-operation": {
      const v = nonEmpty(tdoc.operationDescription);
      return v === undefined
        ? undefined
        : { predicate: "operation.description", field: "description", value: v };
    }
    case "generate-examples": {
      const v = tdoc.field?.example;
      return v === undefined
        ? undefined
        : { predicate: "field.example", field: "examples", value: v };
    }
    case "enrich-errors": {
      // Retryability is the safety-critical fact; when it is set, `supported` must prove
      // that, at the field's (verified) bar. Otherwise fall back to the message.
      if (tdoc.errorRetryable !== undefined) {
        return { predicate: "error.retryable", field: "retryable", value: tdoc.errorRetryable };
      }
      const v = nonEmpty(tdoc.errorMessage);
      return v === undefined
        ? undefined
        : { predicate: "error.message", field: "message", value: v };
    }
    default:
      return undefined;
  }
}

/**
 * Whether the current semantic value is genuinely *proven already correct* by the case's
 * evidence — the honest bar for a `supported` finalize. It is not enough that some claim
 * exists: an admissible claim must assert the exact output predicate AND the exact
 * current value, the corroborating evidence must meet the skill's minimum strength, and —
 * where the field demands verified evidence — at least one grounding artifact must be
 * verified. A missing current value, an unrelated claim, a claim for a different value,
 * or unverified-only evidence for a verified-required field all make `supported` invalid.
 */
function evaluateSupported(
  skill: string,
  tdoc: CaseTargetDoc,
  policy: EvidencePolicyDoc,
  claims: Claim[],
  artifacts: EvidenceArtifact[],
): { ok: true } | { ok: false; reason: string } {
  const current = currentSemanticValue(skill, tdoc);
  if (!current) {
    return {
      ok: false,
      reason:
        "the target has no current value for this skill's output (there is nothing to support)",
    };
  }
  const admissible = claims.filter((c) => policy.allowedSources.includes(c.source));
  const matching = admissible.filter(
    (c) =>
      c.predicate === current.predicate &&
      JSON.stringify(c.value) === JSON.stringify(current.value),
  );
  if (matching.length === 0) {
    return {
      ok: false,
      reason: `no admissible claim asserts the current ${current.predicate} value`,
    };
  }
  if (!meetsStrength(strengthOf(matching), policy.minimumStrength)) {
    return {
      ok: false,
      reason: `evidence supporting the current value is below the required strength (${policy.minimumStrength})`,
    };
  }
  const required = policy.fieldVerification?.[current.field] ?? policy.minimumVerification;
  if (required === "verified") {
    const byId = new Map(artifacts.map((a) => [a.id, a]));
    // A verified requirement is met only by a re-hashable verified artifact (see
    // isVerifiedGrounding) — a pathless "verified" artifact cannot be re-verified.
    const verified = matching.some((c) => {
      const art = c.sourceRef ? byId.get(c.sourceRef) : undefined;
      return art !== undefined && isVerifiedGrounding(art);
    });
    if (!verified) {
      return {
        ok: false,
        reason: `${current.field} requires verified evidence, but the supporting claim(s) rest on unverified artifacts`,
      };
    }
  }
  return { ok: true };
}

/* -------------------------------- finalize -------------------------------- */

export interface FinalizeInput {
  status?: InvestigationStatus;
  summary?: string;
  /** Required when requesting `blocked_by_missing_source` — the concrete source(s) that were unavailable. */
  blockedSources?: Array<{ source: string; reason: string }>;
}

/**
 * The facts `validateRequestedStatus` checks a requested status against — everything
 * `finalize` already loaded from the case's artifacts, named so the switch below reads
 * like the claims it is actually verifying.
 */
interface FinalizeFacts {
  hasProposal: boolean;
  proposalValidated: boolean;
  conflictCount: number;
  evidenceStrengthMet: boolean;
  hasUsableEvidence: boolean;
  /** Whether the current semantic value is actually proven correct (the `supported` bar). */
  currentValueSupport: { ok: true } | { ok: false; reason: string };
  blockedSources?: FinalizeInput["blockedSources"];
}

/**
 * An explicit `--status` is a claim, not a fact — Anvil decides whether the artifacts
 * actually support it. Only reached when `input.status` is supplied; the implicit
 * derivation in `finalize` below is already artifact-derived by construction and is
 * not re-checked here.
 */
function validateRequestedStatus(requested: InvestigationStatus, facts: FinalizeFacts): void {
  switch (requested) {
    case "proposal_generated":
      if (!facts.hasProposal || !facts.proposalValidated) {
        throw new Error(
          "Cannot finalize as 'proposal_generated': no proposal exists, or it did not pass validate-proposal.",
        );
      }
      return;
    case "conflicted":
      if (facts.conflictCount === 0) {
        throw new Error("Cannot finalize as 'conflicted': no contradicting claims were recorded.");
      }
      return;
    case "insufficient_evidence":
      if (facts.proposalValidated) {
        throw new Error("Cannot finalize as 'insufficient_evidence': a validated proposal exists.");
      }
      if (facts.hasUsableEvidence && facts.evidenceStrengthMet) {
        throw new Error(
          "Cannot finalize as 'insufficient_evidence': the recorded evidence already meets the required strength.",
        );
      }
      return;
    case "blocked_by_missing_source":
      if (!facts.blockedSources || facts.blockedSources.length === 0) {
        throw new Error(
          "Cannot finalize as 'blocked_by_missing_source' without --blocked-sources — record which source was unavailable and why.",
        );
      }
      return;
    case "supported":
      if (facts.hasProposal) {
        throw new Error(
          "Cannot finalize as 'supported': a proposal exists (a proposal means something was proposed to change, not that the current semantics are already supported).",
        );
      }
      if (facts.conflictCount > 0) {
        throw new Error(
          "Cannot finalize as 'supported': there are unresolved conflicting claims about the target.",
        );
      }
      // `supported` is a positive claim that the CURRENT value is already right — it must
      // be proven, not merely accompanied by some evidence. A missing current value, an
      // unrelated claim, a claim for a different value, or unverified-only evidence for a
      // verified-required field all make it invalid.
      if (!facts.currentValueSupport.ok) {
        throw new Error(`Cannot finalize as 'supported': ${facts.currentValueSupport.reason}.`);
      }
      return;
  }
}

/**
 * Close the executor's side of a case: assemble `output/result.json` from whatever
 * phase outputs exist, choosing an honest status, and advance the run to `finalized`.
 * Every frozen stage is verified first, so a result can never be assembled over
 * evidence or a proposal that was rewritten after it was frozen. An explicit
 * `--status` is validated against the artifacts before it is honoured — the agent may
 * suggest a status, but Anvil decides whether it is legitimate.
 */
export function finalize(dir: string, input: FinalizeInput = {}): string {
  // Integrity gate: nothing frozen may have changed before we record an outcome.
  verifyFrozenStages(dir);
  // Bound read: a mismatched proposal.json fails here rather than being finalized.
  const proposal = readProposal(dir);
  const claimSet = readOptionalJson<ClaimSet>(dir, CASE_OUTPUT.extract);
  const evidence = readOptionalJson<EvidenceReport>(dir, CASE_OUTPUT.research);
  // critique.json is REVIEW MATERIAL only — it is mutable and not in any freeze hash.
  // The authoritative pass/fail verdict is the lifecycle validation record, written by
  // the rails and never by the executor.
  const critique = readOptionalJson<ValidationReport>(dir, CASE_OUTPUT.critique);
  const lifecycleValidation = readProposalValidation(dir);
  // Tamper detection: a mutable critique.json that disagrees with the authoritative
  // lifecycle record means someone edited the critique to flip the verdict. Refuse rather
  // than assemble a dishonest result over it.
  if (critique && lifecycleValidation && critique.status !== lifecycleValidation.status) {
    throw new Error(
      `Inconsistent validation records: critique.json says '${critique.status}' but the lifecycle validation record says '${lifecycleValidation.status}'. The lifecycle record is authoritative; refusing to finalize over a tampered critique.`,
    );
  }
  const proposalValidated = lifecycleValidation?.status === "validated";
  const experiments = readOptionalJson<{ experiments: unknown[] }>(dir, CASE_AUX.experiments);
  const conflicts = claimSet ? detectConflicts(parseClaimSet(claimSet).claims) : [];

  if (input.status) {
    const policy = loadPolicy(dir);
    const task = loadTask(dir);
    const tdoc = loadTargetDoc(dir);
    const claims = claimSet ? parseClaimSet(claimSet).claims : [];
    const facts: FinalizeFacts = {
      hasProposal: Boolean(proposal),
      // Authoritative: the lifecycle record, never the mutable critique.json.
      proposalValidated,
      conflictCount: conflicts.length,
      evidenceStrengthMet: meetsStrength(strengthOf(claims), policy.minimumStrength),
      hasUsableEvidence: claims.length > 0,
      currentValueSupport: evaluateSupported(
        task.skill,
        tdoc,
        policy,
        claims,
        evidence?.artifacts ?? [],
      ),
      blockedSources: input.blockedSources,
    };
    validateRequestedStatus(input.status, facts);
  }

  let status: InvestigationStatus;
  if (input.status) {
    status = input.status;
  } else if (proposal && proposalValidated) {
    status = "proposal_generated";
  } else if (conflicts.length > 0) {
    status = "conflicted";
  } else {
    status = "insufficient_evidence";
  }

  const result = {
    status,
    summary: input.summary ?? defaultSummary(status, conflicts.length),
    artifacts: evidence?.artifacts ?? [],
    claims: claimSet?.claims ?? [],
    conflicts,
    experiments: experiments?.experiments ?? [],
    proposal: status === "proposal_generated" ? proposal : undefined,
    // critique is included for human review, but the authoritative verdict is the
    // lifecycle validation record recorded alongside it.
    validation: critique ?? undefined,
    proposalValidation: lifecycleValidation ?? undefined,
    blockedSources: status === "blocked_by_missing_source" ? input.blockedSources : undefined,
  };
  writeJson(dir, CASE_AUX.result, result);
  transition(dir, "finalized");
  return `Finalized case as '${status}'. Wrote ${CASE_AUX.result}.`;
}

function defaultSummary(status: InvestigationStatus, conflictCount: number): string {
  switch (status) {
    case "proposal_generated":
      return "Evidence supports a grounded, in-boundary patch.";
    case "conflicted":
      return `Sources disagree on ${conflictCount} predicate(s); no proposal made.`;
    case "insufficient_evidence":
      return "Not enough admissible evidence to ground a proposal.";
    case "blocked_by_missing_source":
      return "A required source was unavailable.";
    case "supported":
      return "The current semantics are already supported by evidence; nothing to change.";
    default:
      return "Investigation complete.";
  }
}

/* --------------------------------- readers -------------------------------- */

/** Read back the executor-authored `output/result.json`, if present. */
export function readResult(dir: string): Record<string, unknown> | undefined {
  return readOptionalJson<Record<string, unknown>>(dir, CASE_AUX.result);
}

/**
 * Read back the proposal an executor deposited — parsed AND bound to the case
 * identity. A `proposal.json` whose target, skill, version, or deficiency does not
 * match the case is rejected here, so no downstream reader can act on a misrouted one.
 */
export function readProposal(dir: string): CaseProposal | undefined {
  const raw = readOptionalJson<CaseProposal>(dir, CASE_OUTPUT.synthesize);
  if (!raw) return undefined;
  const proposal = parseCaseProposal(raw);
  bindProposalToCase(proposal, caseIdentity(dir));
  return proposal;
}

/** Read back the evidence report, if present. */
export function readEvidence(dir: string): EvidenceReport | undefined {
  const raw = readOptionalJson<EvidenceReport>(dir, CASE_OUTPUT.research);
  return raw ? parseEvidenceReport(raw) : undefined;
}
