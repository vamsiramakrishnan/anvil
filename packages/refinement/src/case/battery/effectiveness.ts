import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type AirDocument, loadAirDocument } from "@anvil/air";
import { buildRefinementPlan } from "../../plan.js";
import { skillFor } from "../../skills/registry.js";
import { targetKey } from "../../target.js";
import type { AgentDriver } from "../driver.js";
import { closeCase, readInvestigation } from "../executor.js";
import type { InvestigationStatus } from "../investigation.js";
import { openCase } from "../materialize.js";
import type { BatterySkill } from "./types.js";

/**
 * The **investigator effectiveness battery** — the opt-in, real-driver benchmark the
 * design calls for. Unlike the protocol-conformance suite (which scripts the agent to
 * prove mechanics), this invokes an actual coding-agent driver against a repository
 * fixture and measures *how good the investigation is*. It is excluded from unit CI
 * (it needs a real agent binary and is slow) and, crucially, the expected-answer
 * LABELS are held in this evaluator-owned structure — never written into the
 * repository the agent may inspect — so it measures investigation, not answer
 * extraction.
 *
 * The primary metrics are grounded-proposal precision, correct-decline rate,
 * conflict-detection recall, and unsupported-claim rate. Proposal *rate* is
 * deliberately NOT a headline: a high proposal rate can mean the investigator guesses.
 */

/** The taxonomy the 30 cases are grouped under (design §13). */
export type EffectivenessCategory =
  | "explicit_evidence"
  | "distributed_evidence"
  | "ambiguity"
  | "conflict"
  | "safety_sensitivity"
  | "structural_complexity";

/** The evaluator-owned labels for a case — the answer key the agent never sees. */
export interface CaseLabels {
  expectedOutcome: InvestigationStatus;
  /** Source coordinates the investigation *should* have found (path#Lx-Ly). */
  expectedEvidence: string[];
  /** Predicate values the investigation must NOT assert (would be unsupported). */
  forbiddenClaims?: string[];
  /** Any of these descriptions is an acceptable grounded answer. */
  acceptableDescriptions?: string[];
}

export interface EffectivenessCase {
  id: string;
  category: EffectivenessCategory;
  skill: BatterySkill;
  /** The repository fixture written into the agent's inspect scope (path → content). */
  repoFiles: Record<string, string>;
  /** The field to build the AIR target from. */
  field?: {
    name: string;
    required: boolean;
    schema: Record<string, unknown>;
    in: "body" | "param";
  };
  error?: { code: string };
  /** Evaluator-owned answer key — NOT written into the repository fixture. */
  labels: CaseLabels;
}

const OP_ID = "bench.op";

function buildAir(c: EffectivenessCase): AirDocument {
  const params: unknown[] = [];
  let body: unknown;
  const errors: unknown[] = [];
  if (c.field) {
    const f = { name: c.field.name, required: c.field.required, schema: c.field.schema };
    if (c.field.in === "param") params.push({ in: "query", ...f });
    else body = { projection: "fields", fields: [f] };
  }
  if (c.error) errors.push({ code: c.error.code });
  return loadAirDocument({
    service: { id: "bench", version: "2026-07-10", source: { kind: "openapi", uri: "./b.yaml" } },
    operations: [
      {
        id: OP_ID,
        canonicalName: "do_thing",
        description: "A benchmark operation.",
        sourceRef: { kind: "openapi", path: "/thing", method: "post" },
        effect: { kind: "mutation", action: "create", risk: "low", reversible: true },
        input: { params, ...(body ? { body } : {}) },
        errors,
        idempotency: { mode: "required", mechanism: "header", header: "Idempotency-Key" },
        retries: { mode: "safe" },
        confirmation: { required: true },
        auth: { type: "api_key" },
        cli: { command: "bench do thing" },
        mcp: { toolName: "bench_do_thing" },
        skill: { intentExamples: ["Do the thing."] },
      },
    ],
  });
}

export interface EffectivenessRow {
  id: string;
  category: EffectivenessCategory;
  expected: InvestigationStatus;
  observed: InvestigationStatus;
  outcomeCorrect: boolean;
  /** For a proposal: did every asserted value stay grounded (no unsupported claims)? */
  grounded: boolean;
  unsupportedClaims: number;
  /** Fraction of labelled evidence coordinates the investigation actually cited. */
  evidenceRecall: number;
  conflictExpected: boolean;
  conflictFound: boolean;
}

