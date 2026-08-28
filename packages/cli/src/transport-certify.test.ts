import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type AirDocument, wireProtocolFor } from "@anvil/air";
import { staticChecks } from "@anvil/certification";
import { compile } from "@anvil/compiler";
import { certifyBundle, generateBundle } from "@anvil/generators";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * The test that would have caught it.
 *
 * A SOAP bundle certified 38/38 with zero failures while being unable to make a
 * single call: `service.servers` was `[]`, every path was one Anvil invented
 * from WSDL port and operation names, and every body was declared
 * `application/json`. Nothing noticed, and no test could have, because the two
 * halves never met — every `certifyBundle` fixture in this repository is
 * `examples/payments/openapi.yaml`, and every non-REST bundle lives in
 * `@anvil/harness`, which never imports `certifyBundle`.
 *
 * So this file is deliberately the meeting point: non-REST specs driven through
 * the real compile → generate → certify path, on both certification engines.
 */
const example = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../../examples/${rel}`, import.meta.url)), "utf8");

const clock = (iso: string) => () => iso;

const CASES = [
  {
    name: "gRPC",
    spec: "grpc/orders.proto",
    manifest: "grpc/anvil.yaml",
    id: "orders",
    protocol: "grpc",
  },
] as const;

/**
 * SOAP bindings Anvil deliberately declines, one per reason.
 *
 * Kept separate on purpose: a single fixture that trips all three checks proves
 * only that *something* refused it, and would let any one of the three be
 * deleted without a test noticing. The mutation gate caught exactly that.
 */
function declinedWsdl(options: {
  style: string;
  use: string;
  described: "element" | "type";
}): string {
  const part =
    options.described === "element"
      ? `<wsdl:part name="parameters" element="tns:RunBatchRequest"/>`
      : `<wsdl:part name="job" type="xsd:string"/>`;
  return `<?xml version="1.0"?>
<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/"
    xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
    xmlns:xsd="http://www.w3.org/2001/XMLSchema"
    xmlns:tns="urn:legacy" targetNamespace="urn:legacy" name="Legacy">
  <wsdl:types>
    <xsd:schema targetNamespace="urn:legacy" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
      <xsd:element name="RunBatchRequest">
        <xsd:complexType><xsd:sequence>
          <xsd:element name="job" type="xsd:string"/>
        </xsd:sequence></xsd:complexType>
      </xsd:element>
    </xsd:schema>
  </wsdl:types>
  <wsdl:message name="RunInput">${part}</wsdl:message>
  <wsdl:portType name="LegacyPort">
    <wsdl:operation name="RunBatch"><wsdl:input message="tns:RunInput"/></wsdl:operation>
  </wsdl:portType>
  <wsdl:binding name="LegacyBinding" type="tns:LegacyPort">
    <soap:binding style="${options.style}" transport="http://schemas.xmlsoap.org/soap/http"/>
    <wsdl:operation name="RunBatch">
      <soap:operation soapAction="urn:legacy/RunBatch"/>
      <wsdl:input><soap:body use="${options.use}"/></wsdl:input>
    </wsdl:operation>
  </wsdl:binding>
  <wsdl:service name="Legacy">
    <wsdl:port name="LegacyPort" binding="tns:LegacyBinding">
      <soap:address location="https://legacy.example.com/rpc"/>
    </wsdl:port>
  </wsdl:service>
