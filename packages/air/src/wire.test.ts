import { describe, expect, it } from "vitest";
import { SourceKind } from "./enums.js";
import { Operation as OperationSchema } from "./schema.js";
import {
  RUNTIME_WIRE_PROTOCOL,
  unexecutableWireFailures,
  wireExecutability,
  wireProtocolFor,
} from "./wire.js";

function op(kind: string, id = "svc.thing.get", state = "approved") {
  return OperationSchema.parse({
    id,
    canonicalName: "get_thing",
    displayName: "Get thing",
    sourceRef: { kind, path: "/thing", method: "get" },
    effect: { kind: "read", resource: "thing", risk: "low", reversible: true },
    input: { params: [] },
    idempotency: { mode: "natural", keyDerivation: "none" },
    retries: { mode: "safe", maxAttempts: 2, backoff: "exponential_jitter", retryOn: [] },
    confirmation: { required: false },
    auth: { type: "none", scopes: [] },
    cli: { command: "svc thing get" },
    mcp: { toolName: "svc_get_thing" },
    skill: { intentExamples: [] },
    state,
  });
}

describe("wire protocol", () => {
  it("is total over SourceKind, so there is no unknown case to fall through", () => {
    // The guard against the failure mode this module was written to end: a new
    // source format arriving and quietly inheriting "whatever REST does".
    for (const kind of SourceKind.options) {
      expect(() => wireProtocolFor({ kind })).not.toThrow();
      expect(typeof wireProtocolFor({ kind })).toBe("string");
    }
  });

  it("does not conflate a source format with a wire protocol", () => {
    expect(wireProtocolFor({ kind: "wsdl" })).toBe("soap");
    expect(wireProtocolFor({ kind: "graphql" })).toBe("graphql");
    expect(wireProtocolFor({ kind: "protobuf" })).toBe("grpc");
    expect(wireProtocolFor({ kind: "mcp" })).toBe("mcp_tool");
    // The REST family really does share one wire, which is why the conflation
    // went unnoticed for as long as only these were exercised.
    for (const kind of ["openapi", "swagger", "postman", "odata", "discovery"] as const) {
      expect(wireProtocolFor({ kind })).toBe(RUNTIME_WIRE_PROTOCOL);
    }
  });

  it("attaches a next action to every refusal", () => {
    for (const kind of ["wsdl", "graphql", "protobuf", "mcp"] as const) {
      const verdict = wireExecutability(op(kind));
      expect(verdict.ok).toBe(false);
      if (verdict.ok) throw new Error("expected a refusal");
      // A refusal an operator cannot act on is only a different way of being
      // unhelpful, so the reason and the remedy are both part of the contract.
      expect(verdict.reason.length).toBeGreaterThan(0);
      expect(verdict.nextAction).toContain("ANVIL_BASE_URL");
    }
    expect(wireExecutability(op("openapi")).ok).toBe(true);
  });

  it("asks only about the surface that is actually exposed", () => {
    // An unapproved operation is already refused by the approval gate; asking
    // about it here would report a problem nobody can reach.
    expect(unexecutableWireFailures([op("wsdl", "a.b.c", "review_required")])).toEqual([]);
    expect(unexecutableWireFailures([op("wsdl", "a.b.c", "blocked")])).toEqual([]);
    expect(unexecutableWireFailures([op("wsdl")])).toHaveLength(1);
  });

  it("reports one line per protocol, not one per operation", () => {
    const ops = [
      op("wsdl", "svc.one.get"),
      op("wsdl", "svc.two.get"),
      op("wsdl", "svc.three.get"),
      op("graphql", "svc.four.get"),
    ];
    const failures = unexecutableWireFailures(ops);
    expect(failures).toHaveLength(2);
    const soap = failures.find((f) => f.includes("soap")) ?? "";
    expect(soap).toContain("3 approved operation(s)");
    for (const id of ["svc.one.get", "svc.two.get", "svc.three.get"]) {
      expect(soap).toContain(id);
    }
    expect(failures.find((f) => f.includes("graphql"))).toContain("svc.four.get");
  });
});
