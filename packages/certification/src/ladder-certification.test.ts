import type { AirDocument, Capability, Operation } from "@anvil/air";
import {
  DEFAULT_SURFACE_DISCLOSURE_BUDGET_TOKENS,
  DEFAULT_TOOL_DISCLOSURE_BUDGET_TOKENS,
  ladderPlan,
} from "@anvil/air";
import { approveOperations, compile, measureToolSurface } from "@anvil/compiler";
import { beforeEach, describe, expect, it } from "vitest";
import { staticChecks } from "./checks.js";

/**
 * The disclosure ladder is the point at which "the served surface fits in the
 * agent's context" stops being a design intention and starts being a claim. These
 * tests pin the four properties that make the claim checkable rather than
 * decorative: the at-rest surface really is under budget, laddering exposes
 * neither more nor less than the flat surface would, entry cards cannot shadow a
 * tool, and a ladder that saves nothing is a defect rather than a style choice.
 *
 * The other half of what is pinned here is the *notes*. Every one of these checks
 * passes vacuously on a flat or unmeasured document — correct for a check, and
 * indistinguishable from real verification unless the note says which happened.
 * So the assertions on `detail` are not cosmetic: they are what stops a report of
 * five green ticks over an unmeasured surface from reading as five verifications.
 */

const SPEC = `openapi: "3.0.3"
info: { title: Estate, version: "1.0.0" }
paths:
  /refunds:
    get:
      operationId: listRefunds
      tags: [refunds]
      responses: { "200": { description: ok } }
    post:
      operationId: createRefund
      tags: [refunds]
      responses: { "201": { description: created } }
  /payments:
    get:
      operationId: listPayments
      tags: [payments]
      responses: { "200": { description: ok } }
    post:
      operationId: createPayment
      tags: [payments]
      responses: { "201": { description: created } }
`;

let air: AirDocument;

beforeEach(async () => {
  const compiled = await compile({ spec: SPEC, serviceId: "estate" });
  air = approveOperations(
    compiled,
    compiled.operations.map((o) => o.id),
  );
  // Start explicitly unmeasured. Measurement is what unlocks every ladder
  // decision, so the cases below opt into it deliberately — and the unmeasured
  // path has to stay reachable because every bundle compiled before disclosure
  // measurement existed takes it.
  for (const op of air.operations) op.disclosureCost = undefined;
});

/** Attach the compiler's real tool-surface measurement, as a build would. */
function measure(doc: AirDocument): void {
  for (const op of doc.operations) op.disclosureCost = measureToolSurface(op);
}

/** Approved operations in the grown fixture — the figure the notes quote back. */
const ESTATE_SIZE = 20;

/**
 * Grow the fixture into an estate that cannot be served flat, the way a real one
 * gets there: many ordinary operations, each individually well within its own
 * per-operation budget. That distinction is the ladder's entire premise — a
 * surface can be too expensive to list while every tool on it is perfectly sized,
 * which is exactly the failure the per-operation check in `checks.ts` cannot see.
 * Forcing the budget with four enormous tools instead would trip that check and
 * certify nothing about the ladder.
 *
 * The lever is the contract's own measurement rather than a stubbed `ladderPlan`:
 * these checks are supposed to read the same projection the serving path reads,
 * and a faked plan would prove only that the assertions can be satisfied by
 * something.
 */
function overBudget(doc: AirDocument): void {
  const base = [...doc.operations];
  for (const op of base) {
    const owner = doc.capabilities.find((c) => c.operationIds.includes(op.id));
    for (let copy = 1; copy < ESTATE_SIZE / base.length; copy++) {
      const clone: Operation = structuredClone(op);
      clone.id = `${op.id}.v${copy}`;
      clone.mcp = { ...clone.mcp, toolName: `${op.mcp.toolName}_v${copy}` };
      doc.operations.push(clone);
      owner?.operationIds.push(clone.id);
    }
  }
  measure(doc);
  for (const op of doc.operations) {
    op.disclosureCost = {
      ...(op.disclosureCost as NonNullable<Operation["disclosureCost"]>),
      toolTokens: PER_TOOL,
    };
  }
}

/** Comfortably inside the per-operation budget; ruinous twenty times over. */
const PER_TOOL = DEFAULT_TOOL_DISCLOSURE_BUDGET_TOKENS - 100;

const checkNamed = (doc: AirDocument, id: string) => {
  const found = staticChecks(doc).find((c) => c.id === id);
  if (!found) throw new Error(`check ${id} not emitted`);
  return found;
};

const capability = (doc: AirDocument, id: string): Capability => {
  const found = doc.capabilities.find((c) => c.id === id);
  if (!found) throw new Error(`capability ${id} missing from fixture`);
  return found;
};