</wsdl:definitions>`;
}

const compiled = new Map<string, { air: AirDocument; files: Record<string, string> }>();

beforeAll(async () => {
  for (const c of CASES) {
    const air = await compile({
      spec: example(c.spec),
      manifest: example(c.manifest),
      serviceId: c.id,
    });
    compiled.set(c.name, { air, files: generateBundle(air).files });
  }
  const payments = await compile({
    spec: example("payments/openapi.yaml"),
    manifest: example("payments/anvil.yaml"),
    serviceId: "payments",
  });
  compiled.set("REST", { air: payments, files: generateBundle(payments).files });
});

describe("transport executability", () => {
  for (const c of CASES) {
    it(`refuses to certify a ${c.name} bundle the runtime cannot speak to`, () => {
      const { air, files } = compiled.get(c.name) ?? {};
      if (!air || !files) throw new Error(`${c.name} did not compile`);

      // The premise: these really are approved, exposed operations. A refusal
      // that only fired on an empty surface would prove nothing.
      const approved = air.operations.filter((op) => op.state === "approved");
      expect(approved.length).toBeGreaterThan(0);
      expect(new Set(approved.map((op) => wireProtocolFor(op.sourceRef)))).toEqual(
        new Set([c.protocol]),
      );

      const cert = certifyBundle(files, air, { now: clock("2026-01-01T00:00:00.000Z") });
      const failed = cert.checks
        .filter((check) => check.status === "failed")
        .map((check) => check.id);
      expect(failed).toContain("safety.protocol-runtime-executable");
      expect(cert.status).toBe("failed");

      // The refusal names what it refused and what to do instead — a refusal an
      // operator cannot act on is only a different way of being unhelpful.
      const detail =
        cert.checks.find((check) => check.id === "safety.protocol-runtime-executable")?.detail ??
        "";
      expect(detail).toContain(c.protocol);
      expect(detail).toContain("ANVIL_BASE_URL");
      for (const op of approved) expect(detail).toContain(op.id);
    });

    it(`both certification engines agree about a ${c.name} bundle`, () => {
      const { air } = compiled.get(c.name) ?? {};
      if (!air) throw new Error(`${c.name} did not compile`);
      // Mirrored, not restated: if these two ever disagree, one of them has
      // reinvented what a protocol means.
      const mirrored = staticChecks(air).find(
        (check) => check.id === "static/transport_executable",
      );
      expect(mirrored?.ok).toBe(false);
    });

    it(`says it at compile time too, so it is not first heard at deploy: ${c.name}`, () => {
      const { air } = compiled.get(c.name) ?? {};
      if (!air) throw new Error(`${c.name} did not compile`);
      const codes = air.diagnostics.map((d) => d.code);
      expect(codes).toContain("unexecutable_transport");
    });
  }

  it("leaves a REST bundle alone", () => {
    const { air, files } = compiled.get("REST") ?? {};
    if (!air || !files) throw new Error("payments did not compile");
    const cert = certifyBundle(files, air, { now: clock("2026-01-01T00:00:00.000Z") });
    const failed = cert.checks
      .filter((check) => check.status === "failed")
      .map((check) => check.id);
    expect(failed).not.toContain("safety.protocol-runtime-executable");
    expect(staticChecks(air).find((check) => check.id === "static/transport_executable")?.ok).toBe(
      true,
    );
    expect(air.diagnostics.map((d) => d.code)).not.toContain("unexecutable_transport");
  });

  it("refuses a streaming RPC, which no transcoder turns into one exchange", async () => {
    // Compiled from its own proto: the shipped example declares no streaming
    // RPC, and asserting otherwise would check the fixture rather than the
    // behaviour — the same correction the GraphQL subscription case needed.
    const air = await compile({
      spec: `syntax = "proto3";
