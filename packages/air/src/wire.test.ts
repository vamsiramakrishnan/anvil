import { describe, expect, it } from "vitest";
import { SourceKind } from "./enums.js";
import { contractHash } from "./hash.js";
import { AirDocument, Operation as OperationSchema } from "./schema.js";
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

/** An approved operation carrying a specific `sourceRef`, bindings included. */
function opWith(sourceRef: Record<string, unknown>, id = "svc.thing.get") {
  return OperationSchema.parse({ ...op("openapi", id), sourceRef });
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

  it("answers http_json for a gRPC method that declared its own HTTP rule", () => {
    // The one case where the source document overrides the source *format*. A
    // proto carrying `google.api.http` names the route a gateway serves, the
    // compiler lowered the operation onto it, and what goes on the wire is
    // ordinary JSON over HTTP. Deriving that here rather than branching per
    // surface is what lets the runtime, all four SDKs, and both certification
    // engines inherit it without a line of protocol-specific code each.
    const declared = {
      kind: "protobuf",
      path: "/v1/orders/{order_id}",
      method: "get",
      binding: { protocol: "grpc", service: "a.b.S", method: "GetOrder", transport: "http_rule" },
    } as const;
    expect(wireProtocolFor(declared)).toBe(RUNTIME_WIRE_PROTOCOL);
    expect(wireExecutability(opWith(declared)).ok).toBe(true);
    expect(unexecutableWireFailures([opWith(declared)])).toEqual([]);
  });

  it("keeps refusing a gRPC method whose transcoder is only assumed", () => {
    // `json_transcoded` is a claim about a deployment the proto cannot see, so
    // it stays a refusal until an operator declares the facade. Only the
    // document's own declaration earns executability.
    const assumed = {
      kind: "protobuf",
      path: "/a.b.S/GetOrder",
      method: "post",
      binding: {
        protocol: "grpc",
        service: "a.b.S",
        method: "GetOrder",
        transport: "json_transcoded",
      },
    } as const;
    expect(wireProtocolFor(assumed)).toBe("grpc");
    expect(wireExecutability(opWith(assumed)).ok).toBe(false);
  });

  it("answers graphql_sse for a subscription, and only with a bound", () => {
    // The contract is what makes a subscription a call. Without it there is
    // nothing to make the window close, and a call that never returns is not a
    // call — so the binding alone earns nothing.
    const binding = {
      protocol: "graphql_sse",
      document: "subscription Anvil_Ticks { ticks { seq } }",
      operationName: "Anvil_Ticks",
      rootField: "ticks",
    } as const;
    const unbounded = { kind: "graphql", path: "/graphql/Subscription/ticks", binding } as const;
    expect(wireProtocolFor(unbounded)).toBe("graphql_sse");
    expect(wireExecutability(opWith(unbounded)).ok).toBe(false);

    const bounded = OperationSchema.parse({
      ...opWith(unbounded),
      stream: {
        transport: "graphql_sse",
        delivery: "at_most_once",
        maxEvents: 100,
        maxSeconds: 30,
      },
    });
    expect(wireExecutability(bounded).ok).toBe(true);
    expect(unexecutableWireFailures([bounded])).toEqual([]);
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

describe("the wire binding is hash-neutral when absent", () => {
  it("does not change contractHash for a document that has none", () => {
    // The reason `binding` is `.optional()` and never `.default()`. `contractHash`
    // parses the whole AirDocument, so a default would materialise the key on
    // every re-parse and expire every certification on disk the day this field
    // shipped. This test is what stops someone "tidying" it into a default.
    const doc = {
      anvilVersion: "0.1.0",
      service: {
        id: "svc",
        name: "svc",
        version: "1.0.0",
        servers: [],
        source: { kind: "openapi" },
      },
      operations: [op("openapi")],
      capabilities: [],
      workflows: [],
      diagnostics: [],
    };
    const withoutKey = AirDocument.parse(structuredClone(doc));
    const withUndefined = AirDocument.parse({
      ...structuredClone(doc),
      operations: [
        {
          ...op("openapi"),
          sourceRef: { kind: "openapi", path: "/thing", method: "get", binding: undefined },
        },
      ],
    });
    expect(contractHash(withUndefined)).toBe(contractHash(withoutKey));
  });

  it("does change it once a binding is actually recorded", () => {
    // The other half: a recorded binding is a material fact about the call, so
    // it must move the hash. A field that never moves the hash is a field
    // certification cannot attest to.
    const base = {
      anvilVersion: "0.1.0",
      service: { id: "svc", name: "svc", version: "1.0.0", servers: [], source: { kind: "wsdl" } },
      operations: [op("wsdl")],
      capabilities: [],
      workflows: [],
      diagnostics: [],
    };
    const bound = structuredClone(base) as Record<string, never> & typeof base;
    bound.operations = [
      {
        ...op("wsdl"),
        sourceRef: {
          kind: "wsdl",
          path: "/thing",
          method: "get",
          binding: {
            protocol: "soap",
            soapAction: "urn:Do",
            envelopeNamespace: "http://schemas.xmlsoap.org/soap/envelope/",
            bodyNamespace: "urn:svc",
            bodyElement: "DoRequest",
            contentType: "text/xml; charset=utf-8",
            soapVersion: "1.1",
          },
        },
      },
    ] as typeof bound.operations;
    expect(contractHash(AirDocument.parse(bound))).not.toBe(
      contractHash(AirDocument.parse(structuredClone(base))),
    );
  });
});