/**
 * Run one effectiveness case: write the repository fixture, open a case scoped to it,
 * drive the REAL agent, then score the structured result against the hidden labels.
 * The labels are never written to disk inside the agent's scope.
 */
export async function runEffectivenessCase(
  c: EffectivenessCase,
  driver: AgentDriver,
  options: { root?: string } = {},
): Promise<EffectivenessRow> {
  const repo = mkdtempSync(join(tmpdir(), "anvil-eff-repo-"));
  for (const [rel, content] of Object.entries(c.repoFiles)) {
    const full = join(repo, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf8");
  }

  const air = buildAir(c);
  const plan = buildRefinementPlan(air);
  const deficiency = plan.deficiencies.find((d) => skillFor(d.code)?.name === c.skill);
  if (!deficiency) throw new Error(`case '${c.id}': no ${c.skill} deficiency built`);

  const root = options.root ?? mkdtempSync(join(tmpdir(), "anvil-eff-cases-"));
  const { dir } = openCase(air, deficiency, {
    root,
    repositoryRoot: repo,
    inspect: ["."],
    executor: driver.name,
  });
  await driver.run(dir);

  const result = readInvestigation(dir);
  const refinement = result.status === "proposal_generated" ? closeCase(air, dir) : undefined;

  const citedUris = new Set(result.artifacts.map((a) => a.uri));
  const expected = c.labels.expectedEvidence;
  const evidenceRecall = expected.length
    ? expected.filter((e) => [...citedUris].some((u) => u.includes(e) || e.includes(u))).length /
      expected.length
    : 1;
  const forbidden = new Set(c.labels.forbiddenClaims ?? []);
  const unsupportedClaims = result.claims.filter((cl) => forbidden.has(String(cl.value))).length;

  return {
    id: c.id,
    category: c.category,
    expected: c.labels.expectedOutcome,
    observed: result.status,
    outcomeCorrect: result.status === c.labels.expectedOutcome,
    grounded: refinement ? refinement.status !== "rejected" && unsupportedClaims === 0 : true,
    unsupportedClaims,
    evidenceRecall,
    conflictExpected: c.labels.expectedOutcome === "conflicted",
    conflictFound: result.conflicts.length > 0,
  };
}

export interface EffectivenessMetrics {
  cases: number;
  /** Of proposals made, the fraction that are correct AND fully grounded. */
  groundedProposalPrecision: number;
  /** Of cases that should decline, the fraction that did. */
  correctDeclineRate: number;
  /** Of cases with a real conflict, the fraction detected. */
  conflictDetectionRecall: number;
  /** Fraction of all cases that emitted at least one unsupported claim. */
  unsupportedClaimRate: number;
  /** Mean evidence recall against the labelled coordinates. */
  meanEvidenceRecall: number;
  outcomeAccuracy: number;
}

const DECLINE_STATUSES = new Set<InvestigationStatus>([
  "conflicted",
  "insufficient_evidence",
  "blocked_by_missing_source",
  "supported",
]);

/**
 * Aggregate rows into the primary effectiveness metrics. Note what is measured and
 * what is deliberately not: there is no "proposal rate" headline, because guessing
 * more often is not better.
 */
export function effectivenessMetrics(rows: EffectivenessRow[]): EffectivenessMetrics {
  const n = rows.length || 1;
  const proposals = rows.filter((r) => r.observed === "proposal_generated");
  const shouldDecline = rows.filter((r) => DECLINE_STATUSES.has(r.expected));
  const declined = shouldDecline.filter((r) => DECLINE_STATUSES.has(r.observed));
  const conflicts = rows.filter((r) => r.conflictExpected);
  return {
    cases: rows.length,
    groundedProposalPrecision: proposals.length
      ? proposals.filter((r) => r.outcomeCorrect && r.grounded).length / proposals.length
      : 1,
    correctDeclineRate: shouldDecline.length ? declined.length / shouldDecline.length : 1,
    conflictDetectionRecall: conflicts.length
      ? conflicts.filter((r) => r.conflictFound).length / conflicts.length
      : 1,
    unsupportedClaimRate: rows.filter((r) => r.unsupportedClaims > 0).length / n,
    meanEvidenceRecall: rows.reduce((a, r) => a + r.evidenceRecall, 0) / n,
    outcomeAccuracy: rows.filter((r) => r.outcomeCorrect).length / n,
  };
}