package acme.stream.v1;
message Tick { string id = 1; }
service Feed {
  rpc GetTick(Tick) returns (Tick);
  rpc Watch(Tick) returns (stream Tick);
}`,
      serviceId: "feed",
    });
    const watch = air.operations.find((op) => op.id.includes("watch"));
    expect(watch).toBeDefined();
    expect(watch?.sourceRef.binding).toBeUndefined();
    expect(air.diagnostics.map((d) => d.code)).toContain("grpc_binding_unencodable");

    // The unary RPC beside it is bound, so the refusal is about streaming
    // rather than about this proto failing to compile.
    const unary = air.operations.find((op) => op.id.includes("tick") && !op.id.includes("watch"));
    expect(unary?.sourceRef.binding?.protocol).toBe("grpc");
  });

  it("records the transcoding assumption gRPC has always silently made", async () => {
    // gRPC is the one case where the synthesized path is not synthesized at
    // all: `/package.Service/Method` IS gRPC's own :path. What Anvil cannot do
    // is speak native gRPC — length-prefixed protobuf over HTTP/2 — from four
    // zero-dependency clients, because Python's standard library has no HTTP/2
    // client. A JSON transcoder accepts JSON on that exact path, which is what
    // the adapter has always assumed in a comment and now writes down.
    const air = await compile({
      spec: example("grpc/orders.proto"),
      manifest: example("grpc/anvil.yaml"),
      serviceId: "orders",
    });
    for (const op of air.operations) {
      const binding = op.sourceRef.binding;
      expect(binding?.protocol).toBe("grpc");
      if (binding?.protocol !== "grpc") throw new Error("expected a grpc binding");
      expect(binding.transport).toBe("json_transcoded");
      expect(op.sourceRef.path).toBe(`/${binding.service}/${binding.method}`);
    }

    // Still refused without a declared transcoder: a native gRPC server would
    // reject JSON over HTTP/1.1, and claiming otherwise is the original bug.
    const cert = certifyBundle(generateBundle(air).files, air, {
      now: clock("2026-01-01T00:00:00.000Z"),
    });
    const failed = cert.checks
      .filter((check) => check.status === "failed")
      .map((check) => check.id);
    expect(failed).toContain("safety.protocol-runtime-executable");
    const detail =
      cert.checks.find((c) => c.id === "safety.protocol-runtime-executable")?.detail ?? "";
    expect(detail).toContain("transcoder");
  });

  it("certifies a GraphQL bundle now that the runtime can speak to it", async () => {
    const air = await compile({
      spec: example("graphql/schema.graphql"),
      manifest: example("graphql/anvil.yaml"),
      serviceId: "storefront",
    });
    const cert = certifyBundle(generateBundle(air).files, air, {
      now: clock("2026-01-01T00:00:00.000Z"),
    });
    const failed = cert.checks
      .filter((check) => check.status === "failed")
      .map((check) => check.id);
    expect(failed).not.toContain("safety.protocol-runtime-executable");
    expect(staticChecks(air).find((check) => check.id === "static/transport_executable")?.ok).toBe(
      true,
    );
    for (const op of air.operations) {
      expect(op.sourceRef.binding?.protocol).toBe("graphql");
    }
  });

  it("certifies a GraphQL subscription now that the window makes it terminate", async () => {
    // This assertion used to be the opposite too. A subscription was refused
    // because a stream has no single result; it is now observed through a
    // bounded window, which is exactly the thing that gives it one.
    const air = await compile({
      spec: "type Query { ping: String }\ntype Subscription { tick: String }",
      serviceId: "streaming",
    });
    const operations = air.operations.map((op) => ({ ...op, state: "approved" as const }));
    const bundleAir = { ...air, operations };
    const tick = operations.find((op) => op.id.includes("tick"));
    expect(tick?.sourceRef.binding?.protocol).toBe("graphql_sse");
    expect(tick?.stream).toMatchObject({ delivery: "at_most_once" });

    const cert = certifyBundle(generateBundle(bundleAir).files, bundleAir, {
      now: clock("2026-01-01T00:00:00.000Z"),
    });
    const failed = cert.checks
      .filter((check) => check.status === "failed")
      .map((check) => check.id);
    expect(failed).not.toContain("safety.protocol-runtime-executable");
  });

  it("refuses a subscription whose bound was stripped", async () => {
    // The other half, and the one that matters: the binding alone earns
    // nothing. Remove the contract and the operation is a call that never
    // returns, which certification must catch before it is deployed.
    const air = await compile({
      spec: "type Query { ping: String }\ntype Subscription { tick: String }",
      serviceId: "streaming",
    });
    const operations = air.operations.map((op) => ({
      ...op,
      state: "approved" as const,
      stream: undefined,
    }));
    const bundleAir = { ...air, operations };

    const cert = certifyBundle(generateBundle(bundleAir).files, bundleAir, {
      now: clock("2026-01-01T00:00:00.000Z"),
    });
    const failed = cert.checks
      .filter((check) => check.status === "failed")
      .map((check) => check.id);
    expect(failed).toContain("safety.protocol-runtime-executable");
  });

  it("certifies a SOAP bundle now that the runtime can speak to it", async () => {
    // This assertion used to be the opposite. A SOAP bundle was refused because
    // Anvil could not put an envelope on the wire; it now can, and the refusal
    // would be the lie instead.
    const air = await compile({
      spec: example("soap/bank.wsdl"),
      manifest: example("soap/anvil.yaml"),
      serviceId: "banking",
    });
    const files = generateBundle(air).files;
    const cert = certifyBundle(files, air, { now: clock("2026-01-01T00:00:00.000Z") });
    const failed = cert.checks
      .filter((check) => check.status === "failed")
      .map((check) => check.id);
    expect(failed).not.toContain("safety.protocol-runtime-executable");
    expect(staticChecks(air).find((check) => check.id === "static/transport_executable")?.ok).toBe(
      true,
    );
    for (const op of air.operations) {
      const binding = op.sourceRef.binding;
      expect(binding?.protocol).toBe("soap");
      if (binding?.protocol !== "soap") throw new Error("expected a soap binding");
      expect(binding.soapAction).toBeDefined();
    }
  });

  const DECLINED = [
    { why: "rpc style", style: "rpc", use: "literal", described: "element" as const },
    { why: "encoded use", style: "document", use: "encoded", described: "element" as const },
    {
      why: "a type-described message",
      style: "document",
      use: "literal",
      described: "type" as const,
    },
  ];

  for (const c of DECLINED) {
    it(`still refuses a SOAP binding with ${c.why}`, async () => {
      // Each fixture trips exactly one check, so deleting any one of the three
      // is visible. Anvil encodes document/literal with element-described
      // messages; the rest compile, record no binding, and stay refused —
      // encoding one on a guess is how you corrupt a legacy system politely.
      const air = await compile({ spec: declinedWsdl(c), serviceId: "legacy" });
      const operations = air.operations.map((op) => ({ ...op, state: "approved" as const }));
      const bundleAir = { ...air, operations };
      expect(operations.length).toBeGreaterThan(0);
      expect(operations.every((op) => op.sourceRef.binding === undefined)).toBe(true);
      expect(air.diagnostics.map((d) => d.code)).toContain("soap_binding_unencodable");

      const cert = certifyBundle(generateBundle(bundleAir).files, bundleAir, {
        now: clock("2026-01-01T00:00:00.000Z"),
      });
      const failed = cert.checks
        .filter((check) => check.status === "failed")
        .map((check) => check.id);
      expect(failed).toContain("safety.protocol-runtime-executable");
    });
  }

  it("recovers the endpoint the WSDL declares instead of reporting none", async () => {
    const air = await compile({
      spec: example("soap/bank.wsdl"),
      manifest: example("soap/anvil.yaml"),
      serviceId: "banking",
    });
    // `<soap:address location="https://banking.example.com/soap">` used to be
    // dropped, so `servers` was `[]` and the generated skill told the operator
    // "the source spec declares no server URL" — false for every WSDL with a
    // port. The bundle still cannot call it; it can now say what it is.
    expect(air.service.servers.map((s) => s.url)).toContain("https://banking.example.com/soap");
    expect(air.diagnostics.map((d) => d.code)).toContain("wsdl_synthesized_paths");
  });
});
