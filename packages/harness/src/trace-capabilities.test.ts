import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AirDocument, Operation } from "@anvil/air";
import { Operation as OperationSchema } from "@anvil/air";
import { type ExecutionRecord, JsonlRecordSpool } from "@anvil/runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cooccurrencePairs,
  deriveGroupings,
  detectUbiquitousOperations,
  groupTraces,
  MIN_TRACES_FOR_GROUPING,
  runTraceCapabilities,
  UBIQUITY_MIN_SHAPES,
} from "./trace-capabilities.js";

/**
 * The observed-capability lane. Two things matter most here and both are
 * failures this repository has already paid for once, in the structural
 * composition lane:
 *
 *  1. The spool the RUNTIME writes must be the spool this lane reads, so the
 *     round trip is driven through `JsonlRecordSpool` rather than a hand-built
 *     fixture file.
 *  2. A ubiquitous operation must be gone BEFORE grouping, not argued away
 *     after. `/fcubsWarningResp` was 64% of every candidate member in the
 *     FLEXCUBE report; the behavioural equivalent is an auth call in every
 *     trace, and the assertion below is that it never reaches a member list.
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anvil-trace-caps-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function record(traceId: string, operationId: string): ExecutionRecord {
  return {
    traceId,
    operationId,
    effect: "read",
    outcome: "success",
    latencyMs: 4,
    retryCount: 0,
    idempotencyKeyPresent: false,
    requestBytes: 0,
    responseBytes: 64,
    policyDecisions: [],
    confirmationRequired: false,
    confirmed: false,
  };
}

function op(id: string, overrides: Record<string, unknown> = {}): Operation {
  return OperationSchema.parse({
    id,
    canonicalName: id.replace(/\./g, "_"),
    displayName: id,
    sourceRef: { kind: "openapi", path: `/${id}`, method: "get" },
    effect: { kind: "read", resource: "ticket", risk: "none", reversible: true },
    input: { params: [] },
    idempotency: { mode: "natural", keyDerivation: "none" },
    retries: { mode: "safe", maxAttempts: 2, backoff: "exponential_jitter", retryOn: ["http_503"] },
    confirmation: { required: false },
    auth: { type: "none", scopes: [] },
    cli: { command: id.replace(/\./g, " ") },
    mcp: { toolName: id.replace(/\./g, "_") },
    skill: { intentExamples: [] },
    state: "approved",
    ...overrides,
  });
}

function airWith(...operations: Operation[]): AirDocument {
  return {
    service: { id: "zendesk", version: "1.0.0", servers: [] },
    operations,
    capabilities: [],
    workflows: [],
    diagnostics: [],
  } as unknown as AirDocument;
}

/** A trace, as this lane models one. */
const trace = (traceId: string, sequence: string[]) => ({ traceId, sequence });

describe("trace aggregation", () => {
  it("folds records into traces in first-call order, deduping repeats", () => {
    const traces = groupTraces([
      { ...record("t-1", "a"), at: "2026-08-28T01:00:00Z" },
      { ...record("t-1", "b"), at: "2026-08-28T01:00:01Z" },
      // A retry of `a` must not move it to the end: order is first use.
      { ...record("t-1", "a"), at: "2026-08-28T01:00:02Z" },
      { ...record("t-2", "b") },
    ] as never);
    expect(traces).toHaveLength(2);
    expect(traces[0]).toMatchObject({
      traceId: "t-1",
      sequence: ["a", "b"],
      firstAt: "2026-08-28T01:00:00Z",
      lastAt: "2026-08-28T01:00:02Z",
    });
    expect(traces[1]?.sequence).toEqual(["b"]);
  });

  it("counts pair co-occurrence with the direction each was first called in", () => {
    const pairs = cooccurrencePairs([
      trace("t-1", ["a", "b"]),
      trace("t-2", ["a", "b"]),
      trace("t-3", ["b", "a"]),
      trace("t-4", ["a", "c"]),
    ]);
    expect(pairs[0]).toEqual({ a: "a", b: "b", traces: 3, aBeforeB: 2, bBeforeA: 1 });
    expect(pairs[1]).toEqual({ a: "a", b: "c", traces: 1, aBeforeB: 1, bBeforeA: 0 });
  });
});

