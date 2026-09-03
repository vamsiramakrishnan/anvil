import {
  type AirDocument,
  type LadderLane,
  type LadderPlan,
  ladderPlan,
  laneEntryDescription,
  type Operation,
} from "@anvil/air";

/**
 * The disclosure ladder, served.
 *
 * `@anvil/air` decides *what* the ladder is — which lanes exist, which
 * operations each one holds, and whether laddering earns its round trip at all.
 * This module is the other half: it turns that projection into behavior on a
 * live MCP server. It holds no policy of its own, and that is deliberate. A
 * serving path that reasoned independently about which operations to show could
 * disagree with the plan the certification pass hashed, and a served surface
 * that differs from the certified one is worse than no ladder at all.
 *
 * What laddering changes: *when* an approved operation's schema appears in
 * `tools/list`. What it never changes: whether that operation may be called, by
 * whom, with what confirmation, under which idempotency rule. Those are decided
 * on the call path in `@anvil/runtime` and nothing here can reach them — an
 * unapproved operation has no tool to disclose in the first place, so it has no
 * lane, no card, and no way to be opened into existence.
 */

/**
 * Operator control over the ladder.
 *
 *  - `auto` (default) serves whatever `ladderPlan` projects. The plan already
 *    declines when it cannot help, so this is the setting that needs no thought.
 *  - `flat` never ladders. The escape hatch: an operator whose client does not
 *    honor `tools/list_changed` needs one setting that makes the surface behave
 *    like it did before, not a budget they have to reverse-engineer.
 *  - `laddered` ladders whenever the projection can produce lanes at all —
 *    useful for a test that wants deterministic laddering, and for an operator
 *    who would rather pay a round trip than a listing on a surface that happens
 *    to sit just inside the budget.
 */
export type DisclosureMode = "auto" | "flat" | "laddered";

/**
 * The measured routing trade-off `auto` mode can consult, read from an
 * `anvil benchmark --catalog both` report for THIS bundle. Deliberately just
 * two numbers rather than the report type itself: `@anvil/air`'s `ladderPlan`
 * already measures the token side of the trade from the live document
 * (`plan.flatTokens`/`plan.restTokens`), so only the side nothing here can
 * derive — accuracy, which requires actually routing tasks — needs to be
 * carried in. This keeps `@anvil/mcp-runtime` free of any dependency on
 * `@anvil/refinement` (which owns `BenchmarkReport`), matching the same
 * boundary `@anvil/air` already holds (see `ladder.ts`'s header): the CLI/serve
 * path reads the report and passes the two numbers through, it never reaches
 * this deep.
 */
export interface LadderMeasuredAccuracy {
  /**
   * The laddered catalog's routing accuracy minus the flat catalog's, in
   * points of task share, from the report's `catalogs.laddered.accuracy` /
   * `catalogs.flat.accuracy` (e.g. `47.7 - 58.9 = -11.2`). Positive means the
   * ladder routed better than the flat surface it replaces.
   */
  ladderedMinusFlatPts: number;
}

export interface LadderServeOptions {
  disclosure?: DisclosureMode;
  /** Override the at-rest surface budget the projection measures against. */
  surfaceBudgetTokens?: number;
  /**
   * A measured accuracy delta for this bundle, when one exists. Only ever
   * consulted in `auto` mode (`flat` and `laddered` stay operator overrides,
   * unconditioned on measurement — see `DisclosureMode`'s own doc). Omitting
   * this — the case for every bundle that has never been benchmarked —
   * reproduces `auto`'s pre-measurement behavior exactly: ladder whenever the
   * projection says `over_budget`, unconditioned on accuracy. See
   * `decideLadder` for the bars this gates.
   */
  measuredAccuracy?: LadderMeasuredAccuracy;
}

/**
 * Why `laddered` came out the way it did — one level more specific than
 * `plan.reason`, which only ever describes the *projection*, never an `auto`
 * override made on top of it.
 *
 *  - `"plan"` — this decision follows `plan.reason` unmodified: a `flat`/
 *    `laddered` operator override, or `auto` with nothing to weigh (no
 *    accuracy measurement, or the plan itself declined to ladder).
 *  - `"token_savings_below_floor"` — `auto` would have laddered per the
 *    projection, but the measured token reduction did not clear
 *    `MIN_LADDER_TOKEN_SAVINGS_FRACTION`, so this server serves flat.
 *  - `"accuracy_below_floor"` — `auto` would have laddered per the
 *    projection and the token bar, but the measured laddered-minus-flat
 *    accuracy delta fell below `MIN_LADDERED_ACCURACY_DELTA_PTS`, so this
 *    server serves flat.
 */
