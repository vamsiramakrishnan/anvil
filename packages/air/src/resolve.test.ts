import { describe, expect, it } from "vitest";
import { loadAirDocument, type Operation, resolveOperation } from "./index.js";

/** A minimal valid operation with the identifiers the resolver tiers read. */
function op(id: string, canonicalName: string, cliCommand: string, toolName: string): Operation {
  return loadAirDocument({
    service: { id: "svc", version: "1", source: { kind: "openapi", uri: "./s.yaml" } },
    operations: [
      {
        id,
        canonicalName,
        displayName: canonicalName,
        sourceRef: { kind: "openapi", path: "/x", method: "get" },
        effect: { kind: "read", action: "get", risk: "none" },
        input: { params: [] },
        idempotency: { mode: "natural" },
        retries: { mode: "none" },
        confirmation: { required: false },
        auth: { type: "api_key" },
        cli: { command: cliCommand },
        mcp: { toolName },
        skill: { intentExamples: [] },
      },
    ],
  }).operations[0] as Operation;
}

const refundsCreate = op(
  "svc.refunds.create",
  "create_refund",
  "svc refunds create",
  "svc_create_refund",
);
const captureCreate = op(
  "svc.capture.create",
  "create_capture",
  "svc capture create",
  "svc_create_capture",
);
// An operation literally named `create` — exact identifier matches must beat
// the suffix matches the two ops above would produce.
const bareCreate = op("svc.jobs.run", "create", "svc jobs run", "svc_jobs_run");

const OPS = [refundsCreate, captureCreate, bareCreate];

describe("resolveOperation", () => {
  it("resolves each exact-identifier tier", () => {
    for (const [selector, matchedBy] of [
      ["svc.refunds.create", "id"],
      ["create_refund", "canonicalName"],
      ["svc_create_refund", "mcpToolName"],
      ["svc refunds create", "cliCommand"],
    ] as const) {
      const res = resolveOperation(OPS, selector);
      expect(res.status).toBe("resolved");
      if (res.status === "resolved") {
        expect(res.operation.id).toBe("svc.refunds.create");
        expect(res.matchedBy).toBe(matchedBy);
      }
    }
  });

  it("lets an exact match win over suffix matches (no tier mixing)", () => {
    // `create` is an exact canonicalName of one op AND an id/cli suffix of two
    // others; the exact tier wins outright and the suffixes are never consulted.
    const res = resolveOperation(OPS, "create");
    expect(res.status).toBe("resolved");
    if (res.status === "resolved") {
      expect(res.operation.id).toBe("svc.jobs.run");
      expect(res.matchedBy).toBe("canonicalName");
    }
  });

  it("resolves a unique suffix", () => {
    const byId = resolveOperation(OPS, "refunds.create");
    expect(byId).toMatchObject({ status: "resolved", matchedBy: "idSuffix" });
    const byCli = resolveOperation(OPS, "refunds create");
    expect(byCli).toMatchObject({ status: "resolved", matchedBy: "cliCommandSuffix" });
  });

  it("stops at an ambiguous tier instead of falling through", () => {
    // Without the bare `create` op, the selector hits the id-suffix tier where
    // TWO ops match. Even though the cli-suffix tier would also be ambiguous,
    // resolution must stop at the first ambiguous tier and report it.
    const res = resolveOperation([refundsCreate, captureCreate], "create");
    expect(res.status).toBe("ambiguous");
    if (res.status === "ambiguous") {
      expect(res.matchedBy).toBe("idSuffix");
      expect(res.candidates.map((c) => c.id)).toEqual(["svc.capture.create", "svc.refunds.create"]);
    }
  });

  it("returns not_found when no tier matches", () => {
    expect(resolveOperation(OPS, "nonexistent").status).toBe("not_found");
  });

  it("never depends on the order operations appear in AIR", () => {
    const forward = resolveOperation(OPS, "refunds create");
    const backward = resolveOperation([...OPS].reverse(), "refunds create");
    expect(backward).toEqual(forward);

    const ambForward = resolveOperation([refundsCreate, captureCreate], "create");
    const ambBackward = resolveOperation([captureCreate, refundsCreate], "create");
    expect(ambBackward).toEqual(ambForward);
  });
});