describe("the ubiquity pre-filter", () => {
  it("suppresses an operation present in nearly every distinct trace shape", () => {
    const traces = [
      trace("t-1", ["auth", "x1", "x2"]),
      trace("t-2", ["auth", "y1", "y2"]),
      trace("t-3", ["auth", "z1", "z2"]),
      trace("t-4", ["auth", "w1", "w2"]),
    ];
    const suppressed = detectUbiquitousOperations(traces);
    expect(suppressed.map((s) => s.operationId)).toEqual(["auth"]);
    expect(suppressed[0]).toMatchObject({
      shapes: 4,
      shapeFraction: 1,
      traces: 4,
      reason: "ubiquitous_across_trace_shapes",
    });
  });

  it("keeps an operation whose breadth is below the shape fraction", () => {
    // Present in 3 of 5 shapes (0.6) — real but not ubiquitous.
    const traces = [
      trace("t-1", ["shared", "x1"]),
      trace("t-2", ["shared", "y1"]),
      trace("t-3", ["shared", "z1"]),
      trace("t-4", ["p1", "p2"]),
      trace("t-5", ["q1", "q2"]),
    ];
    expect(detectUbiquitousOperations(traces)).toEqual([]);
  });

  it("declines to fire when there are too few shapes to discriminate between", () => {
    // Every operation is in 100% of shapes here, because there is only one
    // shape. Suppressing them all would delete the very task being observed;
    // UBIQUITY_MIN_SHAPES is what stops that.
    const traces = Array.from({ length: 20 }, (_, i) => trace(`t-${i}`, ["a", "b", "c"]));
    expect(new Set(traces.map((t) => t.sequence.join()))).toHaveLength(1);
    expect(UBIQUITY_MIN_SHAPES).toBeGreaterThan(1);
    expect(detectUbiquitousOperations(traces)).toEqual([]);
  });

  it("measures breadth in shapes, so one very hot task cannot look ubiquitous", () => {
    // `hot1`/`hot2` run 100 times but in one shape; `auth` runs in all three.
    const traces = [
      ...Array.from({ length: 100 }, (_, i) => trace(`hot-${i}`, ["auth", "hot1", "hot2"])),
      trace("m-1", ["auth", "m1", "m2"]),
      trace("n-1", ["auth", "n1", "n2"]),
    ];
    expect(detectUbiquitousOperations(traces).map((s) => s.operationId)).toEqual(["auth"]);
  });
});

describe("grouping derivation", () => {
  const air = airWith(op("a"), op("b"), op("c"));

  it("proposes a shape seen at or above the floor and refuses one below it", () => {
    const atFloor = Array.from({ length: MIN_TRACES_FOR_GROUPING }, (_, i) =>
      trace(`t-${i}`, ["a", "b"]),
    );
    expect(
      deriveGroupings({ traces: atFloor, suppressed: new Set(), air, sourceRef: "records:x" }),
    ).toHaveLength(1);

    const belowFloor = atFloor.slice(0, MIN_TRACES_FOR_GROUPING - 1);
    expect(
      deriveGroupings({ traces: belowFloor, suppressed: new Set(), air, sourceRef: "records:x" }),
    ).toEqual([]);
  });

  it("reports the dominant call order and how contested it was", () => {
    const traces = [
      ...Array.from({ length: 4 }, (_, i) => trace(`f-${i}`, ["a", "b"])),
      ...Array.from({ length: 2 }, (_, i) => trace(`r-${i}`, ["b", "a"])),
    ];
    const [grouping] = deriveGroupings({
      traces,
      suppressed: new Set(),
      air,
      sourceRef: "records:x",
    });
    expect(grouping).toMatchObject({
      operationIds: ["a", "b"],
      traces: 6,
      dominantOrder: ["a", "b"],
      dominantOrderTraces: 4,
      distinctOrders: 2,
    });
    expect(grouping?.evidence.map((claim) => claim.predicate)).toEqual([
      "cooccurrence",
      "sequence",
    ]);
    // Provenance is the count, not a confidence somebody would have to defend.
    expect(grouping?.evidence[0]?.source).toBe("recorded_traffic");
    expect(grouping?.evidence[0]?.note).toContain("6 of 6 recorded trace(s)");
  });

  it("gives the same observed task the same id across runs", () => {
    const traces = Array.from({ length: 5 }, (_, i) => trace(`t-${i}`, ["b", "a"]));
    const once = deriveGroupings({ traces, suppressed: new Set(), air, sourceRef: "records:x" });
    const again = deriveGroupings({
      // Same set, different order and different trace ids.
      traces: Array.from({ length: 5 }, (_, i) => trace(`u-${i}`, ["a", "b"])),
      suppressed: new Set(),
      air,
      sourceRef: "records:y",
    });
    expect(once[0]?.id).toBe(again[0]?.id);
    expect(once[0]?.id).toMatch(/^observed\.[0-9a-f]{12}$/);
  });

  it("never admits a suppressed operation as a member", () => {
    const traces = Array.from({ length: 5 }, (_, i) => trace(`t-${i}`, ["auth", "a", "b"]));
    const [grouping] = deriveGroupings({
      traces,
      suppressed: new Set(["auth"]),
      air,
      sourceRef: "records:x",
    });
    expect(grouping?.operationIds).toEqual(["a", "b"]);
  });

  it("drops a trace left with fewer than two operations after filtering", () => {
    const traces = Array.from({ length: 5 }, (_, i) => trace(`t-${i}`, ["auth", "a"]));
    expect(
      deriveGroupings({ traces, suppressed: new Set(["auth"]), air, sourceRef: "records:x" }),
    ).toEqual([]);
  });
});