export type LadderDecisionReason = "plan" | "token_savings_below_floor" | "accuracy_below_floor";

export interface LadderDecision {
  /**
   * The projection as it came out, unmodified — the figures a report or a
   * certification pass should cite, including when the operator overrode the
   * outcome. What was decided and what was served stay separately readable.
   */
  plan: LadderPlan;
  /** Whether this server will actually ladder. */
  laddered: boolean;
  /** The lanes to serve; empty unless `laddered`. */
  lanes: readonly LadderLane[];
  /** Why `laddered` came out the way it did — see `LadderDecisionReason`. */
  decisionReason: LadderDecisionReason;
}

/** How much of an operation's own description a lane card carries. */
const LANE_SUMMARY_CHARS = 200;

/**
 * The token-savings floor `auto` applies to a laddered plan once a measured
 * accuracy report exists for the bundle: at-rest tokens must drop by at least
 * half, or `auto` serves flat regardless of accuracy. `ladderPlan` already
 * refuses to ladder when the at-rest surface is not STRICTLY cheaper
 * (`no_token_benefit`), but "cheaper by a sliver" still costs an agent the
 * extra round trip the header comment describes, and every measured reduction
 * on the Zendesk estate (`docs/backtesting/routing-at-scale.md`, Result 3) is
 * 8x-16x — an order of magnitude clear of this bar. Below it, the trade is not
 * obviously worth an accuracy hit, so this only fires once there is an
 * accuracy number to weigh against; without one, `auto` still ladders on
 * `ladderPlan`'s own arithmetic exactly as it always has.
 */
export const MIN_LADDER_TOKEN_SAVINGS_FRACTION = 0.5;

/**
 * The accuracy floor `auto` applies once a measured report exists: a laddered
 * catalog may trail the flat one by at most this many points of task share.
 * Drawn directly from the two regimes `docs/backtesting/routing-at-scale.md`
 * measured on the same estate, not guessed: folding member vocabulary alone
 * into the entry card (the first stage-1 lever) trailed flat by 8.2-15.3
 * points at every measured size and is exactly the surface this floor should
 * refuse; also folding member intent examples in (the second lever) cut that
 * gap to at most 6.8 points, beating flat outright at 50 tools, and is
 * exactly the surface this floor should allow. -8 sits on the line between
 * those two measured regimes.
 */
export const MIN_LADDERED_ACCURACY_DELTA_PTS = -8;

/**
 * Decide whether this server ladders, and over which lanes.
 *
 * Pure: the same document, budget, mode and measured accuracy always produce
 * the same lanes in the same order, which is what lets the served surface be
 * hashed and diffed for drift. Nothing here reads a clock or a random source.
 */
export function decideLadder(air: AirDocument, options: LadderServeOptions = {}): LadderDecision {
  const mode = options.disclosure ?? "auto";

  // AIR reaches the serving path from a bundle, a test fixture, or an operator's
  // hand-edited file, and the last two routinely skip the parse that fills in
  // schema defaults. Refusing to start — or worse, throwing mid-registration —
  // because one optional array is absent would be a spectacular trade for a
  // surface *optimization*, so the projection is handed a normalized document.
  const document: AirDocument = { ...air, capabilities: air.capabilities ?? [] };
  const budget = { surfaceBudgetTokens: options.surfaceBudgetTokens };

  const plan = ladderPlan(document, budget);
  if (mode === "flat") return { plan, laddered: false, lanes: [], decisionReason: "plan" };

  if (mode === "laddered" && plan.mode === "flat") {
    // Forcing the ladder lowers the *budget* to zero rather than fabricating
    // lanes. The lanes an operator gets when they insist are therefore exactly
    // the lanes the projection would have produced on its own — same names, same
    // membership, same order — and not a second, hand-rolled grouping that would
    // drift from the one everything else in the toolchain reasons about. It also
    // means the forced mode still cannot ladder a document with no capabilities,
    // no grouping benefit, or nothing measured: those refusals are structural,
    // and an operator preference is not evidence that they were wrong.
    const forced = ladderPlan(document, { ...budget, surfaceBudgetTokens: 0 });
    return {
      plan: forced,
      laddered: forced.mode === "laddered",
      lanes: forced.lanes,
      decisionReason: "plan",
    };
  }

  // `laddered` (already handled above when the plan itself has nothing to
  // offer) always follows the plan from here — an operator's forced choice is
  // never conditioned on measurement. Only `auto`, with a measured accuracy
  // report AND a plan that already says `laddered`, has anything left to
  // weigh; every other combination falls straight through to the plan's own
  // verdict, which is what keeps `auto` with no report byte-identical to its
  // pre-measurement behavior.
  if (mode === "auto" && plan.mode === "laddered" && options.measuredAccuracy) {
    const tokenSavingsFraction = plan.flatTokens > 0 ? 1 - plan.restTokens / plan.flatTokens : 0;
    if (tokenSavingsFraction < MIN_LADDER_TOKEN_SAVINGS_FRACTION) {
      return { plan, laddered: false, lanes: [], decisionReason: "token_savings_below_floor" };
    }
    if (options.measuredAccuracy.ladderedMinusFlatPts < MIN_LADDERED_ACCURACY_DELTA_PTS) {
      return { plan, laddered: false, lanes: [], decisionReason: "accuracy_below_floor" };
    }
  }

  return { plan, laddered: plan.mode === "laddered", lanes: plan.lanes, decisionReason: "plan" };
}

