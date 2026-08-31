// Pins the naming-conformance oracle's semantics and — load-bearing for the
// mutation gate — the ratchet's growth trip: deleting the growth comparison in
// compareNamingConformance must turn this file red (see
// tools/mutation/mutants.json, "corpus/naming-ratchet-fails-on-growth").
import { snakeCase } from "@anvil/air";
import { singularize } from "@anvil/compiler";
import { describe, expect, it } from "vitest";
import {
  compareNamingConformance,
  measureNamingConformance,
  namingConformanceOracle,
} from "./naming-conformance.mjs";

const deps = { singularize, snakeCase };

interface OpSpec {
  resource: string;
  canonicalName: string;
  displayName: string;
  toolName: string;
  operationId?: string;
}

const op = (spec: OpSpec) => ({
  effect: { resource: spec.resource },
  canonicalName: spec.canonicalName,
  displayName: spec.displayName,
  mcp: { toolName: spec.toolName },
  sourceRef: { operationId: spec.operationId },
});

const doc = (service: string, ops: ReturnType<typeof op>[]) => ({
  service: { id: service },
  operations: ops,
});

describe("measureNamingConformance", () => {
  it("counts a resource sharing no token with its own names, and none other", () => {
    const air = doc("svc", [
      // Zero overlap: "me" appears nowhere in the operation's own name text.
      op({
        resource: "me",
        canonicalName: "show_current_user",
        displayName: "Show the current user",
        toolName: "svc_show_current_user",
        operationId: "show_current_user",
      }),
      // Partial overlap is NOT zero overlap: "count" is in the canonicalName
      // even though "many" is not.
      op({
        resource: "count_many",
        canonicalName: "get_view_counts",
        displayName: "Count Tickets in Views",
        toolName: "svc_get_view_counts",
        operationId: "get_view_counts",
      }),
      // Overlap through singularization: resource "view" vs name token "views".
      op({
        resource: "view",
        canonicalName: "list_views",
        displayName: "List Views",
        toolName: "svc_list_views",
        operationId: "list_views",
      }),
    ]);
    expect(measureNamingConformance(air, deps).zeroOverlapResource).toBe(1);
  });

  it("splits tool-name stutter by cause, the way the naming audit does", () => {
    const air = doc("orders", [
      // The vendor's own operationId already repeats: spec_authored.
      op({
        resource: "order",
        canonicalName: "orders_orders_get",
        displayName: "Orders orders get",
        toolName: "orders_svc_orders_orders_get",
        operationId: "orders_orders_get",
      }),
      // The repeat appears only once the service id is prefixed:
      // service_prefix_join.
      op({
        resource: "order",
        canonicalName: "orders_get",
        displayName: "Orders get",
        toolName: "orders_orders_get",
        operationId: "orders_get",
      }),
      // The repeat exists only in the resolved tool name — the collision
      // resolver appended a token the name already ended with:
      // disambiguation_suffix.
      op({
        resource: "activity",
        canonicalName: "count_activities",
        displayName: "Count Activities",
        toolName: "orders_count_activities_activities",
        operationId: "count_activities",
      }),
      // No stutter at all.
      op({
        resource: "activity",
        canonicalName: "list_activities",
        displayName: "List Activities",
        toolName: "orders_list_activities",
        operationId: "list_activities",
      }),
    ]);
    expect(measureNamingConformance(air, deps).stutters).toEqual({
      spec_authored: 1,
      service_prefix_join: 1,
      disambiguation_suffix: 1,
    });
  });

  it("flags the singularize-over-strip shape (releases -> releas)", () => {
    const air = doc("svc", [
      op({
        resource: "releas",
        canonicalName: "list_releases",
        displayName: "List releases",
        toolName: "svc_list_releases",
        operationId: "list_releases",
      }),
      // A resource that IS a word of its own names is never a candidate.
      op({
        resource: "release",
        canonicalName: "get_release",
        displayName: "Get release",
        toolName: "svc_get_release",
        operationId: "get_release",
      }),
    ]);
    expect(measureNamingConformance(air, deps).overStrippedResources).toBe(1);
  });
});

describe("compareNamingConformance — the ratchet", () => {
  const counters = (overrides: Record<string, number> = {}) => ({
    operations: 10,
    zeroOverlapResource: overrides.zeroOverlapResource ?? 2,
    stutters: {
      spec_authored: overrides.spec_authored ?? 1,
      service_prefix_join: overrides.service_prefix_join ?? 0,
      disambiguation_suffix: overrides.disambiguation_suffix ?? 3,
    },
    overStrippedResources: overrides.overStrippedResources ?? 1,
  });

  it("fails when any counter grows past the baseline", () => {
    const { failures, improvements } = compareNamingConformance(
      counters({ disambiguation_suffix: 4 }),
      counters(),
    );
    expect(failures).toEqual(["stutters.disambiguation_suffix grew 3 -> 4"]);
    expect(improvements).toEqual([]);
  });

  it("holds green on equality and reports shrinkage as an improvement to bank", () => {
    expect(compareNamingConformance(counters(), counters())).toEqual({
      failures: [],
      improvements: [],
    });
    const improved = compareNamingConformance(counters({ zeroOverlapResource: 0 }), counters());
    expect(improved.failures).toEqual([]);
    expect(improved.improvements).toEqual(["zeroOverlapResource improved 2 -> 0"]);
  });

  it("treats a counter absent from the baseline as zero, so growth cannot hide behind an old record", () => {
    const { failures } = compareNamingConformance(counters(), {
      operations: 10,
      zeroOverlapResource: 2,
      // no stutters, no overStrippedResources: recorded before those existed
    });
    expect(failures).toContain("stutters.spec_authored grew 0 -> 1");
    expect(failures).toContain("stutters.disambiguation_suffix grew 0 -> 3");
    expect(failures).toContain("overStrippedResources grew 0 -> 1");
  });

  it("never fails growth in `operations` itself — op-count drift has its own oracle", () => {
    const grown = { ...counters(), operations: 99 };
    expect(compareNamingConformance(grown, counters()).failures).toEqual([]);
  });
});

describe("namingConformanceOracle", () => {
  const measured = {
    operations: 3,
    zeroOverlapResource: 1,
    stutters: { spec_authored: 0, service_prefix_join: 0, disambiguation_suffix: 0 },
    overStrippedResources: 0,
  };

  it("fails without a baseline entry and names the recording command", () => {
    const oracle = namingConformanceOracle(measured, undefined, "record-cmd");
    expect(oracle.ok).toBe(false);
    expect(oracle.detail).toContain("record-cmd");
  });

  it("goes red on growth and green (with improvements surfaced) on shrinkage", () => {
    const red = namingConformanceOracle(measured, { ...measured, zeroOverlapResource: 0 }, "cmd");
    expect(red.ok).toBe(false);
    expect(red.detail).toBe("zeroOverlapResource grew 0 -> 1");

    const green = namingConformanceOracle(measured, { ...measured, zeroOverlapResource: 2 }, "cmd");
    expect(green.ok).toBe(true);
    expect(green.improvements).toEqual(["zeroOverlapResource improved 2 -> 1"]);
  });
});