describe("the lane end to end", () => {
  it("turns a real spool into a review-bound proposal, with the pre-filter applied", () => {
    const spool = new JsonlRecordSpool(dir);
    // A Zendesk-shaped estate: the vendor's tag taxonomy puts these in three
    // different capabilities, but one task uses all three together.
    const triage = ["zendesk.tickets.get", "zendesk.comments.list", "zendesk.users.get"];
    const history = ["zendesk.users.get", "zendesk.orgs.get"];
    const macros = ["zendesk.macros.list", "zendesk.macros.apply"];
    // Every trace starts by authenticating: the behavioural transport envelope.
    const drive = (prefix: string, ops: string[], times: number) => {
      for (let i = 0; i < times; i++) {
        spool.onRecord(record(`${prefix}-${i}`, "zendesk.auth.whoami"));
        for (const id of ops) spool.onRecord(record(`${prefix}-${i}`, id));
      }
    };
    drive("triage", triage, 8);
    drive("history", history, 6);
    drive("macros", macros, 5);
    // Below the floor: three traces of a fourth shape.
    drive("rare", ["zendesk.brands.list", "zendesk.brands.get"], 3);

    const air = airWith(
      op("zendesk.auth.whoami", { capabilityId: "zendesk.auth" }),
      op("zendesk.tickets.get", { capabilityId: "zendesk.tickets" }),
      op("zendesk.comments.list", { capabilityId: "zendesk.comments" }),
      op("zendesk.users.get", { capabilityId: "zendesk.users" }),
      op("zendesk.orgs.get", { capabilityId: "zendesk.organizations" }),
      op("zendesk.macros.list", { capabilityId: "zendesk.macros" }),
      op("zendesk.macros.apply", { capabilityId: "zendesk.macros" }),
      op("zendesk.brands.list", { capabilityId: "zendesk.brands" }),
      op("zendesk.brands.get", { capabilityId: "zendesk.brands" }),
    );
    const report = runTraceCapabilities({ air, dir });

    expect(report.ok).toBe(true);
    expect(report.summary.traces).toBe(22);
    expect(report.summary.traceShapes).toBe(4);

    // The pre-filter removed the operation that co-occurs with everything.
    expect(report.suppressedUbiquitousOperations.map((s) => s.operationId)).toEqual([
      "zendesk.auth.whoami",
    ]);
    expect(report.suppressedUbiquitousOperations[0]).toMatchObject({ shapes: 4, shapeFraction: 1 });

    // …and it is in NO grouping. This is the assertion the whole design exists
    // for: without it, the auth call joins all three tasks and the groupings
    // collapse into one undifferentiated blob.
    for (const grouping of report.groupings) {
      expect(grouping.operationIds).not.toContain("zendesk.auth.whoami");
    }
    // Nor in the co-occurrence table a reviewer reads.
    for (const pair of report.cooccurrence) {
      expect([pair.a, pair.b]).not.toContain("zendesk.auth.whoami");
    }

    // Three shapes clear the floor; the fourth (3 traces) does not.
    expect(report.groupings.map((g) => g.operationIds)).toEqual([
      ["zendesk.comments.list", "zendesk.tickets.get", "zendesk.users.get"],
      ["zendesk.orgs.get", "zendesk.users.get"],
      ["zendesk.macros.apply", "zendesk.macros.list"],
    ]);
    expect(report.groupings.map((g) => g.traces)).toEqual([8, 6, 5]);

    // The finding the tag taxonomy cannot produce: two of three observed tasks
    // cut across the vendor's own capability boundaries.
    expect(report.groupings.map((g) => g.crossesExistingCapabilities)).toEqual([true, true, false]);
    expect(report.groupings[0]?.spansCapabilities).toEqual([
      "zendesk.comments",
      "zendesk.tickets",
      "zendesk.users",
    ]);

    // Propose-only, baked into the report the way `capability compose` bakes it.
    expect(report.boundary).toMatchObject({
      autoApproved: false,
      writesAir: false,
      buildReady: false,
    });
    // AIR is untouched: nothing here writes a capability.
    expect(air.capabilities).toEqual([]);
  });

  it("drops traffic naming an operation this AIR does not carry", () => {
    const spool = new JsonlRecordSpool(dir);
    for (let i = 0; i < 5; i++) {
      spool.onRecord(record(`t-${i}`, "zendesk.tickets.get"));
      spool.onRecord(record(`t-${i}`, "zendesk.users.get"));
      spool.onRecord(record(`t-${i}`, "zendesk.renamed.away"));
    }
    const report = runTraceCapabilities({
      air: airWith(op("zendesk.tickets.get"), op("zendesk.users.get")),
      dir,
    });
    expect(report.unknownOperationIds).toEqual(["zendesk.renamed.away"]);
    expect(report.groupings[0]?.operationIds).toEqual(["zendesk.tickets.get", "zendesk.users.get"]);
  });

  it("refuses to call an empty spool a success", () => {
    const report = runTraceCapabilities({ air: airWith(op("a")), dir });
    expect(report.ok).toBe(false);
    expect(report.detail).toContain("No records parsed");
    expect(report.groupings).toEqual([]);
  });
});