/**
 * One operation as an entry card lists it: enough for an agent to pick the tool
 * it wants without a second round trip, and not one field more.
 *
 * The safety fields mirror the `anvil/*` `_meta` each operation tool publishes,
 * because the card's job is to let an agent decide *before* paying for the
 * schema — and "is this a destructive mutation that needs confirmation" is
 * exactly the kind of thing it should not have to open the lane to learn. They
 * are a preview of the tool's own metadata, never a substitute for the runtime
 * checks that enforce them.
 */
export interface LaneMember {
  toolName: string;
  operationId: string;
  title: string;
  /** One line of what it does — a card is a routing aid, not documentation. */
  summary: string;
  effect: Operation["effect"]["kind"];
  action: Operation["effect"]["action"];
  risk: Operation["effect"]["risk"];
  reversible: boolean;
  retrySafe: boolean;
  idempotency: Operation["idempotency"]["mode"];
  requiresConfirmation: boolean;
  principal: Operation["auth"]["principal"];
}

export function laneMember(operation: Operation): LaneMember {
  return {
    toolName: operation.mcp.toolName,
    operationId: operation.id,
    title: operation.displayName,
    summary: oneLine(operation.description || operation.displayName, LANE_SUMMARY_CHARS),
    effect: operation.effect.kind,
    action: operation.effect.action,
    risk: operation.effect.risk,
    reversible: operation.effect.reversible,
    retrySafe: operation.retries.mode === "safe",
    idempotency: operation.idempotency.mode,
    requiresConfirmation: operation.confirmation.required,
    principal: operation.auth.principal,
  };
}

/**
 * The one line a card spends on a member. Structured content carries the same
 * facts as fields, but a model that reads only `content` still has to be able to
 * route on risk — so the posture is spelled out here rather than left implied by
 * the tool name.
 */
export function laneMemberLine(member: LaneMember): string {
  const posture: string[] = [`${member.effect}/${member.action}`, `risk=${member.risk}`];
  if (member.effect === "mutation" && !member.reversible) posture.push("irreversible");
  posture.push(member.retrySafe ? "retry-safe" : "not retry-safe");
  if (member.idempotency !== "none") posture.push(`idempotency=${member.idempotency}`);
  if (member.requiresConfirmation) posture.push("requires confirm=true");
  return `- ${member.toolName}: ${member.summary} [${posture.join(", ")}]`;
}

export interface LaneOpenResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  /** MCP's `CallToolResult` is an open shape by protocol; this one is servable as-is. */
  [key: string]: unknown;
}

/**
 * What an agent gets back for opening a lane.
 *
 * A pure function of the lane, which is the point: a second open — a retry after
 * a dropped `tools/list_changed`, two sub-agents racing, a client that re-reads
 * its plan — is byte-identical to the first. An agent that cannot tell whether
 * its open landed must be able to just do it again.
 */
export function laneOpenResult(lane: LadderLane, members: readonly LaneMember[]): LaneOpenResult {
  const header =
    `${lane.displayName}: ${members.length} tool(s) are now listed. ` +
    "Refetch tools/list to read their input schemas; this lane stays open for the rest of the session.";
  const footer =
    "The posture shown here previews each tool's own anvil/* metadata. " +
    "Opening a lane discloses schemas only — every approval, confirmation, idempotency and auth rule still applies when you call.";

  return {
    content: [
      { type: "text" as const, text: [header, ...members.map(laneMemberLine), footer].join("\n") },
    ],
    structuredContent: {
      capabilityId: lane.capabilityId,
      displayName: lane.displayName,
      tools: members,
    },
  };
}

