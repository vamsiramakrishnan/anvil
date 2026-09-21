import { describe, expect, it } from "vitest";
import { SourceKind } from "./enums.js";
import { contractHash } from "./hash.js";
import { AirDocument, Operation as OperationSchema } from "./schema.js";
import {
  bodyContentTypeIssue,
  protocolFacadeApplies,
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
      // With no binding recorded, the compiler declined to encode the call at
      // all; the honest next action is to fix the source, not to name a facade.
      expect(verdict.scope).toBe("framing");
      expect(verdict.nextAction).toContain("No protocol facade");
    }
    expect(wireExecutability(op("openapi")).ok).toBe(true);
  });

  it("separates a coordinates refusal, which a facade may answer, from a framing one", () => {
    // A recorded json_transcoded binding is the compiler's own statement that a
    // translator is assumed: Anvil knows exactly what the call is and lacks only
    // an address, so an operator can supply one and say so.
    const transcoded = opWith({
      kind: "protobuf",
      path: "/a.b.S/GetOrder",
      method: "post",
      binding: {
        protocol: "grpc",
        service: "a.b.S",
        method: "GetOrder",
        transport: "json_transcoded",
      },
    });
    const verdict = wireExecutability(transcoded);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("expected a refusal");
    expect(verdict.scope).toBe("coordinates");
    expect(verdict.nextAction).toContain("ANVIL_BASE_URL");
    expect(protocolFacadeApplies(transcoded)).toBe(true);

    // A streaming RPC records no binding: a stream is not a request and a
    // response, and no address turns it into one. The facade must not apply.
    const streaming = op("protobuf");
    expect(protocolFacadeApplies(streaming)).toBe(false);
    // An rpc/encoded SOAP binding records nothing either: the WSDL declared a
    // shape Anvil declines to encode, and a facade cannot encode it instead.
    expect(protocolFacadeApplies(op("wsdl"))).toBe(false);
    // An operation the runtime speaks natively is one a facade may be declared
    // against harmlessly — the declaration is recorded, nothing changes.
    expect(protocolFacadeApplies(op("openapi"))).toBe(true);
    // The failure line carries the scope's own remedy, so certification does
    // not tell an operator to declare a facade that would then be refused.
    const line = unexecutableWireFailures([streaming]).join(" ");
    expect(line).toContain("No protocol facade");
    expect(line).not.toContain("ANVIL_BASE_URL");
  });

  it("refuses a request body the HTTP/JSON runtime cannot encode, through the same seam", () => {
    const body = (contentType: string, id = "svc.thing.create", state = "approved") =>
      OperationSchema.parse({
        ...op("openapi", id, state),
        sourceRef: { kind: "openapi", path: "/thing", method: "post" },
        input: {
          params: [],
          body: { contentType, required: true, schema: { type: "object" }, projection: "whole" },
        },
      });
    expect(bodyContentTypeIssue(body("application/json"))).toBeUndefined();
    expect(bodyContentTypeIssue(body("application/vnd.api+json; charset=utf-8"))).toBeUndefined();
    expect(bodyContentTypeIssue(body("application/x-www-form-urlencoded"))).toBeUndefined();
    expect(bodyContentTypeIssue(body("multipart/form-data"))).toBeUndefined();
    for (const contentType of ["application/octet-stream", "text/plain", "application/xml"]) {
      expect(bodyContentTypeIssue(body(contentType))).toContain(contentType);
    }
    expect(bodyContentTypeIssue(op("openapi"))).toBeUndefined();
    // Another codec owns its own framing: a SOAP envelope is not labelled by
    // this field, so the field is not this check's business there.
    const soap = OperationSchema.parse({
      ...body("application/xml"),
      sourceRef: { kind: "wsdl", path: "/Port/Op", method: "post" },
    });
    expect(bodyContentTypeIssue(soap)).toBeUndefined();

    // Certification reads the same lines the protocol refusals travel through,
    // grouped by content type, and only for the surface actually exposed.
    const failures = unexecutableWireFailures([
      body("application/octet-stream", "svc.one.create"),
      body("application/octet-stream", "svc.two.create"),
      body("text/plain", "svc.three.create"),
      body("text/plain", "svc.four.create", "review_required"),
      body("application/json", "svc.five.create"),
    ]);
    expect(failures).toHaveLength(2);
    const octet = failures.find((f) => f.includes("application/octet-stream")) ?? "";
    expect(octet).toContain("2 approved operation(s)");
    expect(octet).toContain("svc.one.create");
    expect(octet).toContain("svc.two.create");
    const text = failures.find((f) => f.includes("text/plain")) ?? "";
    expect(text).toContain("svc.three.create");
    expect(text).not.toContain("svc.four.create");
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

  it("keeps refusing a queue request/reply binding — there is no codec for it, only a facade", () => {
    // Unlike SOAP or GraphQL, nothing about a queue exchange is HTTP shaped, so
    // the binding alone never earns `ok: true` — the same posture as a gRPC
    // method whose transcoder is only assumed.
    const binding = {
      protocol: "queue_request_reply",
      legacyBindingContentHash: `sha256:${"7".repeat(64)}`,
      requestDestination: "PAY.REFUND.REQUEST",
      reply: { mode: "reply_to", correlationField: "JMSCorrelationID" },
      requestSchemaRef: "#/components/schemas/RefundCommand",
      responseSchemaRef: "#/components/schemas/RefundReply",
      timeoutMs: 30_000,
      idempotency: { carrier: "correlation_id" },
    } as const;
    const bridged = {
      kind: "openapi",
      path: "/bridge/refunds.submit",
      method: "post",
      binding,
    } as const;
    expect(wireProtocolFor(bridged)).toBe("queue_request_reply");
    const verdict = wireExecutability(opWith(bridged));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("expected a refusal");
    expect(verdict.protocol).toBe("queue_request_reply");
    expect(verdict.reason).toContain("legacy-bridge");
    expect(verdict.nextAction).toContain("ANVIL_BASE_URL");
  });

  it("refuses a GraphQL operation without a binding as not compiled, never as declined", () => {
    // The compiler records a binding for every GraphQL root field; the only
    // way to reach this refusal is an AIR document the compiler did not write
    // (hand-edited, or older than wire bindings). The reason must say that,
    // not send the operator hunting for a compile diagnostic that cannot exist.
    const verdict = wireExecutability(
      opWith({ kind: "graphql", path: "/graphql/Query/thing", method: "post" }),
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("expected a refusal");
    expect(verdict.protocol).toBe("graphql");
    expect(verdict.reason).toContain("Recompile from the SDL");
    expect(verdict.reason).not.toContain("compile diagnostics");
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
