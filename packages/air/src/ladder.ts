/**
 * The disclosure ladder: which tools a served surface shows *at rest*, and what
 * an agent has to open to see the rest.
 *
 * A compiled estate can carry thousands of approved operations. Registering one
 * tool per operation makes `tools/list` the single most expensive thing an agent
 * reads, and it pays that cost in full before it knows which one operation it
 * needs. The ladder replaces that flat list with capability entry cards: a small
 * set of lanes an agent routes on, each of which discloses its member operations
 * only once entered.
 *
 * Three properties make this safe to certify, and all three are the point:
 *
 *  1. **It is a projection, not a search.** The lanes are a pure function of the
 *     contract — no embedding index, no model deciding what to surface. Which
 *     means the served surface has a content hash, drift can diff it, and a
 *     coverage report can assert against it. A runtime-indexed tool search
 *     cannot offer any of those.
 *  2. **It never changes what is exposed.** Laddering decides *when* an approved
 *     operation's schema is disclosed, never *whether* it may be called. Every
 *     approval gate, confirmation, and idempotency rule is untouched. An
 *     unapproved operation has no lane, no entry card, and no tool.
 *  3. **It declines when it cannot help.** A surface that already fits the
 *     budget is served flat, because a ladder over nine tools costs an agent an
 *     extra round trip to save nothing. Same for an unmeasured document: with no
 *     figures there is no basis to claim a flat list is too expensive, so the
 *     behavior of every bundle compiled before measurement existed is unchanged.
 */
import {
  DEFAULT_TOOL_DISCLOSURE_BUDGET_TOKENS,
  estimateTokens,
  FALLBACK_CHARS_PER_TOKEN,
} from "./disclosure.js";
import type { AirDocument, Capability, Operation } from "./schema.js";

/**
 * Budget for the whole served surface at rest — everything in `tools/list`
 * before an agent has opened anything. Set well above a single operation's
 * budget and well below a context window: the surface is not the only thing an
 * agent holds, and a listing that consumes a quarter of the window has already
 * lost most of the argument regardless of how good the descriptions are.
 */
export const DEFAULT_SURFACE_DISCLOSURE_BUDGET_TOKENS = 20_000;

/** Why a surface is served the way it is — so a report can explain itself. */
export type LadderMode = "flat" | "laddered";

export type LadderReason =
  /** Nothing was measured, so there is no evidence the flat list is too costly. */
  | "unmeasured"
  /** The whole flat surface fits the budget; a ladder would only add latency. */
  | "fits_budget"
  /** No capability groups the operations, so there is nothing to make lanes from. */
  | "no_capabilities"
  /** Every lane would hold one operation — the ladder is pure indirection. */
  | "no_grouping_benefit"
  /**
   * Lanes group real work, but the entry cards cost at least as much as the flat
   * surface they replace. Distinct from `no_grouping_benefit`, which is about the
   * shape of the grouping; this is about the arithmetic coming out against it.
   */
  | "no_token_benefit"
  /** The flat surface exceeds the budget and lanes are available. */
  | "over_budget";

/** One lane: a capability entry card plus the operations it discloses when opened. */
export interface LadderLane {
  capabilityId: string;
  /** MCP tool name of the entry card. Deterministic and collision-checked. */
  entryToolName: string;
  displayName: string;
  /** Agent-facing summary shown on the entry card. */
  summary: string;
  /** Phrases an agent matches a request against to pick this lane. */
  routingPhrases: string[];
  /** Member operations, disclosed only once the lane is opened. */
  operationIds: string[];
  /**
   * `${effect.action} ${effect.resource}` for up to `MEMBER_VOCABULARY_LIMIT`
   * member operations, deduplicated and in `operationIds` order. A discovered
   * capability's own `description`/`intentExamples` are frequently a template
   * ("Views capability for zendesk.", "work with views") that shares no
   * vocabulary with how an agent actually asks ("list the views", "get a view
   * by id") — measured on a 640-operation estate, that gap was the majority of
   * every stage-1 routing miss (see `docs/backtesting/routing-at-scale.md`).
   * The member operations' own action/resource pairs are the one vocabulary
   * source every lane already carries regardless of how its capability was
   * authored, so `laneEntryDescription` folds them into the card.
   */
  memberVocabulary: string[];
  /** Measured cost of the operations this lane discloses; 0 when unmeasured. */
  laneTokens: number;
}

/** Cap on `LadderLane.memberVocabulary` — a card is a routing aid, not a
 *  member listing, so this stays well short of the largest lane's true
 *  member count. */
const MEMBER_VOCABULARY_LIMIT = 8;

export interface LadderPlan {
  mode: LadderMode;
  reason: LadderReason;
  lanes: LadderLane[];
  /**
   * Approved operations that belong to no lane. They stay registered at rest —
   * an operation an agent cannot reach is worse than one that costs tokens, and
   * silently hiding a callable operation behind a lane that does not exist is
   * precisely the kind of surprise the ladder must not introduce.
   */
  unlanedOperationIds: string[];
  /** Measured tokens for the surface as served: entry cards + unlaned tools. */
  restTokens: number;
  /** Measured tokens the same surface would cost registered flat. */
  flatTokens: number;
  /** How many operations carry no measurement — context for `unmeasured`. */
  unmeasuredOperations: number;
}

