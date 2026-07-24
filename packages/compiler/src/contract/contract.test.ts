import { describe, expect, it } from "vitest";
import { compile } from "../compile.js";
import { parseManifest } from "../manifest.js";
import { ephemeralCompilerSource } from "../source/compiler-source.js";
import { overlayDigest } from "./digest.js";
import type { PolicyOverlay, SemanticOverlayAssertion } from "./model.js";
import { SemanticOverlayAssertion as SemanticOverlayAssertionSchema } from "./model.js";
import { makeOverlay, manifestToOverlay } from "./overlay.js";
import { compileContract } from "./snapshot.js";

const SPEC = `openapi: "3.0.3"
info: { title: Payments, version: "1.0.0" }
paths:
  /items:
    get:
      operationId: listItems
      responses: { "200": { description: ok } }
  /payments/{id}/refunds:
    post:
      operationId: refundPayment
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
      responses: { "201": { description: created } }
`;

const source = () => ephemeralCompilerSource(SPEC, "openapi.yaml");

/** Build an operation-scoped assertion tersely. */
function assertion(
  ref: string,
  predicate: SemanticOverlayAssertion["predicate"],
  operation: SemanticOverlayAssertion["operation"],
  value: unknown,
  evidenceRefs: string[] = [],
): SemanticOverlayAssertion {
  return { target: { scope: "operation", ref }, predicate, operation, value, evidenceRefs };
}

function contractOf(result: Awaited<ReturnType<typeof compileContract>>) {
  return result.status === "resolved" ? result.contract : result.partialContract;
}

function op(result: Awaited<ReturnType<typeof compileContract>>, opId: string) {
  return contractOf(result).air.operations.find((o) => o.sourceRef.operationId === opId);
}

describe("overlay assertion values are real JSON (#3)", () => {
  it("accepts nested JSON values and rejects non-JSON ones", () => {
    const base = {
      target: { scope: "operation", ref: "x" },
      predicate: "auth.scopes",
      operation: "set",
    };
    // A finite, serializable value parses.
    expect(
      SemanticOverlayAssertionSchema.safeParse({ ...base, value: { a: [1, "two", null, true] } })
        .success,
    ).toBe(true);
    // NaN / undefined-bearing / function values are not JSON — rejected at the boundary.
    expect(SemanticOverlayAssertionSchema.safeParse({ ...base, value: Number.NaN }).success).toBe(
      false,
    );
    expect(SemanticOverlayAssertionSchema.safeParse({ ...base, value: () => 1 }).success).toBe(
      false,
    );
    // A value-less operation (e.g. remove) is still valid.
    expect(SemanticOverlayAssertionSchema.safeParse({ ...base, operation: "remove" }).success).toBe(
      true,
    );
  });
});