describe("the ladder actually laddered", () => {
  it("engages once the flat surface exceeds the budget", () => {
    overBudget(air);
    const plan = ladderPlan(air);
    expect(plan.mode).toBe("laddered");
    expect(plan.lanes.length).toBe(2);
    expect(plan.flatTokens).toBeGreaterThan(DEFAULT_SURFACE_DISCLOSURE_BUDGET_TOKENS);
  });

  it("certifies the at-rest surface against the budget, with the figures", () => {
    overBudget(air);
    const c = checkNamed(air, "static/surface_at_rest_within_disclosure_budget");
    expect(c.ok).toBe(true);
    expect(c.detail).toMatch(/^laddered: 2 entry card\(s\)/);
    expect(c.detail).toContain(`/${DEFAULT_SURFACE_DISCLOSURE_BUDGET_TOKENS} tokens at rest`);
  });

  it("certifies that laddering shrank the surface it stood in for", () => {
    overBudget(air);
    const c = checkNamed(air, "static/ladder_reduces_surface");
    expect(c.ok).toBe(true);
    expect(c.detail).toMatch(/saving \d+/);
  });

  it("names lane and unlaned counts so the reader can see the shape", () => {
    overBudget(air);
    const c = checkNamed(air, "static/ladder_preserves_approved_surface");
    expect(c.ok).toBe(true);
    expect(c.detail).toBe(
      `${ESTATE_SIZE} approved operation(s) reachable: ${ESTATE_SIZE} across 2 lane(s), 0 registered at rest`,
    );
  });
});

describe("laddering exposes exactly what flat exposes", () => {
  it("keeps an operation that fell out of every lane registered at rest", () => {
    overBudget(air);
    // Drop one operation from its capability while leaving it approved. If lane
    // membership were the only route to a schema, this operation would now be
    // unreachable — an approval revoked by a layout decision, the one thing a
    // ladder is never allowed to do.
    const refunds = capability(air, "estate.refunds");
    const orphan = refunds.operationIds[0] as string;
    refunds.operationIds = refunds.operationIds.filter((id) => id !== orphan);
    // It is not, because the projection re-registers an unlaned operation at
    // rest. That fallback is what makes the invariant hold, so pin it here
    // rather than trusting it: this is the shape the check would catch.
    expect(ladderPlan(air).unlanedOperationIds).toContain(orphan);
    expect(checkNamed(air, "static/ladder_preserves_approved_surface").ok).toBe(true);
  });

  it("never lets a lane disclose an operation that was not approved", () => {
    overBudget(air);
    const blocked = air.operations[0] as Operation;
    blocked.state = "blocked";
    // The capability still lists it. `buildLane` intersects with the approved
    // set, so a leak here would mean that intersection stopped happening.
    expect(
      capability(air, "estate.payments").operationIds.concat(
        capability(air, "estate.refunds").operationIds,
      ),
    ).toContain(blocked.id);
    const plan = ladderPlan(air);
    expect(plan.lanes.flatMap((l) => l.operationIds)).not.toContain(blocked.id);
    expect(plan.unlanedOperationIds).not.toContain(blocked.id);
    expect(checkNamed(air, "static/ladder_preserves_approved_surface").ok).toBe(true);
  });

  it("counts a duplicated disclosure as a layout note, never as a leak", () => {
    overBudget(air);
    // Two capabilities claiming one operation costs tokens and muddles routing,
    // but withholds nothing and exposes nothing — so the verdict holds and the
    // detail says it out loud.
    const shared = capability(air, "estate.refunds").operationIds[0] as string;
    capability(air, "estate.payments").operationIds.push(shared);
    const c = checkNamed(air, "static/ladder_preserves_approved_surface");
    expect(c.ok).toBe(true);
    expect(c.detail).toContain(`disclosed by more than one lane: ${shared}`);
  });
});

describe("entry-card names share a namespace with tool names", () => {
  it("passes and names the populations it compared", () => {
    overBudget(air);
    const c = checkNamed(air, "static/ladder_entry_names_unique");
    expect(c.ok).toBe(true);
    expect(c.detail).toBe(
      `2 entry card(s) distinct from each other and from ${ESTATE_SIZE} tool name(s)`,
    );
  });

  it("keeps a colliding card off the surface rather than shadowing a tool", () => {
    overBudget(air);
    // Rename a real tool onto a capability's generated card name. The projection
    // drops the lane rather than the tool — losing a lane costs tokens, losing a
    // tool costs the agent a capability it was approved to call.
    const op = air.operations[0] as Operation;
    op.mcp = { ...op.mcp, toolName: "open_estate_refunds" };
    const plan = ladderPlan(air);
    expect(plan.lanes.map((l) => l.capabilityId)).not.toContain("estate.refunds");
    const c = checkNamed(air, "static/ladder_entry_names_unique");
    expect(c.ok).toBe(true);
    // Every operation of the dropped lane must still be served.
    expect(checkNamed(air, "static/ladder_preserves_approved_surface").ok).toBe(true);
  });

  it("holds when two capability ids sanitize onto one entry card", () => {
    overBudget(air);
    // `.` and `_` both collapse to `_`, so these distinct ids mint one card name.
    // This check was written against a projection that shipped both lanes, letting
    // one shadow the other while the shadowed lane's operations still counted as
    // laned — reachable through nothing. The projection now demotes the second
    // claimant and returns its operations to the flat surface, so the violation is
    // unreachable from here and the check passes.
    //
    // The check stays anyway, and deliberately: it is the assertion that keeps the
    // fix honest. If a future edit to the ladder reintroduces the collision, this
    // is what fails, and it fails at certification rather than in an agent's
    // session against a tool that silently is not there.
    const payments = capability(air, "estate.payments");
    payments.id = "estate_payments";
    const refunds = capability(air, "estate.refunds");
    refunds.id = "estate.payments";
    expect(checkNamed(air, "static/ladder_entry_names_unique").ok).toBe(true);
    // The load-bearing consequence: nothing fell between the two lanes.
    expect(checkNamed(air, "static/ladder_preserves_approved_surface").ok).toBe(true);
  });
});