/**
 * The structural slice of the SDK's `RegisteredTool` handle a lane needs.
 * Declared here rather than imported so this module — and the tests that pin its
 * behavior — can reason about disclosure without standing up a server, and so
 * the ladder depends on two verbs rather than on the SDK's whole tool record.
 */
export interface DisclosableTool {
  enable(): void;
  disable(): void;
}

/** An entry card, ready for the caller to register on its server. */
export interface LaneEntryCard {
  lane: LadderLane;
  toolName: string;
  title: string;
  description: string;
  meta: Record<string, unknown>;
  /** Discloses the lane's tools and returns the card's own answer. */
  open: () => LaneOpenResult;
}

export interface LaneEntryCardInput {
  lanes: readonly LadderLane[];
  operations: ReadonlyMap<string, Operation>;
  /** Handles for the already-registered operation tools, keyed by operation id. */
  tools: ReadonlyMap<string, DisclosableTool>;
  /**
   * Tool names already taken on the server. `ladderPlan` drops a lane whose card
   * would collide with an *operation* tool, but workflows share the same
   * namespace and the projection cannot see them — and registering a duplicate
   * name throws. Same trade the projection makes: a dropped lane costs tokens, a
   * lost tool costs a capability the agent was approved to call.
   */
  reservedToolNames?: ReadonlySet<string>;
}

export interface LaneSurface {
  cards: LaneEntryCard[];
  /**
   * Put every laned tool back to its at-rest state: disclosed by its card, not
   * by the listing. Called once at build time, before the server is connected.
   */
  closeLanes: () => void;
}

/**
 * Build the entry cards for a set of lanes over already-registered tools.
 *
 * The operation tools are registered first and completely — same names, same
 * schemas, same handlers, same order — and the ladder is applied on top by
 * closing them. Disclosure is a state on a registered tool, never a decision
 * about whether to register one, which is what makes the flat and laddered
 * surfaces provably the same surface seen at two different times.
 */
export function createLaneSurface(input: LaneEntryCardInput): LaneSurface {
  const reserved = new Set(input.reservedToolNames ?? []);
  const cards: LaneEntryCard[] = [];
  const laned: DisclosableTool[] = [];

  for (const lane of input.lanes) {
    if (reserved.has(lane.entryToolName)) continue;

    const members: LaneMember[] = [];
    const handles: DisclosableTool[] = [];
    for (const operationId of lane.operationIds) {
      const operation = input.operations.get(operationId);
      const handle = input.tools.get(operationId);
      // A lane may name an operation this server did not register — a document
      // whose capability outran its operation list, or a capability whose member
      // was withdrawn. Skipping it keeps the card honest about what it opens.
      if (!operation || !handle) continue;
      members.push(laneMember(operation));
      handles.push(handle);
    }
    // A card that opens nothing is a dead end an agent pays a round trip to
    // discover. The projection refuses to build such a lane; so does this.
    if (members.length === 0) continue;

    reserved.add(lane.entryToolName);
    laned.push(...handles);
    cards.push({
      lane,
      toolName: lane.entryToolName,
      title: `Open ${lane.displayName}`,
      description: laneEntryDescription(lane),
      meta: {
        "anvil/lane": true,
        "anvil/capability_id": lane.capabilityId,
        "anvil/lane_tools": members.length,
        "anvil/lane_tokens": lane.laneTokens,
      },
      open: () => {
        // Enabling is a set, not a toggle, and nothing here ever disables:
        // ONCE A LANE IS OPEN IT STAYS OPEN for the session. Do not "optimize"
        // this into an LRU. Evicting a lane pulls a tool out from under an agent
        // that is mid-plan on it, and a plan that dies because its tool vanished
        // is a far worse failure than the context cost of a second open lane.
        // The bound on that cost is the number of lanes, which the contract
        // fixes — an agent cannot open its way past the flat surface it would
        // otherwise have been served in full.
        for (const handle of handles) handle.enable();
        return laneOpenResult(lane, members);
      },
    });
  }

  return {
    cards,
    closeLanes: () => {
      for (const handle of laned) handle.disable();
    },
  };
}

/** Collapse to a single line and bound the length; a card is a budget device. */
function oneLine(text: string, limit: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= limit) return collapsed;
  return `${collapsed.slice(0, limit - 1).trimEnd()}…`;
}