describe("compileContract — snapshot identity and determinism", () => {
  it("binds the contract to the source and stamps a content digest", async () => {
    const result = await compileContract(source());
    expect(result.status).toBe("resolved");
    const c = contractOf(result);
    expect(c.source.snapshotId).toBe(source().snapshotId);
    expect(c.source.sourceHash).toBe(source().sourceHash);
    expect(c.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(c.id).toBe(`contract_${c.digest.slice(0, 12)}`);
  });

  it("same source + same overlays → byte-identical contract digest", async () => {
    const overlay = manifestToOverlay(
      parseManifest("operations:\n  refundPayment:\n    confirmation: { required: true }\n"),
    );
    const a = await compileContract(source(), [overlay]);
    const b = await compileContract(source(), [overlay]);
    expect(contractOf(a).digest).toBe(contractOf(b).digest);
  });

  it("overlay order does not change the result for commutative overlays", async () => {
    // Two overlays touching different operations commute.
    const oItems = makeOverlay({
      origin: "operator",
      assertions: [assertion("listItems", "description", "set", "List all items.")],
    });
    const oRefund = makeOverlay({
      origin: "operator",
      assertions: [assertion("refundPayment", "confirmation.required", "restrict", true)],
    });
    const ab = await compileContract(source(), [oItems, oRefund]);
    const ba = await compileContract(source(), [oRefund, oItems]);
    expect(contractOf(ab).digest).toBe(contractOf(ba).digest);
  });
});

describe("manifest ⇄ overlay migration", () => {
  it("a manifest applied as an overlay yields the same operation semantics", async () => {
    const manifestText = `operations:
  refundPayment:
    risk: financial
    idempotency: { strategy: required_request_key, key_location: header, header: Idempotency-Key }
    confirmation: { required: true }
    retries: { enabled: false }
`;
    const viaManifest = await compile({
      spec: SPEC,
      manifest: manifestText,
      serviceId: "payments",
    });
    const viaOverlay = await compileContract(
      source(),
      [manifestToOverlay(parseManifest(manifestText))],
      {
        serviceId: "payments",
      },
    );

    const m = viaManifest.operations.find((o) => o.sourceRef.operationId === "refundPayment");
    const o = op(viaOverlay, "refundPayment");
    expect(o?.effect.risk).toBe(m?.effect.risk);
    expect(o?.idempotency).toEqual(m?.idempotency);
    expect(o?.retries).toEqual(m?.retries);
    expect(o?.confirmation).toEqual(m?.confirmation);
    // The one application path stamps the same manifest-enriched claim.
    expect(o?.evidence.claims.some((c) => c.predicate === "enriched")).toBe(true);
  });

  it("round-trips issuer and carrier without conflating the token endpoint", async () => {
    const manifestText = `operations:
  refundPayment:
    auth:
      type: oauth2_on_behalf_of
      principal: delegated
      issuer: https://issuer.example.com/
      audience: api://payments
      carrier: { in: header, name: Authorization, scheme: Bearer }
      provider:
        grant: token_exchange
        token_endpoint: https://sts.example.com/oauth/token
`;
    const viaManifest = await compile({
      spec: SPEC,
      manifest: manifestText,
      serviceId: "payments",
    });
    const viaOverlay = await compileContract(
      source(),
      [manifestToOverlay(parseManifest(manifestText))],
      { serviceId: "payments" },
    );
    const left = viaManifest.operations.find(
      (operation) => operation.sourceRef.operationId === "refundPayment",
    )?.auth;
    const right = op(viaOverlay, "refundPayment")?.auth;
    expect(right).toEqual(left);
    expect(right?.issuer).toBe("https://issuer.example.com/");
    expect(right?.provider?.tokenEndpoint).toBe("https://sts.example.com/oauth/token");
  });
});

describe("name override — re-homing a weakly-named operation (#A)", () => {
  // A vague verb over a real resource: `doTransition` is the canonical case an
  // agent cannot route on (Atlassian's own MCP server renames it).
  const WEAK = `openapi: "3.0.3"
info: { title: Tracker, version: "1.0.0" }
paths:
  /issues/{id}/transitions:
    post:
      operationId: doTransition
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
      responses: { "200": { description: ok } }
`;

  it("flags the weak name, then re-homes every surface together and clears the flag", async () => {
    const before = await compile({ spec: WEAK, serviceId: "tracker" });
    const weak = before.operations.find((o) => o.sourceRef.operationId === "doTransition");
    expect(weak?.canonicalName).toBe("do_transition");
    // The naming pass scored it below the review threshold (vague verb).
    const conf = weak?.evidence.claims.find((c) => c.predicate === "name.quality")?.confidence ?? 1;
    expect(conf).toBeLessThan(0.5);

    const manifestText = `operations:
  doTransition:
    name: { resource: issue, verb: transition }
`;
    const after = await compile({ spec: WEAK, manifest: manifestText, serviceId: "tracker" });
    const fixed = after.operations.find((o) => o.sourceRef.operationId === "doTransition");
    // One triple re-projects all three surfaces coherently — no drift.
    expect(fixed?.canonicalName).toBe("transition_issue");
    expect(fixed?.cli.command).toBe("tracker issue transition");
    expect(fixed?.mcp.toolName).toBe("tracker_transition_issue");
    // The stable id is preserved — a rename is not a new operation.
    expect(fixed?.id).toBe(weak?.id);
    // The name is now operator-authored, so it is no longer low-confidence.
    const fixedConf =
      fixed?.evidence.claims.find((c) => c.predicate === "name.quality")?.confidence ?? 0;
    expect(fixedConf).toBeGreaterThanOrEqual(0.9);
  });

  it("applies identically through the overlay path (manifest ⇄ overlay parity)", async () => {
    const manifestText = `operations:
  doTransition:
    name: { resource: issue, verb: transition }
`;
    const viaOverlay = await compileContract(
      ephemeralCompilerSource(WEAK, "openapi.yaml"),
      [manifestToOverlay(parseManifest(manifestText))],
      { serviceId: "tracker" },
    );
    const o = op(viaOverlay, "doTransition");
    expect(o?.canonicalName).toBe("transition_issue");
    expect(o?.mcp.toolName).toBe("tracker_transition_issue");
  });
});

describe("overlay digest — dedupe and order independence", () => {
  it("a duplicated assertion does not change the overlay digest", async () => {
    const a = assertion("refundPayment", "confirmation.required", "set", true);
    const single = overlayDigest({ origin: "operator", assertions: [a], evidence: [] });
    const doubled = overlayDigest({ origin: "operator", assertions: [a, { ...a }], evidence: [] });
    // Equivalent assertions collapse under the canonical set — order/duplication
    // do not change identity.
    const reordered = overlayDigest({
      origin: "operator",
      assertions: [
        assertion("refundPayment", "confirmation.required", "set", true),
        assertion("listItems", "description", "set", "x"),
      ],
      evidence: [],
    });
    const reorderedFlipped = overlayDigest({
      origin: "operator",
      assertions: [
        assertion("listItems", "description", "set", "x"),
        assertion("refundPayment", "confirmation.required", "set", true),
      ],
      evidence: [],
    });
    expect(doubled).toBe(single);
    expect(reordered).toBe(reorderedFlipped);
  });
});

describe("resolution policy", () => {
  it("restrictions combine: scopes union across overlays", async () => {
    const a = makeOverlay({
      origin: "gateway",
      assertions: [assertion("refundPayment", "auth.scopes", "restrict", ["payments.write"])],
    });
    const b = makeOverlay({
      origin: "operator",
      assertions: [assertion("refundPayment", "auth.scopes", "restrict", ["refunds.write"])],
    });
    const result = await compileContract(source(), [a, b]);
    expect(result.status).toBe("resolved");
    expect(op(result, "refundPayment")?.auth.scopes).toEqual(["payments.write", "refunds.write"]);
  });

  it("tightening succeeds: restrict confirmation on a read", async () => {
    const overlay = makeOverlay({
      origin: "operator",
      assertions: [assertion("listItems", "confirmation.required", "restrict", true)],
    });
    const result = await compileContract(source(), [overlay]);
    expect(result.status).toBe("resolved");
    expect(op(result, "listItems")?.confirmation.required).toBe(true);
  });

  it("safety loosening conflicts: contradictory confirmation sets", async () => {
    const a = makeOverlay({
      origin: "operator",
      assertions: [assertion("refundPayment", "confirmation.required", "set", true, ["ev-a"])],
      evidence: [{ id: "ev-a", kind: "incident" }],
    });
    const b = makeOverlay({
      origin: "operator",
      assertions: [assertion("refundPayment", "confirmation.required", "set", false, ["ev-b"])],
      evidence: [{ id: "ev-b", kind: "doc_example" }],
    });
    const result = await compileContract(source(), [a, b]);
    expect(result.status).toBe("conflicted");
    if (result.status !== "conflicted") throw new Error("expected conflict");
    const conflict = result.conflicts.find((c) => c.predicate === "confirmation.required");
    expect(conflict?.safetySensitive).toBe(true);
    // The competing evidence stays attached to the conflict record.
    expect(conflict?.sides.flatMap((s) => s.evidenceRefs).sort()).toEqual(["ev-a", "ev-b"]);
    // The safer value is preserved in the partial contract (never silently loosened).
    expect(op(result, "refundPayment")?.confirmation.required).toBe(true);
  });

  it("contradictory retry on a mutation blocks the operation", async () => {
    const a = makeOverlay({
      origin: "operator",
      assertions: [assertion("refundPayment", "retries.mode", "set", "safe")],
    });
    const b = makeOverlay({
      origin: "operator",
      assertions: [assertion("refundPayment", "retries.mode", "set", "none")],
    });
    const result = await compileContract(source(), [a, b]);
    expect(result.status).toBe("conflicted");
    if (result.status !== "conflicted") throw new Error("expected conflict");
    expect(result.conflicts.some((c) => c.predicate === "retries.mode")).toBe(true);
    expect(op(result, "refundPayment")?.state).toBe("blocked");
  });

  it("an inferred overlay may not loosen safety without evidence", async () => {
    // Base: a financial refund confirms. An investigation set to drop the
    // confirmation, with no cited evidence, must be refused (safer base wins).
    const tighten = makeOverlay({
      origin: "operator",
      assertions: [assertion("refundPayment", "confirmation.required", "set", true)],
    });
    const base = await compileContract(source(), [tighten]);
    expect(op(base, "refundPayment")?.confirmation.required).toBe(true);

    const loosen: PolicyOverlay = makeOverlay({
      origin: "investigation",
      assertions: [assertion("refundPayment", "confirmation.required", "set", false)],
    });
    const result = await compileContract(source(), [tighten, loosen]);
    // The two sets tie at nothing (different authority); operator wins → stays true,
    // and even the standalone investigation loosening is refused on the base.
    const investigationOnly = await compileContract(source(), [loosen]);
    expect(op(result, "refundPayment")?.confirmation.required).toBe(true);
    expect(op(investigationOnly, "refundPayment")?.confirmation.required).toBe(true);
  });

  it("an inferred overlay may not upgrade idempotency without evidence", async () => {
    // A non-idempotent POST refund confirms and never auto-retries. An
    // investigation claiming it is naturally idempotent — with no evidence —
    // must be refused, or it would unlock retries and drop the confirmation.
    const loosen = makeOverlay({
      origin: "investigation",
      assertions: [assertion("refundPayment", "idempotency.mode", "set", "natural")],
    });
    const result = await compileContract(source(), [loosen]);
    const o = op(result, "refundPayment");
    expect(o?.idempotency.mode).toBe("none");
    expect(o?.retries.mode).toBe("none");
    expect(o?.confirmation.required).toBe(true);
  });

  it("a non-authoritative set may not drop required scopes", async () => {
    // The operator establishes two required scopes; an investigation `set` that
    // omits one cannot strip it — a non-authoritative set may only add.
    const establish = makeOverlay({
      origin: "operator",
      assertions: [
        assertion("refundPayment", "auth.scopes", "set", ["payments.write", "refunds.write"]),
      ],
    });
    const drop = makeOverlay({
      origin: "investigation",
      assertions: [assertion("refundPayment", "auth.scopes", "set", ["payments.write"])],
    });
    const result = await compileContract(source(), [establish, drop]);
    expect(op(result, "refundPayment")?.auth.scopes).toEqual(["payments.write", "refunds.write"]);
  });
});

describe("review fixes — authority, blocking, conflict surfacing", () => {
  it("a gateway may not loosen confirmation (not authoritative for it) but may tighten scopes", async () => {
    // Base refund confirms (financial mutation). A gateway 'set false' is refused.
    const loosen = makeOverlay({
      origin: "gateway",
      assertions: [assertion("refundPayment", "confirmation.required", "set", false)],
    });
    const result = await compileContract(source(), [loosen]);
    expect(op(result, "refundPayment")?.confirmation.required).toBe(true);

    // But the gateway IS authoritative for the scopes it enforces.
    const scoped = makeOverlay({
      origin: "gateway",
      assertions: [assertion("refundPayment", "auth.scopes", "restrict", ["refunds:write"])],
    });
    const ok = await compileContract(source(), [scoped]);
    expect(op(ok, "refundPayment")?.auth.scopes).toContain("refunds:write");
  });

  it("every safety-sensitive conflict blocks the operation and is carried on the snapshot", async () => {
    const a = makeOverlay({
      origin: "operator",
      assertions: [assertion("refundPayment", "confirmation.required", "set", true)],
    });
    const b = makeOverlay({
      origin: "operator",
      assertions: [assertion("refundPayment", "confirmation.required", "set", false)],
    });
    const result = await compileContract(source(), [a, b]);
    expect(result.status).toBe("conflicted");
    if (result.status !== "conflicted") throw new Error("expected conflict");
    // #4: the operation is blocked, not just retry conflicts.
    expect(op(result, "refundPayment")?.state).toBe("blocked");
    // #3: the snapshot itself records the conflict, surviving serialization.
    expect(result.partialContract.status).toBe("conflicted");
    expect(result.partialContract.conflicts.length).toBeGreaterThan(0);
    const air = result.partialContract.air;
    expect(result.partialContract.blockedOperationIds).toContain(
      air.operations.find((o) => o.sourceRef.operationId === "refundPayment")?.id,
    );
  });
});