describe("the stated reason has to be true of the contract", () => {
  it("re-derives over_budget for a laddered surface", () => {
    overBudget(air);
    const c = checkNamed(air, "static/ladder_mode_justified");
    expect(c.ok).toBe(true);
    expect(c.detail).toMatch(/^laddered\/over_budget re-derived from the contract/);
  });

  it("re-derives fits_budget for a measured surface that already fits", () => {
    measure(air);
    expect(ladderPlan(air).reason).toBe("fits_budget");
    const c = checkNamed(air, "static/ladder_mode_justified");
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("the flat surface is");
  });

  it("re-derives no_grouping_benefit when every grouping holds one operation", () => {
    overBudget(air);
    // One operation per capability: a card per tool collapses nothing and only
    // doubles the steps to the same schema.
    for (const cap of air.capabilities) cap.operationIds = cap.operationIds.slice(0, 1);
    const plan = ladderPlan(air);
    expect(plan.mode).toBe("flat");
    expect(plan.reason).toBe("no_grouping_benefit");
    const c = checkNamed(air, "static/ladder_mode_justified");
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("largest holds 1 operation(s)");
  });

  it("re-derives no_capabilities when nothing groups the operations", () => {
    overBudget(air);
    air.capabilities = [];
    expect(ladderPlan(air).reason).toBe("no_capabilities");
    const c = checkNamed(air, "static/ladder_mode_justified");
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("0 usable capability grouping(s)");
  });
});

describe("a flat or unmeasured surface passes, but never quietly", () => {
  it("says nothing was measured rather than implying it fit", () => {
    const c = checkNamed(air, "static/surface_at_rest_within_disclosure_budget");
    expect(c.ok).toBe(true);
    expect(c.detail).toMatch(/no approved operation carries a disclosure measurement/);
    // The distinction that matters: this is not the same sentence a verified
    // surface produces.
    expect(c.detail).not.toContain("verified within budget");
  });

  it("says the flat surface was verified when it genuinely was", () => {
    measure(air);
    const c = checkNamed(air, "static/surface_at_rest_within_disclosure_budget");
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("served flat (fits_budget)");
    expect(c.detail).toContain("verified within budget");
  });

  it("reports an over-budget flat surface loudly instead of failing the ladder", () => {
    // Over budget with nothing to group by: the ladder made no claim, so nothing
    // was violated — but a reader must not be able to mistake this for a fit.
    overBudget(air);
    air.capabilities = [];
    const c = checkNamed(air, "static/surface_at_rest_within_disclosure_budget");
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("EXCEEDS");
    expect(c.detail).toContain("no lane is available to reduce it");
  });

  it("marks a partially-measured figure as a floor, not a size", () => {
    const first = air.operations[0] as Operation;
    first.disclosureCost = measureToolSurface(first);
    const c = checkNamed(air, "static/surface_at_rest_within_disclosure_budget");
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("floor: 3 approved operation(s) carry no measurement");
  });

  it("says there was no ladder to judge rather than claiming a saving", () => {
    measure(air);
    const c = checkNamed(air, "static/ladder_reduces_surface");
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("no lane is served, so there is no indirection to justify");
    expect(c.detail).not.toMatch(/saving/);
  });

  it("says no card was minted rather than claiming names were compared", () => {
    measure(air);
    const c = checkNamed(air, "static/ladder_entry_names_unique");
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("no entry card is minted");
  });

  it("distinguishes an empty surface from an unmeasured one", () => {
    for (const op of air.operations) op.state = "blocked";
    expect(checkNamed(air, "static/surface_at_rest_within_disclosure_budget").detail).toContain(
      "no approved operation is served",
    );
    expect(checkNamed(air, "static/ladder_preserves_approved_surface").detail).toBe(
      "no approved operation to preserve",
    );
  });
});

describe("the checks are a pure function of the contract", () => {
  it("returns identical results across runs", () => {
    overBudget(air);
    expect(staticChecks(air)).toEqual(staticChecks(air));
  });

  it("does not depend on capability declaration order", () => {
    overBudget(air);
    const forward = staticChecks(air);
    air.capabilities = [...air.capabilities].reverse();
    expect(staticChecks(air)).toEqual(forward);
  });

  it("leaves every other static check passing on a laddered document", () => {
    overBudget(air);
    expect(staticChecks(air).filter((c) => !c.ok)).toEqual([]);
  });
});
