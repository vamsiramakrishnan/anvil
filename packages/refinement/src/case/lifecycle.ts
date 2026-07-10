import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hashContent } from "./identity.js";
import { CASE_AUX, CASE_OUTPUT } from "./model.js";
import { readOptionalJson, writeJson } from "./store.js";

/**
 * The **case run lifecycle** — an explicit six-state machine plus tamper-evident
 * stage freezing, kept in one file so a run's state is never spread implicitly
 * across file existence. Two concerns live here because they are the same concern:
 * a stage freeze is not a lock, it is an *integrity assertion*, and a state
 * transition is only sound if the artifacts the previous state froze have not been
 * rewritten since. So every transition re-verifies the frozen stages first.
 */

/* ------------------------------- state machine ---------------------------- */

/**
 * The states one case run moves through. `open` accepts evidence; `research_frozen`
 * has a synthesized proposal (evidence can no longer change); `proposal_frozen` has
 * a validated proposal (the proposal can no longer change); `finalized` has an
 * honest `result.json`; `closed` has been reconciled into a refinement. `failed` is
 * the terminal error state. This is a reducer, not a workflow engine.
 */
export type CaseRunState =
  | "open"
  | "research_frozen"
  | "proposal_frozen"
  | "finalized"
  | "closed"
  | "failed";

/** The two artifact stages a run freezes: the evidence+claims, then the proposal. */
export type CaseStage = "research" | "synthesis";

interface StageRecord {
  hash: string;
  frozenAt: string;
}

/** The outcome `validate-proposal` recorded — distinct from `proposal_frozen`, which
 * only says the proposal can no longer change, not whether it passed. */
export interface ProposalValidationRecord {
  status: "validated" | "rejected";
  at: string;
}

interface LifecycleDoc {
  state: CaseRunState;
  stages: Partial<Record<CaseStage, StageRecord>>;
  history: Array<{ state: CaseRunState; at: string }>;
  proposalValidation?: ProposalValidationRecord;
}

/**
 * The legal forward transitions. `finalize` may be reached from any pre-terminal
 * state (an investigation can honestly decline before it ever synthesizes), and any
 * state may fail. Everything else is a straight line, so an out-of-order transition
 * (validating before synthesizing, closing before finalizing) is rejected loudly.
 */
const ALLOWED: Record<CaseRunState, CaseRunState[]> = {
  open: ["research_frozen", "finalized", "failed"],
  research_frozen: ["proposal_frozen", "finalized", "failed"],
  proposal_frozen: ["finalized", "failed"],
  finalized: ["closed", "failed"],
  closed: [],
  failed: [],
};

/** The files that constitute each stage's frozen content (order matters for hashing). */
const STAGE_FILES: Record<CaseStage, string[]> = {
  research: [CASE_OUTPUT.research, CASE_OUTPUT.extract],
  synthesis: [CASE_OUTPUT.synthesize],
};

function readLifecycle(dir: string): LifecycleDoc {
  return (
    readOptionalJson<LifecycleDoc>(dir, CASE_AUX.lifecycle) ?? {
      state: "open",
      stages: {},
      history: [],
    }
  );
}

/** The current lifecycle state of a run (a fresh run is `open`). */
export function currentState(dir: string): CaseRunState {
  return readLifecycle(dir).state;
}

/**
 * Move a run to `to`, or throw if the transition is not legal from the current
 * state. Records the transition in the run's history so the lifecycle is auditable.
 * Terminal `finalized`/`closed`/`failed` do not create workflow engines — this is a
 * six-state reducer that makes error handling and resumability explicit.
 */
export function transition(dir: string, to: CaseRunState, now?: number): void {
  const doc = readLifecycle(dir);
  if (doc.state === to) return;
  if (!ALLOWED[doc.state].includes(to)) {
    throw new Error(
      `Illegal case transition ${doc.state} → ${to}. Allowed from ${doc.state}: ${
        ALLOWED[doc.state].join(", ") || "(none — terminal)"
      }.`,
    );
  }
  const at = new Date(now ?? Date.now()).toISOString();
  doc.state = to;
  doc.history.push({ state: to, at });
  writeJson(dir, CASE_AUX.lifecycle, doc);
}

/* ---------------------------- proposal validation -------------------------- */

/** Record the outcome of validate-proposal in the lifecycle doc — distinct from the state name, so a reader always knows whether the frozen proposal passed or failed. */
export function recordProposalValidation(
  dir: string,
  status: "validated" | "rejected",
  now?: number,
): void {
  const doc = readLifecycle(dir);
  doc.proposalValidation = { status, at: new Date(now ?? Date.now()).toISOString() };
  writeJson(dir, CASE_AUX.lifecycle, doc);
}

/** The recorded proposal-validation outcome, if `validate-proposal` has run. */
export function readProposalValidation(dir: string): ProposalValidationRecord | undefined {
  return readLifecycle(dir).proposalValidation;
}

/* -------------------------------- stages ---------------------------------- */

/**
 * The hash of a stage's frozen content: the exact bytes of its output files. This is
 * what makes a freeze tamper-evident — recomputing it later and finding a different
 * value means `evidence.json`, `claims.json`, or `proposal.json` was edited after
 * the freeze. Missing files contribute the empty string, so a stage frozen before an
 * optional file exists still verifies.
 */
function stageHash(dir: string, stage: CaseStage): string {
  const bytes = STAGE_FILES[stage].map((rel) => {
    const full = join(dir, rel);
    return existsSync(full) ? readFileSync(full, "utf8") : "";
  });
  return hashContent(bytes.join("\0"));
}

/** Has a stage been frozen for this run? */
export function isStageFrozen(dir: string, stage: CaseStage): boolean {
  return Boolean(readLifecycle(dir).stages[stage]);
}

/**
 * Freeze a stage: record a content hash of its output files so any later edit is
 * detectable. A freeze is an integrity assertion, not a lock — it does not prevent a
 * write, it makes one visible at the next transition.
 */
export function freezeStage(dir: string, stage: CaseStage, now?: number): void {
  const doc = readLifecycle(dir);
  doc.stages[stage] = {
    hash: stageHash(dir, stage),
    frozenAt: new Date(now ?? Date.now()).toISOString(),
  };
  writeJson(dir, CASE_AUX.lifecycle, doc);
}

/**
 * Verify a frozen stage still hashes to what was recorded, throwing if not. A stage
 * that was never frozen verifies vacuously. Call this before every state transition
 * that consumes a frozen stage (validation, finalization, close) so a rewritten
 * `evidence.json`/`claims.json`/`proposal.json` can never slip past unnoticed.
 */
export function verifyFrozenStage(dir: string, stage: CaseStage): void {
  const record = readLifecycle(dir).stages[stage];
  if (!record) return;
  if (stageHash(dir, stage) !== record.hash) {
    throw new Error(
      `Frozen ${stage} stage was modified after it was frozen (${STAGE_FILES[stage].join(
        ", ",
      )}). Its integrity assertion no longer holds; refusing to proceed.`,
    );
  }
}

/** Verify every frozen stage at once — the guard before finalize and close. */
export function verifyFrozenStages(dir: string): void {
  verifyFrozenStage(dir, "research");
  verifyFrozenStage(dir, "synthesis");
}