export interface LadderOptions {
  /** Budget for the at-rest surface. */
  surfaceBudgetTokens?: number;
  /** Per-operation budget, used to size an entry card's own disclosure. */
  toolBudgetTokens?: number;
}

/** Operations a served surface may register at all: approved, and nothing else. */
function servedOperations(air: AirDocument): Operation[] {
  return air.operations.filter((operation) => operation.state === "approved");
}

/**
 * Deterministic entry-card tool name for a capability. Dots and any character
 * outside the MCP-safe set collapse to underscores, matching how workflow tools
 * are named, with an `open_` prefix so an entry card reads as a navigation act
 * rather than as a business operation an agent might call for effect.
 */
export function laneEntryToolName(capabilityId: string): string {
  return `open_${capabilityId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/**
 * The agent-facing text of an entry card. Kept deliberately small — the card
 * exists to let an agent decide whether to pay for the lane, so it carries the
 * capability's own description, its member operations' own verb/resource
 * vocabulary, and routing phrases, and nothing else. Anything richer belongs
 * inside the lane, which is the whole point of the ladder.
 */
export function laneEntryDescription(lane: {
  displayName: string;
  summary: string;
  routingPhrases: readonly string[];
  operationIds: readonly string[];
  memberVocabulary: readonly string[];
}): string {
  const parts = [
    lane.summary || lane.displayName,
    `Opens ${lane.operationIds.length} tool(s) for ${lane.displayName}.`,
  ];
  if (lane.memberVocabulary.length > 0) {
    parts.push(`Covers: ${lane.memberVocabulary.join(", ")}.`);
  }
  if (lane.routingPhrases.length > 0) {
    parts.push(`Use for requests like: ${lane.routingPhrases.slice(0, 5).join("; ")}.`);
  }
  return parts.join(" ");
}

/** Measured tool-surface cost of an operation; 0 when it was never measured. */
function operationTokens(operation: Operation): number {
  return operation.disclosureCost?.toolTokens ?? 0;
}

/**
 * Estimate an entry card's own disclosure cost. The card is generated text
 * rather than a compiled operation, so there is no measured figure for it and
 * the serving path carries no tokenizer — this uses the same character
 * calibration the truncation failsafe does, and is capped at the per-operation
 * budget so a pathological capability description cannot make a lane cost more
 * than the tools it is standing in for.
 */
function entryCardTokens(lane: Omit<LadderLane, "laneTokens">, toolBudgetTokens: number): number {
  const text = laneEntryDescription(lane) + lane.entryToolName + lane.displayName;
  return Math.min(estimateTokens(text.length, FALLBACK_CHARS_PER_TOKEN), toolBudgetTokens);
}

/**
 * Project the ladder for a document.
 *
 * Pure and deterministic: the same contract and the same budgets always yield
 * the same lanes in the same order, which is what lets the served surface be
 * hashed, diffed for drift, and certified.
 */
export function ladderPlan(air: AirDocument, options: LadderOptions = {}): LadderPlan {
  const surfaceBudget = options.surfaceBudgetTokens ?? DEFAULT_SURFACE_DISCLOSURE_BUDGET_TOKENS;
  const toolBudget = options.toolBudgetTokens ?? DEFAULT_TOOL_DISCLOSURE_BUDGET_TOKENS;

  const served = servedOperations(air);
  const servedIds = new Set(served.map((operation) => operation.id));
  const flatTokens = served.reduce((total, operation) => total + operationTokens(operation), 0);
  const unmeasuredOperations = served.filter((operation) => !operation.disclosureCost).length;

  const flat = (reason: LadderReason): LadderPlan => ({
    mode: "flat",
    reason,
    lanes: [],
    unlanedOperationIds: served.map((operation) => operation.id),
    restTokens: flatTokens,
    flatTokens,
    unmeasuredOperations,
  });

  // With nothing measured there is no evidence the flat surface is too
  // expensive, and acting on a guess here would silently restructure every
  // pre-measurement bundle's tool list. Absence of measurement is not evidence.
  if (served.length === 0 || unmeasuredOperations === served.length) return flat("unmeasured");

  // Sorted so the projection is stable regardless of capability discovery order.
  // The `?? []` is load-bearing rather than defensive noise: `loadAirDocument`
  // fills these arrays in, but hand-built fixtures and AIR written by an older
  // Anvil reach this function without them, and a serving path that threw
  // mid-build on such a document would be a far worse regression than serving it
  // flat.
  const capabilities = [...(air.capabilities ?? [])].sort((a, b) => a.id.localeCompare(b.id));
  // Entry cards share a namespace with operation tools. A capability whose
  // generated card name collides with a real tool would shadow or be shadowed by
  // it depending on registration order — so a colliding lane is dropped and its
  // operations stay registered flat. Losing a lane costs tokens; losing a tool
  // costs the agent a capability it was approved to call.
  //
  // Cards must also be unique against EACH OTHER, and that is the subtler half:
  // the name sanitizer collapses every character outside the MCP-safe set to an
  // underscore, so `estate.payments` and `estate_payments` mint the same card.
  // Ship both and one shadows the other at registration — while the shadowed
  // lane's operations still count as laned, so they fall out of the unlaned set
  // too and become reachable through nothing at all. That is an approved
  // operation made uncallable by a layout decision, which is the one thing this
  // projection must never do. First lane by sorted id keeps the name; any later
  // claimant is demoted and its operations return to the flat surface.
  // Workflows occupy the same tool namespace as operations, and an MCP server
  // throws outright on a duplicate registration — so a card colliding with a
  // workflow does not degrade the surface, it fails the build. Their tool names
  // are derived rather than stored, so the derivation is mirrored here; keep it
  // in step with how the serving path names workflow tools.
  const workflowToolNames = (air.workflows ?? []).map((workflow) =>
    workflow.id.replace(/[^A-Za-z0-9_-]/g, "_"),
  );
  const takenNames = new Set([
    ...served.map((operation) => operation.mcp.toolName),
    ...workflowToolNames,
  ]);
  const laneCandidates: LadderLane[] = [];
  for (const capability of capabilities) {
    const lane = buildLane(capability, servedIds, air);
    if (!lane || takenNames.has(lane.entryToolName)) continue;
    takenNames.add(lane.entryToolName);
    laneCandidates.push(lane);
  }

  if (laneCandidates.length === 0) return flat("no_capabilities");

  const lanedIds = new Set(laneCandidates.flatMap((lane) => lane.operationIds));
  const unlanedOperationIds = served
    .map((operation) => operation.id)
    .filter((id) => !lanedIds.has(id));

  // Order matters here, because `reason` is read by reports and certification.
  // Fitting the budget is the *primary* reason not to ladder: when a surface is
  // already affordable, how well it groups is beside the point, and reporting a
  // grouping complaint would send an owner to restructure capabilities that were
  // never the problem.
  if (flatTokens <= surfaceBudget) return flat("fits_budget");

  // A ladder earns its extra round trip by collapsing many tools into one card.
  // When every lane holds a single operation it collapses nothing and merely
  // doubles the steps to reach the same schema.
  if (laneCandidates.every((lane) => lane.operationIds.length <= 1)) {
    return flat("no_grouping_benefit");
  }

  const entryTokens = laneCandidates.reduce(
    (total, lane) => total + entryCardTokens(lane, toolBudget),
    0,
  );
  const unlanedTokens = served
    .filter((operation) => !lanedIds.has(operation.id))
    .reduce((total, operation) => total + operationTokens(operation), 0);
  const restTokens = entryTokens + unlanedTokens;

  // "It declines when it cannot help" has to be enforced, not asserted. Nothing
  // above guarantees the ladder is cheaper: per-lane card cost is capped, but the
  // NUMBER of lanes is not, so a contract with many verbose capability
  // descriptions over cheap operations can produce an at-rest surface larger than
  // the flat one it replaced. Laddering there would charge an agent an extra round
  // trip to read MORE — indirection sold as an optimization.
  if (restTokens >= flatTokens) return flat("no_token_benefit");

  return {
    mode: "laddered",
    reason: "over_budget",
    lanes: laneCandidates,
    unlanedOperationIds,
    restTokens,
    flatTokens,
    unmeasuredOperations,
  };
}

/**
 * Build one lane, or nothing when the capability discloses no served operation.
 * Membership is intersected with the approved set rather than taken from the
 * capability as written: a capability may list operations that were never
 * approved, and a lane that advertises tools it cannot open would send an agent
 * down a dead end.
 */
function buildLane(
  capability: Capability,
  servedIds: ReadonlySet<string>,
  air: AirDocument,
): LadderLane | undefined {
  const operationIds = capability.operationIds.filter((id) => servedIds.has(id)).sort();
  if (operationIds.length === 0) return undefined;

  const byId = new Map(air.operations.map((operation) => [operation.id, operation]));
  const laneTokens = operationIds.reduce((total, id) => {
    const operation = byId.get(id);
    return total + (operation ? operationTokens(operation) : 0);
  }, 0);

  // Deduplicated in `operationIds` order (already sorted above), so the same
  // pair named by two member operations ("list ticket", "list ticket") counts
  // once and the card's limited slots go to distinct vocabulary.
  const memberVocabulary: string[] = [];
  const seenVocabulary = new Set<string>();
  for (const id of operationIds) {
    if (memberVocabulary.length >= MEMBER_VOCABULARY_LIMIT) break;
    const operation = byId.get(id);
    if (!operation) continue;
    const phrase = `${operation.effect.action} ${operation.effect.resource}`.trim();
    if (phrase === "" || seenVocabulary.has(phrase)) continue;
    seenVocabulary.add(phrase);
    memberVocabulary.push(phrase);
  }

  return {
    capabilityId: capability.id,
    entryToolName: laneEntryToolName(capability.id),
    displayName: capability.displayName,
    summary: capability.description,
    routingPhrases: capability.intentExamples,
    operationIds,
    memberVocabulary,
    laneTokens,
  };
}
