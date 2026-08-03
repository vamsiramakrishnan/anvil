import type { AirDocument } from "@anvil/air";
import { ladderPlan } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { approveOperations, compile } from "./compile.js";
import { reachMeasurements, reachProfile, tokensToReach } from "./disclosure-metric.js";

/**
 * What must stay true about tokens-to-reach.
 *
 * The metric exists to make one claim falsifiable — that a laddered surface is
 * cheaper to route on than a flat one — so these tests spend most of their
 * effort on the ways a reach figure could be flattering and wrong: counting a
 * lane the agent never opens, forgetting the tools that ride along in the same
 * listing, hiding the extra round trip, or scoring an unmeasured operation as
 * free. A metric that cannot be wrong cannot be evidence.
 */

/** `caps` tags × `opsPerCap` operations — the shape a ladder is built for. */
function spec(caps: number, opsPerCap: number): string {
  const paths: string[] = [];
  for (let capability = 0; capability < caps; capability += 1) {
    for (let index = 0; index < opsPerCap; index += 1) {
      paths.push(
        [
          `  /cap${capability}/things${index}/{id}:`,
          "    get:",
          `      operationId: getCap${capability}Thing${index}`,
          `      tags: [cap${capability}]`,
          `      summary: Read thing ${index} in capability ${capability}`,
          "      description: Returns the record with its identifiers, status and audit fields.",
          "      parameters:",
          "        - { name: id, in: path, required: true, schema: { type: string } }",
          "        - { name: cursor, in: query, schema: { type: string } }",
          '      responses: { "200": { description: ok } }',
        ].join("\n"),
      );
    }
  }
  return `openapi: 3.0.0\ninfo: { title: estate, version: 1.0.0 }\npaths:\n${paths.join("\n")}\n`;
}

/** Compile and approve everything: only approved operations are ever served. */
async function estate(caps: number, opsPerCap: number): Promise<AirDocument> {
  const air = await compile({ spec: spec(caps, opsPerCap), serviceId: "estate" });
  return approveOperations(
    air,
    air.operations.map((operation) => operation.id),
  );
}

/**
 * A budget low enough that the fixture's flat surface overruns it. The unit
 * tests care about the *arithmetic* of a laddered surface, not about how many
 * operations it takes to trip the default 20k budget, and generating that many
 * would make this file slow for no extra coverage.
 */
const LADDER_OPTS = { surfaceBudgetTokens: 1_000 } as const;

/** Strip every measurement — a bundle compiled before disclosure was measured. */
function unmeasured(air: AirDocument): AirDocument {
  return {
    ...air,
    operations: air.operations.map((operation) => ({ ...operation, disclosureCost: undefined })),
  };
}

describe("the flat surface, which is the thing being argued with", () => {
  it("charges the whole listing to reach any single operation", async () => {
    const air = await estate(3, 4);
    const plan = ladderPlan(air);
    expect(plan.mode).toBe("flat");

    const reaches = reachMeasurements(air);
    expect(reaches).toHaveLength(12);
    // Flat reach does not depend on which operation you want: an agent pays for
    // every schema in the estate to call one of them. That invariance is the
    // problem the ladder addresses, so it is pinned rather than assumed.
    expect(new Set(reaches.map((reach) => reach.tokens))).toEqual(new Set([plan.flatTokens]));
    expect(new Set(reaches.map((reach) => reach.hops))).toEqual(new Set([1]));
    expect(reaches.every((reach) => reach.basis === "flat")).toBe(true);
  });

  it("reports a ratio of exactly 1 when the ladder declined", async () => {
    const air = await estate(3, 4);
    const profile = reachProfile(air);
    // The plan is what will actually be served. Claiming a saving from a ladder
    // that was never built would be a number no agent receives.
    expect(profile.mode).toBe("flat");
    expect(profile.reason).toBe("fits_budget");
    expect(profile.ladderedBaseline).toBe(profile.flatBaseline);
    expect(profile.improvementRatio).toBe(1);
    expect(profile.worstCaseRatio).toBe(1);
    expect(profile.hops).toEqual({ min: 1, max: 1 });
  });
});

