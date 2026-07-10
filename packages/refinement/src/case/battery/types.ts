import type { EvidenceKind, JsonSchema } from "@anvil/air";
import type { ApprovalTier, RefinementStatus } from "../../model.js";
import type { JsonValue } from "../../skills/contract.js";
import type { InvestigationStatus } from "../investigation.js";

/**
 * The **batteries-included evaluation**: a corpus of deliberately varied field (and
 * error) scenarios run through both the deterministic executor and the case
 * investigation, so the question the design poses — "how much intelligence does the
 * investigator genuinely contribute, and which deficiency classes justify the extra
 * cost?" — is answered empirically and reproducibly, not asserted.
 *
 * Each scenario is pure data: the field/error to build, the evidence an
 * investigation would find in the "repository", the patch a synthesizer would draft
 * from it, and the outcome we expect. The runner builds a one-operation AIR, runs
 * the baseline and the investigation, and compares.
 */

export type BatterySkill = "describe-field" | "generate-examples" | "enrich-errors";

/** The deliberately varied classes the design enumerates, plus a few rail probes. */
export type ScenarioClass =
  | "documented" // explicitly documented, authoritative source
  | "implicit_impl" // meaning only implicit in the implementation
  | "only_in_tests" // visible only in tests, corroborated
  | "conflicting" // docs and code disagree → must decline
  | "generic_name" // uninformative name, no evidence
  | "sensitive" // PII/secret — meaning found, must not invent
  | "unit_bearing" // carries a unit the description must capture
  | "nested" // a field deep in a structure
  | "unused" // nothing reads it → nothing to ground
  | "weak_single_source" // one weak source, below the strength bar
  | "tautological" // evidence merely restates the name
  | "direct_example" // a schema-native example (deterministic suffices)
  | "fixture_example" // a real value only in a fixture
  | "no_example" // no value anywhere
  | "error_documented" // error meaning + retryability provable (tighten)
  | "error_loosen_weak" // weak evidence to mark retryable=true (must defer)
  | "error_undocumented"; // error with no message, groundable

export interface ScenarioEvidence {
  /** field.description | field.example | error.message | error.retryable | … */
  predicate: string;
  value: JsonValue;
  source: EvidenceKind;
  /** A source pointer; two distinct refs = two independent sources (corroboration). */
  ref: string;
  note?: string;
}

export interface FieldScenario {
  id: string;
  class: ScenarioClass;
  skill: BatterySkill;
  /** One line: what this scenario probes and the conclusion it supports. */
  probes: string;
  /** The field to build (ignored for error scenarios that set no body field). */
  field?: {
    name: string;
    required: boolean;
    schema: JsonSchema;
    in: "body" | "param";
    /** A preset description, to isolate a non-description skill from the doc detector. */
    description?: string;
  };
  /** For enrich-errors scenarios: the declared error to build. */
  error?: { code: string; message?: string; retryable?: boolean };
  /** The evidence an investigation would find — deposited via `add-evidence`. */
  repository: ScenarioEvidence[];
  /** The patch a synthesizer drafts from the evidence. Omit to model an honest decline. */
  draft?: Record<string, JsonValue>;
  /** An explicit finalize status (e.g. blocked_by_missing_source) overriding inference. */
  finalizeStatus?: InvestigationStatus;
  expected: {
    /** The investigation's `result.json` status. */
    investigation: InvestigationStatus;
    /** The coarse reconciliation outcome (robust to eval-delta noise). */
    outcome: Outcome;
    /** The approval tier, when a proposal was reconciled. */
    approval?: ApprovalTier;
  };
}

/**
 * The coarse outcome of reconciling a case's proposal — robust where the exact
 * `RefinementStatus` is not: `applied` (auto-approved), `review` (measured clean but
 * awaiting a human), `rejected` (failed validation or regressed), `none` (no proposal).
 */
export type Outcome = "applied" | "review" | "rejected" | "none";

/** Collapse a reconciled refinement status into the coarse outcome. */
export function outcomeOf(status: RefinementStatus | "none"): Outcome {
  switch (status) {
    case "approved":
      return "applied";
    case "improved":
    case "neutral":
      return "review";
    case "none":
      return "none";
    default:
      return "rejected";
  }
}

/** What the investigator contributed on one scenario, relative to the baseline. */
export type Contribution =
  | "investigation_only" // baseline could not; investigation grounded a proposal
  | "both" // both grounded one (baseline already sufficient)
  | "baseline_only" // baseline grounded one; investigation did not
  | "declined"; // neither grounded one (an honest decline)

export interface BatteryRow {
  id: string;
  class: ScenarioClass;
  skill: BatterySkill;
  probes: string;
  baselineProposed: boolean;
  investigationStatus: InvestigationStatus;
  refinementStatus: RefinementStatus | "none";
  outcome: Outcome;
  approvalTier: ApprovalTier | "none";
  contribution: Contribution;
  /** True when the observed outcome matched the scenario's expectation. */
  matchedExpectation: boolean;
}

export interface ClassSummary {
  class: ScenarioClass;
  runs: number;
  investigationClosed: number; // proposal_generated
  baselineClosed: number;
  investigationOnly: number;
  declined: number;
}

export interface BatteryReport {
  rows: BatteryRow[];
  byClass: ClassSummary[];
  totals: {
    runs: number;
    baselineClosed: number;
    investigationClosed: number;
    investigationOnly: number;
    conflictsFound: number;
    declined: number;
    mismatches: number;
  };
}
