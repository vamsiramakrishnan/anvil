import type {
  AirDocument,
  LadderLane,
  LadderMode,
  LadderOptions,
  LadderPlan,
  LadderReason,
  Operation,
} from "@anvil/air";
import { ladderPlan } from "@anvil/air";

/**
 * Tokens-to-reach — the number that makes the disclosure ladder falsifiable.
 *
 * `measureToolSurface` prices one tool. `ladderPlan` decides which tools are
 * shown at rest. Neither answers the question a ladder is actually built to
 * improve: **starting cold, how much must an agent read before the full input
 * schema of the one operation it needs is in its context?** On a flat surface
 * that is the entire listing, every time, for every operation — the agent pays
 * for 900 tools to call one. Under a ladder it is the entry cards plus the one
 * lane it opened. The ratio between those two is the whole claim, and until it
 * is a measured figure the ladder is a feature nobody can prove worked.
 *
 * ## Why this measures the surface and not a model
 *
 * The tempting version of this metric drives a real agent and counts tokens to
 * first correct call. That measures the wrong system. It is non-deterministic,
 * so it cannot gate a build; it is priced per run, so nobody runs it; and most
 * of its variance is the model's cleverness at guessing from tool names, which
 * is precisely the guessing Anvil exists to make unnecessary. Worse, a metric
 * that moves when an unrelated model ships cannot distinguish "our surface got
 * cheaper" from "the model got luckier".
 *
 * So tokens-to-reach is a pure function of (contract, ladder plan). Same AIR and
 * same budgets, same figure, forever — the same property that lets a disclosure
 * cost be certified at all. It bounds what the agent must read; it does not
 * predict what a particular agent will do. That distinction is stated here
 * rather than buried, because a reach figure is a *floor on the reading cost*,
 * not a promise about behavior.
 *
 * ## Why hops are reported next to tokens
 *
 * The ladder does not make context free — it trades round trips for tokens. An
 * agent on a laddered surface reads the cards, calls one entry tool, and only
 * then holds the schema it wanted: two hops instead of one. A report that shows
 * the token saving and hides the extra round trip is selling half the trade, and
 * the half it hides is the half that costs latency. Both travel together here.
 *
 * ## Why unmeasured is a state and not a zero
 *
 * An operation with no `disclosureCost` contributes nothing to a sum. Summed
 * blindly, a document nobody measured reports "0 tokens to reach" — a number
 * that looks like a spectacular result and means the opposite. Every figure this
 * module produces is therefore either measured or absent: `unmeasured` marks a
 * target whose own schema cost is unknown, `unmeasuredOnPath` marks a total that
 * is only a lower bound, and a profile with nothing measured returns no figures
 * at all rather than a confident zero.
 */

/**
 * Which surface a reach figure was taken over. Always the surface the plan says
 * will actually be *served* — never a hypothetical. Costing a ladder for a
 * document that will be served flat would publish a saving no agent receives.
 */
export type ReachBasis = LadderMode;

/** What it costs one agent, starting cold, to reach one operation's schema. */
export interface ReachMeasurement {
  operationId: string;
  /**
   * Measured tokens on the reading path. When `unmeasured` is true this is the
   * path *without* the target's own disclosure, because that figure does not
   * exist — it is never silently treated as zero-cost.
   */
  tokens: number;
  /** Round trips before the schema is in context: `tools/list`, plus any lane opened. */
  hops: number;
  basis: ReachBasis;
  /** The target operation carries no measurement, so `tokens` omits its schema. */
  unmeasured: boolean;
  /**
   * How many operations on this reading path were never measured. Non-zero makes
   * `tokens` a lower bound that can only grow — the same honesty the capability
   * token budget applies when it reports "measured 9 of 20".
   */
  unmeasuredOnPath: number;
}

export interface ReachOptions extends LadderOptions {
  /**
   * A plan already projected for this document. Reach is per-operation but the
   * plan is per-document, so re-projecting it inside a loop would make a whole
   * estate's profile quadratic in operations for no new information.
   */
  plan?: LadderPlan;
}

