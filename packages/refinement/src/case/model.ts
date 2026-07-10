import type { Claim, EvidenceKind } from "@anvil/air";
import type { DeficiencyCode, Severity } from "../deficiency.js";
import type { EvalFamily } from "../model.js";
import type {
  EvidenceStrength,
  JsonValue,
  SemanticPatch,
  SkillConstraint,
} from "../skills/contract.js";
import type { ValidationOutcome } from "../skills/validate.js";
import type { SemanticTarget } from "../target.js";
import type { CaseWorkspace } from "./identity.js";

/**
 * The **case** model. A case is what turns "run a skill" from a single opaque
 * `execute(skill, context)` call into a *bounded investigation with a body*: an
 * isolated directory an executor (Claude Code, Codex, a human) works inside, with
 * a brief, the target's facts, an evidence policy, an allowed-tools contract, and
 * an expected-output schema — and a `workspace/` to think in and an `output/` to
 * deposit machine-readable results. Nothing here mutates AIR; a case only ever
 * *proposes*, and the deterministic core validates and reconciles what it emits.
 *
 * The case is deliberately phased. One undifferentiated agent should not both
 * invent and approve a result, so the investigation is split into five roles whose
 * outputs stay separate and machine-readable:
 *   research   → `output/evidence.json`           (find relevant artifacts)
 *   extract    → `output/claims.json`             (turn evidence into atomic claims)
 *   synthesize → `output/proposal.json`           (draft the patch from claims only)
 *   critique   → `output/validation-report.json`  (try to falsify every clause)
 *   test       → `output/tests.json`              (the checks that prove the change)
 */

/* -------------------------------------------------------------------------- */
/* Phases + on-disk layout                                                    */
/* -------------------------------------------------------------------------- */

export type CasePhase = "research" | "extract" | "synthesize" | "critique" | "test";

export const CASE_PHASES: readonly CasePhase[] = [
  "research",
  "extract",
  "synthesize",
  "critique",
  "test",
];

/** The role each phase plays, for rendering the brief. */
export const PHASE_ROLE: Record<CasePhase, string> = {
  research: "Researcher",
  extract: "Claim extractor",
  synthesize: "Synthesizer",
  critique: "Critic",
  test: "Test writer",
};

/** The fixed case files a materialised case carries (relative to the case dir). */
export const CASE_FILES = {
  brief: "CASE.md",
  run: "run.json",
  task: "task.json",
  target: "target.json",
  evidencePolicy: "evidence-policy.json",
  allowedTools: "allowed-tools.json",
  expectedSchema: "expected-output.schema.json",
} as const;

/** The machine-readable outputs each phase deposits (relative to the case dir). */
export const CASE_OUTPUT = {
  research: "output/evidence.json",
  extract: "output/claims.json",
  synthesize: "output/proposal.json",
  critique: "output/critique.json",
  test: "output/tests.json",
} as const satisfies Record<CasePhase, string>;

/**
 * Auxiliary outputs that are not one-per-phase: the retrieval plan the executor
 * drew up before researching, any behavioural experiments it ran, and the single
 * `result.json` that states the investigation's honest outcome (including "no
 * proposal"). These are optional — a case can close on a `result.json` alone.
 */
export const CASE_AUX = {
  searchPlan: "output/search-plan.json",
  experiments: "output/experiments.json",
  result: "output/result.json",
} as const;

/* -------------------------------------------------------------------------- */
/* Case inputs (written when a case is opened)                                */
/* -------------------------------------------------------------------------- */

/** `task.json` — the procedural brief in machine form. */
export interface CaseTask {
  /** Deterministic, collision-free case id (`${skill}--${targetKey}`, path-safe). */
  caseId: string;
  skill: string;
  skillVersion: number;
  deficiency: DeficiencyCode;
  severity: Severity;
  /** The one-line question the investigation must answer. */
  question: string;
  /** The output files the executor must produce, in phase order. */
  produce: string[];
  phases: CasePhase[];
}

/** The flat facts about one input field, denormalised for a field case. */
export interface CaseFieldFacts {
  path: string;
  name: string;
  required: boolean;
  type?: string;
  enumValues?: JsonValue[];
  existingDescription?: string;
  example?: JsonValue;
}