describe("the laddered surface", () => {
  it("charges the cards, the tools that ride with them, and one whole lane", async () => {
    const air = await estate(6, 5);
    const plan = ladderPlan(air, LADDER_OPTS);
    expect(plan.mode).toBe("laddered");
    expect(plan.unlanedOperationIds).toEqual([]);

    const lane = plan.lanes[0];
    const target = lane?.operationIds[0];
    if (!lane || !target) throw new Error("expected a populated lane");

    const reach = tokensToReach(air, target, LADDER_OPTS);
    // The whole lane, not just the target: opening a lane discloses every member
    // it holds, and charging only the one an agent wanted would advertise a
    // saving the serving path does not deliver.
    expect(reach.tokens).toBe(plan.restTokens + lane.laneTokens);
    expect(reach.tokens).toBeGreaterThan(lane.laneTokens);
    expect(reach.basis).toBe("laddered");
    expect(reach.unmeasured).toBe(false);
    expect(reach.unmeasuredOnPath).toBe(0);
  });

  it("reports the extra round trip it traded the tokens for", async () => {
    const air = await estate(6, 5);
    const profile = reachProfile(air, LADDER_OPTS);
    // Every operation here is laned, so every reach is two hops. Reporting the
    // token saving without this would sell half the trade.
    expect(profile.hops).toEqual({ min: 2, max: 2 });
    expect(profile.mode).toBe("laddered");
    expect(profile.reason).toBe("over_budget");
  });

  it("beats the flat surface it replaced, and by more in the worst case than none", async () => {
    const air = await estate(6, 5);
    const profile = reachProfile(air, LADDER_OPTS);
    const flat = profile.flatBaseline ?? 0;

    expect(flat).toBeGreaterThan(0);
    expect(profile.worst ?? 0).toBeLessThan(flat);
    expect(profile.best ?? 0).toBeLessThanOrEqual(profile.median ?? 0);
    expect(profile.median ?? 0).toBeLessThanOrEqual(profile.worst ?? 0);
    expect(profile.improvementRatio ?? 0).toBeGreaterThan(1);
    // The guarantee can never flatter the advertisement: the most expensive
    // operation saves at most what the typical one does.
    expect(profile.worstCaseRatio ?? 0).toBeLessThanOrEqual(profile.improvementRatio ?? 0);
    expect(profile.worstCaseRatio ?? 0).toBeGreaterThan(1);
  });

  it("names the operations behind the distribution so a failing gate points somewhere", async () => {
    const air = await estate(6, 5);
    const profile = reachProfile(air, LADDER_OPTS);
    const served = new Set(air.operations.map((operation) => operation.id));
    expect(served.has(profile.bestOperationId ?? "")).toBe(true);
    expect(served.has(profile.worstOperationId ?? "")).toBe(true);
    expect(tokensToReach(air, profile.worstOperationId ?? "", LADDER_OPTS).tokens).toBe(
      profile.worst,
    );
  });

  it("charges one hop for an operation the ladder left registered at rest", async () => {
    const air = await estate(6, 5);
    // A capability whose lane the plan drops leaves its operations unlaned; the
    // simplest faithful way to produce that here is to remove the capability
    // while keeping its (still approved) operations.
    const dropped = air.capabilities[0];
    if (!dropped) throw new Error("expected a discovered capability");
    const partial: AirDocument = {
      ...air,
      capabilities: air.capabilities.filter((capability) => capability.id !== dropped.id),
    };
    const plan = ladderPlan(partial, LADDER_OPTS);
    expect(plan.mode).toBe("laddered");
    expect(plan.unlanedOperationIds).toEqual([...dropped.operationIds].sort());

    const stranded = plan.unlanedOperationIds[0];
    if (!stranded) throw new Error("expected an unlaned operation");
    const reach = tokensToReach(partial, stranded, LADDER_OPTS);
    // Its schema arrives with the entry cards, so there is no lane to open —
    // one hop, and exactly the at-rest surface.
    expect(reach.hops).toBe(1);
    expect(reach.tokens).toBe(plan.restTokens);
    expect(reachProfile(partial, LADDER_OPTS).hops).toEqual({ min: 1, max: 2 });
  });

  it("accounts for every token the flat surface held, in lanes plus what stayed", async () => {
    const air = await estate(6, 5);
    const plan = ladderPlan(air, LADDER_OPTS);
    const laned = plan.lanes.reduce((total, lane) => total + lane.laneTokens, 0);
    const unlaned = plan.unlanedOperationIds.reduce((total, id) => {
      const operation = air.operations.find((candidate) => candidate.id === id);
      return total + (operation?.disclosureCost?.toolTokens ?? 0);
    }, 0);
    // Laddering changes *when* a schema is disclosed, never whether it exists.
    // If these diverged, some operation's cost would have been quietly dropped
    // and every reach figure below it would be too good.
    expect(laned + unlaned).toBe(plan.flatTokens);
  });
});

