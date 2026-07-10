import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AirDocument, Claim } from "@anvil/air";
import type { DeficiencyCode } from "../deficiency.js";
import { makeDeficiency } from "../deficiency.js";
import { assembleContext, evidenceForTarget } from "../skills/context.js";
import type { JsonValue, SkillContext } from "../skills/contract.js";
import { skillByName } from "../skills/registry.js";
import { meetsStrength, strengthOf, validateProposal } from "../skills/validate.js";
import { type SemanticTarget, targetKey } from "../target.js";
import type { Conflict, InvestigationStatus } from "./investigation.js";
import {
  type AllowedToolsDoc,
  CASE_AUX,
  CASE_FILES,
  CASE_OUTPUT,
  type CaseProposal,
  type CaseTargetDoc,
  type CaseTask,
  type ClaimSet,
  type EvidencePolicyDoc,
  type EvidenceReport,
  parseCaseProposal,
  parseClaimSet,
  parseEvidenceReport,
  type ValidationReport,
} from "./model.js";

/**
 * The `anvil case` helper commands: the deterministic rails an executor works with
 * instead of hand-constructing large JSON. Each enforces one part of the contract —
 * source policy, allowed predicates, patch boundaries, schema — so the intelligence
 * the agent contributes lands inside guardrails it cannot widen. Every command
 * reads and writes files under one case directory; none touches AIR.
 */

/* --------------------------------- loaders -------------------------------- */