/**
 * `target.json` — the semantic coordinate the case acts on plus the AIR facts the
 * executor needs to investigate it, without reaching back into the whole model.
 * `priorEvidence` is the target-scoped evidence AIR already holds — the executor
 * starts from it and gathers more; it is not licence to skip investigation.
 */
export interface CaseTargetDoc {
  target: SemanticTarget;
  key: string;
  describe: string;
  operationId?: string;
  operationName?: string;
  operationEffect?: string;
  field?: CaseFieldFacts;
  siblingFields?: Array<{ name: string; description?: string }>;
  errorCode?: string;
  priorEvidence: Claim[];
}

/** `evidence-policy.json` — the evidential bar and the output boundary, as data. */
export interface EvidencePolicyDoc {
  allowedSources: EvidenceKind[];
  minimumStrength: EvidenceStrength;
  /** Output predicates: the claim predicates the patch asserts. */
  writablePredicates: string[];
  /** Supporting predicates: narrow intermediate facts an investigation may record. */
  supportingPredicates: string[];
  /** Target-relative semantic keys the executor may write. */
  writableFields: string[];
  constraints: SkillConstraint[];
  /** Prose prohibitions rendered into the brief's "you may not" list. */
  mustNot: string[];
}

/** `allowed-tools.json` — the workspace the executor may read, the rails, and the deny-list. */
export interface AllowedToolsDoc {
  /** The repository root, revision, and canonical scopes the executor may read. */
  workspace: CaseWorkspace;
  /** The `anvil case` helper commands available inside the case. */
  helpers: string[];
  /** Hard prohibitions — modifying source, inventing rules, changing structure, … */
  deny: string[];
}

/* -------------------------------------------------------------------------- */
/* Phase outputs (written by the executor)                                    */
/* -------------------------------------------------------------------------- */

/**
 * A **frozen** evidence artifact. For a filesystem source Anvil reads the exact
 * bytes at the coordinate, computes the hash, and stores the excerpt — the executor
 * never supplies an authoritative excerpt separately from the verified source
 * (`verified: true`). Non-filesystem sources carry a provided excerpt that Anvil
 * could not read back (`verified: false`). Claims reference an artifact by `id`.
 */
export interface EvidenceArtifact {
  id: string;
  uri: string;
  source: EvidenceKind;
  revision?: string;
  /** sha256 of the exact excerpt bytes. */
  contentHash: string;
  excerpt: string;
  acquiredAt: string;
  relevance?: string;
  /** Repo-relative path (filesystem sources only). */
  path?: string;
  startLine?: number;
  endLine?: number;
  /** True only when Anvil itself read the excerpt from an in-scope source. */
  verified: boolean;
}

/** `output/evidence.json` — what the Researcher found. */
export interface EvidenceReport {
  artifacts: EvidenceArtifact[];
}

/** `output/claims.json` — the Claim extractor's atomic, sourced assertions. */
export interface ClaimSet {
  claims: Claim[];
}

/**
 * `output/proposal.json` — the Synthesizer's evidence-backed patch. Shape-identical
 * to a `SkillProposal` so the existing validator/reconciler accept it unchanged.
 */
export interface CaseProposal {
  skill: string;
  skillVersion: number;
  deficiency: DeficiencyCode;
  target: SemanticTarget;
  claims: Claim[];
  patch: SemanticPatch;
}

/** The Critic's verdict on one clause of the drafted value. */
export interface ClauseVerdict {
  clause: string;
  supported: boolean;
  sourceRef?: string;
  reason: string;
}

/**
 * `output/validation-report.json` — the Critic's falsification pass plus the
 * deterministic check outcomes. `status` is `rejected` if any clause is
 * unsupported or any check failed.
 */
export interface ValidationReport {
  clauses: ClauseVerdict[];
  checks: ValidationOutcome[];
  status: "validated" | "rejected";
}

/** One check the Test writer proposes to prove the refinement. */
export interface ProposedCheck {
  family: EvalFamily;
  asserts: string;
}

/** `output/tests.json` — the checks that would demonstrate the refinement holds. */
export interface TestPlan {
  checks: ProposedCheck[];
}