describe("unmeasured is a state, not a zero", () => {
  it("reports no figures at all for a document nobody priced", async () => {
    const profile = reachProfile(unmeasured(await estate(6, 5)));
    // The failure mode this guards is a report saying "0 tokens to reach" and
    // reading as a triumph. Absent beats confidently free.
    expect(profile.measured).toBe(0);
    expect(profile.operations).toBe(30);
    expect(profile.lowerBound).toBe(true);
    expect(profile.best).toBeUndefined();
    expect(profile.median).toBeUndefined();
    expect(profile.worst).toBeUndefined();
    expect(profile.flatBaseline).toBeUndefined();
    expect(profile.ladderedBaseline).toBeUndefined();
    expect(profile.improvementRatio).toBeUndefined();
    expect(profile.worstCaseRatio).toBeUndefined();
    // And the ladder itself declines for the same reason, so the surface is
    // unchanged for every bundle compiled before measurement existed.
    expect(profile.mode).toBe("flat");
    expect(profile.reason).toBe("unmeasured");
  });

  it("flags a target whose own schema cost is unknown", async () => {
    const air = await estate(6, 5);
    const victim = air.operations[0];
    if (!victim) throw new Error("expected an operation");
    victim.disclosureCost = undefined;

    const reach = tokensToReach(air, victim.id, LADDER_OPTS);
    expect(reach.unmeasured).toBe(true);
    expect(reach.unmeasuredOnPath).toBe(1);
    // The figure is the measured part of the path; the target's own disclosure
    // is missing from it rather than being counted as costing nothing.
    const plan = ladderPlan(air, LADDER_OPTS);
    const lane = plan.lanes.find((candidate) => candidate.operationIds.includes(victim.id));
    expect(reach.tokens).toBe(plan.restTokens + (lane?.laneTokens ?? 0));
  });

  it("keeps a partially measured surface out of the distribution but visible", async () => {
    const air = await estate(6, 5);
    for (const operation of air.operations.slice(0, 4)) operation.disclosureCost = undefined;

    const profile = reachProfile(air, LADDER_OPTS);
    expect(profile.operations).toBe(30);
    expect(profile.measured).toBe(26);
    // Every token figure is now a floor that can only grow — the same honesty
    // the capability token budget applies to a partial measurement.
    expect(profile.lowerBound).toBe(true);
    expect(profile.improvementRatio ?? 0).toBeGreaterThan(1);
    const measurements = reachMeasurements(air, LADDER_OPTS);
    expect(measurements.filter((reach) => reach.unmeasured)).toHaveLength(4);
    expect(measurements.some((reach) => reach.unmeasuredOnPath > 0)).toBe(true);
  });
});

describe("the contract of the metric itself", () => {
  it("refuses to price an operation that is not on the served surface", async () => {
    const air = await estate(3, 4);
    expect(() => tokensToReach(air, "estate.nope.get")).toThrow(/Unknown operation/);

    const hidden = air.operations[0];
    if (!hidden) throw new Error("expected an operation");
    hidden.state = "review_required";
    // An unapproved operation has no tool, no lane and no disclosure. Any number
    // returned here would be read as a reach it does not have.
    expect(() => tokensToReach(air, hidden.id)).toThrow(/not on the served surface/);
    expect(reachProfile(air).operations).toBe(11);
  });

  it("is deterministic, and independent of who projected the plan", async () => {
    const air = await estate(6, 5);
    expect(reachProfile(air, LADDER_OPTS)).toEqual(reachProfile(air, LADDER_OPTS));
    // Passing a plan in is an optimization for callers walking a whole estate,
    // never a different answer.
    const plan = ladderPlan(air, LADDER_OPTS);
    expect(reachProfile(air, { ...LADDER_OPTS, plan })).toEqual(reachProfile(air, LADDER_OPTS));
    expect(reachProfile(await estate(6, 5), LADDER_OPTS)).toEqual(reachProfile(air, LADDER_OPTS));
  });

  it("measures the surface, so a bigger tool costs more to reach", async () => {
    const air = await estate(6, 5);
    const before = reachProfile(air, LADDER_OPTS);
    const bloated = air.operations[0];
    if (!bloated?.disclosureCost) throw new Error("expected a measured operation");
    bloated.disclosureCost = { ...bloated.disclosureCost, toolTokens: 40_000 };

    const after = reachProfile(air, LADDER_OPTS);
    // One fat tool poisons its own lane and the flat baseline both. The ratchet
    // in the CLI gate is built on exactly this sensitivity.
    expect(after.flatBaseline ?? 0).toBeGreaterThan(before.flatBaseline ?? 0);
    expect(after.worst ?? 0).toBeGreaterThan(before.worst ?? 0);
    // Reach is a property of a lane, so every member of the poisoned lane ties
    // at the worst figure and the named id is that lane's first member by id —
    // a stable representative, not a claim that one operation is the culprit.
    const worst = air.operations.find((operation) => operation.id === after.worstOperationId);
    expect(worst?.capabilityId).toBe(bloated.capabilityId);
  });

  it("handles a document with nothing served without inventing figures", async () => {
    const air = await estate(3, 4);
    for (const operation of air.operations) operation.state = "review_required";
    const profile = reachProfile(air);
    expect(profile.operations).toBe(0);
    expect(profile.measured).toBe(0);
    expect(profile.lowerBound).toBe(false);
    expect(profile.hops).toEqual({ min: 0, max: 0 });
    expect(profile.flatBaseline).toBeUndefined();
    expect(profile.improvementRatio).toBeUndefined();
  });
});