/** The reach distribution over a whole served surface. */
export interface ReachProfile {
  /** The plan every figure below was taken over, and why it came out that way. */
  mode: LadderMode;
  reason: LadderReason;
  /** Approved operations — the only ones a served surface may register at all. */
  operations: number;
  /** Of those, how many carry a disclosure measurement. */
  measured: number;
  /**
   * True when some served operation was never measured. Every token figure below
   * is then a floor, not a total.
   */
  lowerBound: boolean;
  /** Round trips to reach an operation, across the served surface. */
  hops: { min: number; max: number };
  /** Cheapest / typical / most expensive operation to reach, in tokens. */
  best?: number;
  median?: number;
  worst?: number;
  /**
   * Which operations those are — so a failing gate points at something. Reach is
   * a property of a lane, not of one tool, so every member of a lane ties and
   * these name that lane's first member by id: a stable representative to look
   * up, never a claim that one operation is solely responsible.
   */
  bestOperationId?: string;
  worstOperationId?: string;
  /**
   * What reaching *any* operation costs on a flat surface. One scalar, because
   * flat has no per-operation variation: the agent reads the whole listing to
   * reach anything in it. This is the denominator the ladder has to beat.
   */
  flatBaseline?: number;
  /**
   * The typical served reach — the median, not the mean. A mean over lanes is
   * dragged around by one fat lane and reads as if every operation got worse;
   * the median answers "what does an ordinary operation cost now". When the plan
   * declined to ladder this equals `flatBaseline`, because the surface that will
   * be served *is* the flat one and claiming a saving nobody receives is the
   * class of number this module exists to prevent.
   */
  ladderedBaseline?: number;
  /** `flatBaseline / ladderedBaseline`: what the typical operation saves. */
  improvementRatio?: number;
  /**
   * `flatBaseline / worst`: what the *most expensive* operation saves. The
   * guarantee, as opposed to the advertisement — a ladder whose median looks
   * excellent while one lane is nearly the whole estate has not solved the
   * problem for an agent that needs that lane.
   */
  worstCaseRatio?: number;
}

/** Operations a served surface may register at all: approved, and nothing else. */
function servedOperations(air: AirDocument): Operation[] {
  return air.operations.filter((operation) => operation.state === "approved");
}

function isMeasured(operation: Operation): boolean {
  return operation.disclosureCost !== undefined;
}

/**
 * Ratios are rounded to three places for the same reason `charsPerToken` is: a
 * figure that lands in a report or a hash must not churn on float noise that
 * carries no meaning.
 */
function ratio(numerator: number, denominator: number): number | undefined {
  if (denominator <= 0) return undefined;
  return Math.round((numerator / denominator) * 1000) / 1000;
}

/**
 * Resolve the plan once. Callers that already hold one pass it through; the
 * budgets are forwarded verbatim so a profile can never be computed against a
 * different surface than the one the caller asked about.
 */
function planFor(air: AirDocument, options: ReachOptions): LadderPlan {
  return options.plan ?? ladderPlan(air, options);
}

/**
 * Everything about a plan that is the same for every operation, resolved once.
 *
 * Reach is asked per operation but almost nothing it needs varies per operation:
 * lane membership is an inversion of a list the plan already holds, and the two
 * unmeasured tallies are properties of the at-rest surface and of a lane. An
 * estate profile walks thousands of operations, and recomputing these inside
 * that walk would make a linear report quadratic for no new information.
 */
interface ReachIndex {
  laneOf: ReadonlyMap<string, LadderLane>;
  /**
   * Operations disclosed at rest with no measurement. Entry cards never appear
   * here — they are generated text the plan estimates directly, not an operation
   * someone forgot to measure — so on a laddered plan this counts only the tools
   * that stayed registered, and on a flat plan the whole served set.
   */
  unmeasuredAtRest: number;
  unmeasuredInLane: ReadonlyMap<string, number>;
}

function buildIndex(plan: LadderPlan, byId: ReadonlyMap<string, Operation>): ReachIndex {
  const missing = (ids: readonly string[]): number =>
    ids.filter((id) => {
      const operation = byId.get(id);
      return operation !== undefined && !isMeasured(operation);
    }).length;

  const laneOf = new Map<string, LadderLane>();
  const unmeasuredInLane = new Map<string, number>();
  for (const lane of plan.lanes) {
    for (const id of lane.operationIds) laneOf.set(id, lane);
    unmeasuredInLane.set(lane.capabilityId, missing(lane.operationIds));
  }

  return {
    laneOf,
    unmeasuredAtRest:
      plan.mode === "flat" ? plan.unmeasuredOperations : missing(plan.unlanedOperationIds),
    unmeasuredInLane,
  };
}

/**
 * Reach for one operation against an already-resolved plan and index. Kept
 * separate from the exported entry point so a profile pays for both once.
 */