function readJson<T>(dir: string, rel: string): T {
  return JSON.parse(readFileSync(join(dir, rel), "utf8")) as T;
}
function readOptionalJson<T>(dir: string, rel: string): T | undefined {
  const full = join(dir, rel);
  return existsSync(full) ? (JSON.parse(readFileSync(full, "utf8")) as T) : undefined;
}
function writeJson(dir: string, rel: string, value: unknown): void {
  writeFileSync(join(dir, rel), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function loadTask(dir: string): CaseTask {
  return readJson<CaseTask>(dir, CASE_FILES.task);
}
export function loadTargetDoc(dir: string): CaseTargetDoc {
  return readJson<CaseTargetDoc>(dir, CASE_FILES.target);
}
export function loadPolicy(dir: string): EvidencePolicyDoc {
  return readJson<EvidencePolicyDoc>(dir, CASE_FILES.evidencePolicy);
}
export function loadTools(dir: string): AllowedToolsDoc {
  return readJson<AllowedToolsDoc>(dir, CASE_FILES.allowedTools);
}

/* ------------------------------ identity binding -------------------------- */

/** The immutable identity a proposal must match to be admissible for this case. */
export interface CaseIdentity {
  skill: string;
  skillVersion: number;
  deficiency: DeficiencyCode;
  target: SemanticTarget;
  targetKey: string;
}

/** The case's identity, read from its canonical task + target inputs. */
export function caseIdentity(dir: string): CaseIdentity {
  const task = loadTask(dir);
  const t = loadTargetDoc(dir);
  return {
    skill: task.skill,
    skillVersion: task.skillVersion,
    deficiency: task.deficiency,
    target: t.target,
    targetKey: t.key,
  };
}

/**
 * Bind a proposal to a case identity, or throw. A proposal produced for one case
 * must never be able to mutate another semantic target: the skill, version,
 * deficiency, the proposal's target, AND the patch's target must all match the
 * case exactly. Mismatches are rejected loudly — never silently rewritten to the
 * case target — so a hand-written or misrouted `proposal.json` cannot patch a
 * field the case never authorised.
 */
export function bindProposalToCase(proposal: CaseProposal, id: CaseIdentity): void {
  const mismatches: string[] = [];
  if (proposal.skill !== id.skill) mismatches.push(`skill '${proposal.skill}' ≠ '${id.skill}'`);
  if (proposal.skillVersion !== id.skillVersion)
    mismatches.push(`skillVersion ${proposal.skillVersion} ≠ ${id.skillVersion}`);
  if (proposal.deficiency !== id.deficiency)
    mismatches.push(`deficiency '${proposal.deficiency}' ≠ '${id.deficiency}'`);
  const pt = targetKey(proposal.target);
  if (pt !== id.targetKey) mismatches.push(`target '${pt}' ≠ '${id.targetKey}'`);
  const patchTarget = targetKey(proposal.patch.target);
  if (patchTarget !== id.targetKey)
    mismatches.push(`patch.target '${patchTarget}' ≠ '${id.targetKey}'`);
  if (mismatches.length > 0) {
    throw new Error(
      `Proposal is not bound to its case (${id.targetKey}): ${mismatches.join("; ")}. Refusing it.`,
    );
  }
}

/**
 * Rebuild the skill's `SkillContext` for a case from AIR — the same context the
 * case was opened with — so deterministic validation runs against real AIR facts
 * (the field schema, the operation, siblings), not against a stale copy.
 */
export function contextForCase(
  air: AirDocument,
  dir: string,
): { task: CaseTask; context: SkillContext } {
  const task = loadTask(dir);
  const tdoc = loadTargetDoc(dir);
  const deficiency = makeDeficiency(task.deficiency, tdoc.target, "", {}, task.severity);
  const context = assembleContext(air, deficiency, evidenceForTarget(air, deficiency));
  return { task, context };
}

/* ------------------------------ inspect-target ---------------------------- */

export function inspectTarget(dir: string): string {
  const t = loadTargetDoc(dir);
  const p = loadPolicy(dir);
  const lines: string[] = [];
  lines.push(`${t.describe}  (${t.key})`);
  if (t.operationId)
    lines.push(`  operation: ${t.operationName ?? t.operationId} [${t.operationEffect}]`);
  if (t.field) {
    lines.push(
      `  field: ${t.field.name}  type=${t.field.type ?? "?"}  required=${t.field.required}`,
    );
    if (t.field.enumValues) lines.push(`  enum: ${JSON.stringify(t.field.enumValues)}`);
    if (t.field.existingDescription)
      lines.push(`  existing description: ${t.field.existingDescription}`);
  }
  if (t.siblingFields?.length) {
    lines.push(`  siblings: ${t.siblingFields.map((s) => s.name).join(", ")}`);
  }
  if (t.errorCode) lines.push(`  error code: ${t.errorCode}`);
  lines.push(`  admissible sources: ${p.allowedSources.join(", ")} (min ${p.minimumStrength})`);
  lines.push(`  writable fields: ${p.writableFields.join(", ") || "(none)"}`);
  lines.push(`  output predicates: ${p.writablePredicates.join(", ") || "(none)"}`);
  lines.push(`  supporting predicates: ${p.supportingPredicates.join(", ") || "(none)"}`);
  lines.push(`  prior evidence: ${t.priorEvidence.length} claim(s)`);
  lines.push(`  expected output schema: ${CASE_FILES.expectedSchema}`);
  return lines.join("\n");
}

/* ------------------------------ predicate policy -------------------------- */

/**
 * The predicates a claim may assert for this case: the skill's *output* predicates
 * (the ones the patch asserts) plus a narrow set of *supporting* predicates (the
 * intermediate facts an investigation legitimately records). Anything else is
 * rejected — an executor may not smuggle a free-form predicate into `claims.json`.
 */
export function allowedPredicates(policy: EvidencePolicyDoc): Set<string> {
  return new Set<string>([...policy.writablePredicates, ...policy.supportingPredicates]);
}

/* ------------------------------ add-evidence ------------------------------ */

export interface AddEvidenceInput {
  predicate: string;
  value?: JsonValue;
  source: string;
  ref?: string;
  note?: string;
  confidence?: number;
  span?: { start: number; end: number };
}

/**
 * Record one piece of evidence: appends both an evidence artifact (research phase)
 * and the atomic claim it grounds (extract phase). Enforces the source policy — an
 * inadmissible source is refused here, not silently accepted and rejected later.
 */
export function addEvidence(dir: string, input: AddEvidenceInput): string {
  const policy = loadPolicy(dir);
  const tdoc = loadTargetDoc(dir);
  if (!policy.allowedSources.includes(input.source as never)) {
    throw new Error(
      `Source '${input.source}' is not admissible for this case. Allowed: ${policy.allowedSources.join(", ")}.`,
    );
  }
  const allowed = allowedPredicates(policy);
  if (!allowed.has(input.predicate)) {
    throw new Error(
      `Predicate '${input.predicate}' is not permitted for this case. ` +
        `Output: ${policy.writablePredicates.join(", ") || "(none)"}; ` +
        `supporting: ${policy.supportingPredicates.join(", ") || "(none)"}.`,
    );
  }
  const subject = tdoc.field?.path ?? tdoc.operationId ?? tdoc.errorCode ?? tdoc.key;
  const claim: Claim = {
    subject,
    predicate: input.predicate,
    value: input.value,
    source: input.source as Claim["source"],
    sourceRef: input.ref,
    method: "case_investigation",
    confidence: input.confidence ?? 0.8,
    note: input.note,
  };

  const claims = readOptionalJson<ClaimSet>(dir, CASE_OUTPUT.extract) ?? { claims: [] };
  claims.claims.push(claim);
  writeJson(dir, CASE_OUTPUT.extract, claims);

  const evidence = readOptionalJson<EvidenceReport>(dir, CASE_OUTPUT.research) ?? { artifacts: [] };
  evidence.artifacts.push({
    uri: input.ref ?? "(unspecified)",
    span: input.span,
    relevance: input.note ?? `${input.predicate} = ${JSON.stringify(input.value)}`,
    source: input.source as Claim["source"],
  });
  writeJson(dir, CASE_OUTPUT.research, evidence);

  const kind = policy.writablePredicates.includes(input.predicate) ? "output" : "supporting";
  return `Recorded ${claims.claims.length} claim(s). Latest (${kind}): ${input.predicate}=${JSON.stringify(input.value)} from ${input.source}${input.ref ? ` (${input.ref})` : ""}.`;
}

/* ------------------------------- synthesize ------------------------------- */

/**
 * Compose `output/proposal.json` from the claims already gathered — the Synthesizer
 * phase, as a rail rather than hand-written JSON. The target comes from the case,
 * the claims from `output/claims.json`, and the executor supplies only the
 * target-relative `set`. Keys outside the skill's writable fields are refused here
 * (the boundary is a rail, not a post-hoc rejection); grounding is checked by
 * `test-proposal`.
 */
export function synthesizeProposal(dir: string, set: Record<string, JsonValue>): string {
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
  const kv = Object.entries(set)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(" ");
  return `Wrote ${CASE_OUTPUT.synthesize} (${claims.length} claim(s)): ${kv}. Now run \`anvil case validate-proposal\`.`;
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
 * and write `output/critique.json`. This is the Critic's machine half: the agent
 * falsifies clauses in prose; this proves the patch is grounded, in-boundary, and
 * schema-valid. Requires AIR to rebuild the real skill context.
 */
export function validateCaseProposal(
  air: AirDocument,
  dir: string,
): { report: ValidationReport; text: string } {
  const raw = readOptionalJson<CaseProposal>(dir, CASE_OUTPUT.synthesize);
  if (!raw) throw new Error(`No ${CASE_OUTPUT.synthesize} in ${dir}. Synthesize a proposal first.`);
  const proposal = parseCaseProposal(raw);
  bindProposalToCase(proposal, caseIdentity(dir));
  const { task, context } = contextForCase(air, dir);
  const skill = skillByName(task.skill);
  if (!skill) throw new Error(`Unknown skill '${task.skill}'.`);

  const validated = validateProposal(skill, proposal, context);
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

  const failed = validated.outcomes.filter((o) => !o.ok);
  const text = [
    `Validation: ${validated.status.toUpperCase()} (${validated.outcomes.length} checks)`,
    ...failed.map((o) => `  ✗ ${o.check}: ${o.reason}`),
    ...(failed.length === 0 ? ["  ✓ all checks passed"] : []),
    `Wrote ${CASE_OUTPUT.critique}.`,
  ].join("\n");
  return { report, text };
}

/* -------------------------------- finalize -------------------------------- */

export interface FinalizeInput {
  status?: InvestigationStatus;
  summary?: string;
}

/**
 * Close the executor's side of a case: assemble `output/result.json` from whatever
 * phase outputs exist, choosing an honest status. A proposal that passed validation
 * is `proposal_generated`; contradictory claims with no proposal are `conflicted`;
 * otherwise `insufficient_evidence`. The explicit `--status` always wins — the agent
 * may know it is blocked on a missing source that the files cannot show.
 */
export function finalize(dir: string, input: FinalizeInput = {}): string {
  // Bound read: a mismatched proposal.json fails here rather than being finalized.
  const proposal = readProposal(dir);
  const claimSet = readOptionalJson<ClaimSet>(dir, CASE_OUTPUT.extract);
  const evidence = readOptionalJson<EvidenceReport>(dir, CASE_OUTPUT.research);
  const validation = readOptionalJson<ValidationReport>(dir, CASE_OUTPUT.critique);
  const experiments = readOptionalJson<{ experiments: unknown[] }>(dir, CASE_AUX.experiments);
  const conflicts = claimSet ? detectConflicts(parseClaimSet(claimSet).claims) : [];

  let status: InvestigationStatus;
  if (input.status) {
    status = input.status;
  } else if (proposal && validation?.status === "validated") {
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
    validation: validation ?? undefined,
  };
  writeJson(dir, CASE_AUX.result, result);
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

/** Read back the executor-authored `output/result.json`, if present. */
export function readResult(dir: string): Record<string, unknown> | undefined {
  return readOptionalJson<Record<string, unknown>>(dir, CASE_AUX.result);
}

/**
 * Read back the proposal an executor deposited — parsed AND bound to the case
 * identity. A `proposal.json` whose target, skill, version, or deficiency does not
 * match the case is rejected here, so no downstream reader (close, reconcile, the
 * investigation result) can act on a misrouted proposal.
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
