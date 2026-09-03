import { Operation } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { applyHarObservedPosture } from "./har-posture.js";
import type { OpenApiDocument } from "./parse.js";

/**
 * A minimal but schema-VALID operation, built through `Operation.parse` so
 * every default the real compiler relies on (evidence.claims, reviewNotes,
 * tags, …) is exactly what a real compile would produce — not a hand-picked
 * subset that happens to satisfy today's fields.
 */
function baseOperation(overrides: Partial<Parameters<typeof Operation.parse>[0]> = {}) {
  return Operation.parse({
    id: "svc.widgets.get",
    canonicalName: "get_widget",
    displayName: "GET /widgets/{widget_id}",
    sourceRef: { kind: "har", path: "/widgets/{widget_id}", method: "get" },
    effect: { kind: "read", action: "get", resource: "widget", risk: "none", reversible: true },
    input: { params: [] },
    idempotency: { mode: "natural", mechanism: "none", keyDerivation: "none" },
    retries: { mode: "safe", basis: "read_safe", maxAttempts: 3, backoff: "none" },
    confirmation: { required: false },
    auth: { type: "none", scopes: [], principal: "anonymous", secretSource: "none" },
    cli: { command: "svc widgets get" },
    mcp: { toolName: "svc_get_widget" },
    skill: {},
    evidence: {
      claims: [
        {
          subject: "svc.widgets.get",
          predicate: "exists",
          value: true,
          source: "spec",
          confidence: 0.7,
        },
        {
          subject: "svc.widgets.get",
          predicate: "effect.kind",
          value: "read",
          source: "inferred",
          confidence: 0.9,
        },
        {
          subject: "svc.widgets.get",
          predicate: "idempotency.mode",
          value: "natural",
          source: "spec",
          confidence: 0.95,
        },
        {
          subject: "svc.widgets.get",
          predicate: "name.quality",
          value: "get_widget",
          source: "inferred",
          confidence: 0.8,
        },
      ],
    },
    ...overrides,
  });
}

function docWithObserved(
  path: string,
  method: string,
  observed: { samples: number; firstSeen?: string; lastSeen?: string },
): OpenApiDocument {
  return {
    openapi: "3.0.0",
    info: { title: "t", version: "1" },
    paths: { [path]: { [method]: { "x-anvil-observed": observed } } },
  };
}

describe("applyHarObservedPosture", () => {
  it("caps generated/approved down to review_required (tightening only)", () => {
    const generated = baseOperation({ state: "generated" });
    const approved = baseOperation({ state: "approved" });
    const doc = docWithObserved("/widgets/{widget_id}", "get", { samples: 1 });
    applyHarObservedPosture([generated, approved], doc);
    expect(generated.state).toBe("review_required");
    expect(approved.state).toBe("review_required");
  });

  it("never promotes an already-blocked operation — asymmetric trust, tightening only", () => {
    const blocked = baseOperation({ state: "blocked" });
    const doc = docWithObserved("/widgets/{widget_id}", "get", { samples: 1 });
    applyHarObservedPosture([blocked], doc);
    expect(blocked.state).toBe("blocked");
  });

  it("leaves an already-review_required operation as-is", () => {
    const reviewed = baseOperation({ state: "review_required" });
    const doc = docWithObserved("/widgets/{widget_id}", "get", { samples: 1 });
    applyHarObservedPosture([reviewed], doc);
    expect(reviewed.state).toBe("review_required");
  });

  it("reattributes safety-relevant claims to recorded_traffic, capped at 0.5", () => {
    const op = baseOperation();
    const doc = docWithObserved("/widgets/{widget_id}", "get", { samples: 1 });
    applyHarObservedPosture([op], doc);
    const effectClaim = op.evidence.claims.find((c) => c.predicate === "effect.kind");
    const idemClaim = op.evidence.claims.find((c) => c.predicate === "idempotency.mode");
    expect(effectClaim?.source).toBe("recorded_traffic");
    expect(effectClaim?.confidence).toBeLessThanOrEqual(0.5);
    expect(idemClaim?.source).toBe("recorded_traffic");
    expect(idemClaim?.confidence).toBeLessThanOrEqual(0.5);
  });

  it("never lowers a claim's confidence that was already below the cap", () => {
    const op = baseOperation();
    // effect.kind claim starts at 0.9 in the fixture; after the cap it must
    // be exactly 0.5, not something lower.
    const doc = docWithObserved("/widgets/{widget_id}", "get", { samples: 1 });
    applyHarObservedPosture([op], doc);
    const effectClaim = op.evidence.claims.find((c) => c.predicate === "effect.kind");
    expect(effectClaim?.confidence).toBe(0.5);
  });

  it("does not touch exists/name.quality claims — they carry no safety weight", () => {
    const op = baseOperation();
    const doc = docWithObserved("/widgets/{widget_id}", "get", { samples: 1 });
    applyHarObservedPosture([op], doc);
    const existsClaim = op.evidence.claims.find((c) => c.predicate === "exists");
    const nameClaim = op.evidence.claims.find((c) => c.predicate === "name.quality");
    expect(existsClaim?.source).toBe("spec");
    expect(existsClaim?.confidence).toBe(0.7);
    expect(nameClaim?.source).toBe("inferred");
    expect(nameClaim?.confidence).toBe(0.8);
  });

  it("adds a reviewNotes entry citing the exact sample count and time span", () => {
    const op = baseOperation();
    const doc = docWithObserved("/widgets/{widget_id}", "get", {
      samples: 7,
      firstSeen: "2026-01-01T00:00:00.000Z",
      lastSeen: "2026-01-02T00:00:00.000Z",
    });
    applyHarObservedPosture([op], doc);
    expect(op.reviewNotes.some((n) => n.includes("7 captured HTTP requests"))).toBe(true);
    expect(op.reviewNotes.some((n) => n.includes("first seen 2026-01-01"))).toBe(true);
    expect(op.reviewNotes.some((n) => n.includes("last seen 2026-01-02"))).toBe(true);
  });

  it("uses singular phrasing for exactly one sample", () => {
    const op = baseOperation();
    const doc = docWithObserved("/widgets/{widget_id}", "get", { samples: 1 });
    applyHarObservedPosture([op], doc);
    expect(op.reviewNotes.some((n) => n.includes("1 captured HTTP request "))).toBe(true);
  });

  it("falls back to a generic note when no x-anvil-observed extension is found", () => {
    const op = baseOperation();
    const doc: OpenApiDocument = {
      openapi: "3.0.0",
      info: { title: "t", version: "1" },
      paths: {},
    };
    applyHarObservedPosture([op], doc);
    expect(op.reviewNotes.some((n) => n.startsWith("Derived from a HAR capture"))).toBe(true);
  });

  it("is idempotent — applying it twice does not duplicate the review note", () => {
    const op = baseOperation();
    const doc = docWithObserved("/widgets/{widget_id}", "get", { samples: 1 });
    applyHarObservedPosture([op], doc);
    applyHarObservedPosture([op], doc);
    const matches = op.reviewNotes.filter((n) => n.includes("captured HTTP request"));
    expect(matches).toHaveLength(1);
  });
});
