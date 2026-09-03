import type { AirDocument, LadderPlan, Operation } from "@anvil/air";
import { ladderPlan, laneEntryDescription, mcpToolDescription } from "@anvil/air";
import {
  benchmarkOperations,
  curatedCatalog,
  type RoutableTool,
  type RoutingOutcome,
  routeAndScore,
  type TaskRouter,
} from "./routing.js";

/**
 * The laddered half of the routing benchmark: does the two-stage disclosure
 * surface (`@anvil/air`'s `ladderPlan`, served by `@anvil/mcp-runtime`'s
 * `lane.ts`) route an intent to the right tool at least as well as the flat
 * catalog it replaces?
 *
 * This module only measures. It never decides whether laddering is a good
 * idea for a given bundle — `ladderPlan` already made that call, and this
 * catalog and router are a projection of whatever `ladderPlan` produced, not a
 * second opinion on it. When the plan declines (unmeasured, fits the budget,
 * no capabilities, no grouping benefit, no token benefit), `ladderedCatalog`
 * falls back to the flat curated catalog and `stagedRoute` scores it exactly
 * as `routeAndScore` would — the benchmark reports what a real server would
 * actually serve, never a hypothetical ladder nobody would be handed.
 */

/** Sentinel `operationId` on a stage-1 entry-card tool: a card names no single
 *  operation, so scoring never targets it directly — only the tool a staged
 *  route eventually reaches (stage 1's own pick or a stage-2 member) is scored
 *  against the intent's real operation id. */
const ENTRY_CARD_OPERATION_ID = "";

export interface LadderedCatalog {
  /**
   * The projection this catalog was built from — mode, reason, lanes, and the
   * measured token figures (`flatTokens`, `restTokens`, per-lane
   * `laneTokens`) the disclosure-cost estimate reads directly rather than
   * recomputing.
   */
  plan: LadderPlan;
  /**
   * Stage 1: what `tools/list` shows at rest when laddered — one entry card
   * per lane (name = `laneEntryToolName`, description = `laneEntryDescription`)
   * plus a direct tool for every benchmarkable operation the plan left
   * unlaned. When the plan declined, this IS the flat curated catalog.
   */
  stage1: RoutableTool[];
  /** Stage 2: the member tools a lane discloses once opened, keyed by the
   *  lane's entry tool name. Empty when the plan declined. */
  stage2: ReadonlyMap<string, RoutableTool[]>;
}

/**
 * Build the two-stage catalog `stagedRoute` routes over.
 *
 * Token totals in `plan` (`flatTokens`, `restTokens`, per-lane `laneTokens`)
 * are measured over EVERY approved operation, matching what the real server
 * would serve — including one this bundle's routing tasks never touch (a
 * webhook receiver, an operation with no intent examples). Which tools
 * `stage1`/`stage2` actually route to is narrower: only the benchmarkable set
 * (`benchmarkOperations`), the same restriction `curatedCatalog`/`bareCatalog`
 * already apply, because scoring a route against an operation this benchmark
 * never asks about would be meaningless. A lane whose entire membership falls
 * outside that set opens nothing worth routing to and is dropped, mirroring
 * `createLaneSurface`'s own "a card that opens nothing is a dead end" refusal.
 */
export function ladderedCatalog(air: AirDocument): LadderedCatalog {
  const ops = benchmarkOperations(air);
  const byId = new Map(ops.map((op) => [op.id, op]));
  const plan = ladderPlan(air);

  if (plan.mode !== "laddered") {
    return { plan, stage1: curatedCatalog(ops), stage2: new Map() };
  }

  const stage1: RoutableTool[] = [];
  const stage2 = new Map<string, RoutableTool[]>();

  for (const lane of plan.lanes) {
    const members: RoutableTool[] = lane.operationIds
      .map((id) => byId.get(id))
      .filter((op): op is Operation => op !== undefined)
      .map((op) => ({
        name: op.mcp.toolName,
        description: mcpToolDescription(op),
        operationId: op.id,
      }));
    if (members.length === 0) continue;
    stage1.push({
      name: lane.entryToolName,
      description: laneEntryDescription(lane),
      operationId: ENTRY_CARD_OPERATION_ID,
    });
    stage2.set(lane.entryToolName, members);
  }

  for (const id of plan.unlanedOperationIds) {
    const op = byId.get(id);
    if (!op) continue;
    stage1.push({ name: op.mcp.toolName, description: mcpToolDescription(op), operationId: op.id });
  }

  return { plan, stage1, stage2 };
}

export interface StagedRoutingOutcome extends RoutingOutcome {
  /** The entry tool name of the lane stage 1 entered, when it entered one —
   *  absent when the plan declined, stage 1 routed straight to an unlaned
   *  tool, or nothing routed at all. Carried for the disclosure-cost estimate,
   *  which needs to know which lane's tokens a passing task actually paid. */
  enteredLane?: string;
}

/**
 * Route one intent over a laddered catalog: stage 1 picks a lane (or, for an
 * unlaned operation, the final tool directly), then stage 2 routes within
 * whichever lane stage 1 chose. Passes iff the tool stage 2 (or stage 1, for
 * an unlaned operation) reaches is the intent's own operation.
 *
 * Stage 2 is scored against ONLY the entered lane's members, never the whole
 * catalog — a real staged server has every other lane's tools closed, so a
 * route that reaches the right tool through a DIFFERENT lane than the one it
 * says it opened is not a route that server could have served. Mutant
 * `benchmark-ladder/stage-two-scoped-to-lane` pins this scoping.
 */
export async function stagedRoute(
  router: TaskRouter,
  intent: string,
  ladder: LadderedCatalog,
  operationId: string,
): Promise<StagedRoutingOutcome> {
  if (ladder.plan.mode !== "laddered") {
    return routeAndScore(router, intent, ladder.stage1, operationId);
  }

  const stage1Routed = await router.route(intent, ladder.stage1);
  if (stage1Routed === undefined) return { routed: undefined, pass: false };

  const members = ladder.stage2.get(stage1Routed);
  if (members === undefined) {
    // Not a lane name — either an unlaned tool's own name (the final answer,
    // no lane to open) or a name the router invented, which fails exactly as
    // routeAndScore would fail it: no stage-1 tool claims this operation id.
    const target = ladder.stage1.find((t) => t.operationId === operationId);
    return { routed: stage1Routed, pass: stage1Routed === target?.name };
  }

  const stage2Outcome = await routeAndScore(router, intent, members, operationId);
  return { ...stage2Outcome, enteredLane: stage1Routed };
}