function reachAgainst(operation: Operation, plan: LadderPlan, index: ReachIndex): ReachMeasurement {
  const unmeasured = !isMeasured(operation);
  const base = { operationId: operation.id, basis: plan.mode, unmeasured };

  // Flat: one `tools/list` puts every schema in context, including the target's.
  // There is nothing cheaper to read and nothing further to open, which is
  // exactly the problem — the cost of reaching one operation is the cost of the
  // whole estate, and it does not improve by knowing which operation you want.
  if (plan.mode === "flat") {
    return { ...base, tokens: plan.flatTokens, hops: 1, unmeasuredOnPath: index.unmeasuredAtRest };
  }

  const lane = index.laneOf.get(operation.id);

  // Laddered but unlaned: the operation stayed registered at rest, so its schema
  // arrives with the entry cards and costs no second hop. `restTokens` and not
  // just the target's own cost, because an agent cannot read one tool out of a
  // listing — it receives all of them.
  if (!lane) {
    return { ...base, tokens: plan.restTokens, hops: 1, unmeasuredOnPath: index.unmeasuredAtRest };
  }

  // Laddered and laned: the cards (and any unlaned tools that ride along in the
  // same listing) plus the whole lane. The whole lane, not the target alone —
  // opening a lane discloses every member, so charging only the target would
  // publish a saving the serving path does not deliver.
  return {
    ...base,
    tokens: plan.restTokens + lane.laneTokens,
    hops: 2,
    unmeasuredOnPath: index.unmeasuredAtRest + (index.unmeasuredInLane.get(lane.capabilityId) ?? 0),
  };
}

/**
 * What it costs an agent, starting cold, to hold `operationId`'s input schema.
 *
 * Throws rather than returning a number for an operation that is not on the
 * served surface. An unapproved or unknown operation has no disclosure, no lane,
 * and no tool — "how many tokens to reach it" has no answer, and any number
 * returned here would be read as one. Use {@link reachProfile} to walk a whole
 * document; it iterates the served set by construction.
 */
export function tokensToReach(
  air: AirDocument,
  operationId: string,
  options: ReachOptions = {},
): ReachMeasurement {
  const operation = air.operations.find((candidate) => candidate.id === operationId);
  if (!operation) throw new Error(`Unknown operation '${operationId}'.`);
  if (operation.state !== "approved") {
    throw new Error(
      `Operation '${operationId}' is ${operation.state}, so it is not on the served surface and cannot be reached.`,
    );
  }

  const plan = planFor(air, options);
  const byId = new Map(servedOperations(air).map((candidate) => [candidate.id, candidate]));
  return reachAgainst(operation, plan, buildIndex(plan, byId));
}

/**
 * Reach for every served operation, in the document's operation order so the
 * result is stable and diffable across builds.
 */
export function reachMeasurements(
  air: AirDocument,
  options: ReachOptions = {},
): ReachMeasurement[] {
  const plan = planFor(air, options);
  const served = servedOperations(air);
  const index = buildIndex(plan, new Map(served.map((operation) => [operation.id, operation])));
  return served.map((operation) => reachAgainst(operation, plan, index));
}

/**
 * The distribution of reach across a served surface, and what the ladder bought.
 *
 * Only measured operations enter the distribution. Including an unmeasured one
 * would fold a target of unknown cost into a percentile as though it were cheap,
 * which is how a coverage number becomes confidently wrong; its absence is
 * reported through `measured` and `lowerBound` instead.
 */
export function reachProfile(air: AirDocument, options: ReachOptions = {}): ReachProfile {
  const plan = planFor(air, options);
  const measurements = reachMeasurements(air, { ...options, plan });
  // An empty served surface has no round trips to report, and seeding the spread
  // with 0 would understate the minimum on every non-empty one.
  const hopValues = measurements.map((measurement) => measurement.hops);
  const base = {
    mode: plan.mode,
    reason: plan.reason,
    operations: measurements.length,
    measured: measurements.filter((measurement) => !measurement.unmeasured).length,
    lowerBound: measurements.some((measurement) => measurement.unmeasured),
    hops:
      hopValues.length === 0
        ? { min: 0, max: 0 }
        : { min: Math.min(...hopValues), max: Math.max(...hopValues) },
  };

  // Nothing measured: there is no flat baseline to divide by and no distribution
  // to describe. Reporting zeros here would claim a perfect surface for a
  // document nobody has priced, so every figure is simply absent.
  const scored = measurements
    .filter((measurement) => !measurement.unmeasured)
    .sort((a, b) => a.tokens - b.tokens || a.operationId.localeCompare(b.operationId));
  const best = scored[0];
  const worst = scored[scored.length - 1];
  // Lower median on an even count: an integer that is a reach some real
  // operation actually has, rather than an interpolated figure belonging to none
  // of them. Deterministic, and it survives a serialization round trip intact.
  const median = scored[Math.floor((scored.length - 1) / 2)];
  if (!best || !worst || !median) return base;

  // On a flat plan the served surface *is* the flat surface, so the two
  // baselines coincide and the ratio is 1 by construction — the honest report of
  // "the ladder declined, and here is what that costs you".
  const flatBaseline = plan.flatTokens;
  const ladderedBaseline = median.tokens;

  return {
    ...base,
    best: best.tokens,
    median: median.tokens,
    worst: worst.tokens,
    bestOperationId: best.operationId,
    worstOperationId: worst.operationId,
    flatBaseline,
    ladderedBaseline,
    improvementRatio: ratio(flatBaseline, ladderedBaseline),
    worstCaseRatio: ratio(flatBaseline, worst.tokens),
  };
}