/* -------------------------------------------------------------------------- */
/* Expected-output schema                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A minimal JSON-Schema description of the one output a case *must* produce — the
 * proposal — parameterised by the skill's writable fields. It is written into the
 * case as `expected-output.schema.json` so the executor (and a reviewer) can see
 * the exact contract the deterministic core will hold the output to.
 */
export function expectedOutputSchema(writableFields: string[]): Record<string, unknown> {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "case output/proposal.json",
    type: "object",
    required: ["skill", "deficiency", "target", "claims", "patch"],
    properties: {
      skill: { type: "string" },
      skillVersion: { type: "number" },
      deficiency: { type: "string" },
      target: { type: "object" },
      claims: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          required: ["subject", "predicate", "source", "confidence"],
          properties: {
            subject: { type: "string" },
            predicate: { type: "string" },
            value: {},
            source: { type: "string" },
            sourceRef: { type: "string" },
            confidence: { type: "number", minimum: 0, maximum: 1 },
          },
        },
      },
      patch: {
        type: "object",
        required: ["target", "set"],
        properties: {
          target: { type: "object" },
          set: {
            type: "object",
            description: `keys must be within: ${writableFields.join(", ") || "(none)"}`,
            propertyNames: writableFields.length > 0 ? { enum: writableFields } : undefined,
          },
        },
      },
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Parsers — the boundary between untrusted executor output and typed data    */
/* -------------------------------------------------------------------------- */

function asRecord(v: unknown, where: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Error(`${where}: expected a JSON object`);
  }
  return v as Record<string, unknown>;
}

function asClaim(v: unknown, where: string): Claim {
  const o = asRecord(v, where);
  if (typeof o.subject !== "string") throw new Error(`${where}: claim.subject must be a string`);
  if (typeof o.predicate !== "string")
    throw new Error(`${where}: claim.predicate must be a string`);
  if (typeof o.source !== "string") throw new Error(`${where}: claim.source must be a string`);
  if (typeof o.confidence !== "number")
    throw new Error(`${where}: claim.confidence must be a number`);
  return o as unknown as Claim;
}

/** Parse an executor's `output/proposal.json`, failing loudly on a malformed shape. */
export function parseCaseProposal(json: unknown): CaseProposal {
  const o = asRecord(json, "proposal");
  if (typeof o.skill !== "string") throw new Error("proposal.skill must be a string");
  if (typeof o.deficiency !== "string") throw new Error("proposal.deficiency must be a string");
  const target = asRecord(o.target, "proposal.target");
  if (typeof target.kind !== "string") throw new Error("proposal.target.kind must be a string");
  if (!Array.isArray(o.claims)) throw new Error("proposal.claims must be an array");
  const claims = o.claims.map((c, i) => asClaim(c, `proposal.claims[${i}]`));
  const patch = asRecord(o.patch, "proposal.patch");
  const set = asRecord(patch.set, "proposal.patch.set");
  return {
    skill: o.skill,
    skillVersion: typeof o.skillVersion === "number" ? o.skillVersion : 1,
    deficiency: o.deficiency as DeficiencyCode,
    target: o.target as SemanticTarget,
    claims,
    patch: {
      target: (patch.target ?? o.target) as SemanticTarget,
      set: set as Record<string, JsonValue>,
    } satisfies SemanticPatch,
  };
}

/** Parse `output/evidence.json` (tolerant: skips malformed artifacts is not allowed — fail loud). */
export function parseEvidenceReport(json: unknown): EvidenceReport {
  const o = asRecord(json, "evidence");
  if (!Array.isArray(o.artifacts)) throw new Error("evidence.artifacts must be an array");
  const artifacts = o.artifacts.map((a, i) => {
    const r = asRecord(a, `evidence.artifacts[${i}]`);
    if (typeof r.uri !== "string") throw new Error(`evidence.artifacts[${i}].uri must be a string`);
    if (typeof r.source !== "string")
      throw new Error(`evidence.artifacts[${i}].source must be a string`);
    return r as unknown as EvidenceArtifact;
  });
  return { artifacts };
}

/** Parse `output/claims.json`. */
export function parseClaimSet(json: unknown): ClaimSet {
  const o = asRecord(json, "claims");
  if (!Array.isArray(o.claims)) throw new Error("claims.claims must be an array");
  return { claims: o.claims.map((c, i) => asClaim(c, `claims.claims[${i}]`)) };
}
