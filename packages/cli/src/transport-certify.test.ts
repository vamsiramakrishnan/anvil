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
    name: "GraphQL",
    spec: "graphql/schema.graphql",
    manifest: "graphql/anvil.yaml",
    id: "storefront",
    protocol: "graphql",
  },
  {
    name: "gRPC",
    spec: "grpc/orders.proto",
    manifest: "grpc/anvil.yaml",
    id: "orders",
    protocol: "grpc",
  },
] as const;

/** A SOAP service whose binding Anvil deliberately declines: rpc/encoded, with
 *  its input message described by `type` rather than `element`. */
const RPC_ENCODED_WSDL = `<?xml version="1.0"?>
<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/"
    xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
    xmlns:xsd="http://www.w3.org/2001/XMLSchema"
    xmlns:tns="urn:legacy" targetNamespace="urn:legacy" name="Legacy">
  <wsdl:message name="RunInput"><wsdl:part name="job" type="xsd:string"/></wsdl:message>
  <wsdl:message name="RunOutput"><wsdl:part name="result" type="xsd:string"/></wsdl:message>
  <wsdl:portType name="LegacyPort">
    <wsdl:operation name="RunBatch">
      <wsdl:input message="tns:RunInput"/>
      <wsdl:output message="tns:RunOutput"/>
    </wsdl:operation>
  </wsdl:portType>
  <wsdl:binding name="LegacyBinding" type="tns:LegacyPort">
    <soap:binding style="rpc" transport="http://schemas.xmlsoap.org/soap/http"/>
    <wsdl:operation name="RunBatch">
      <soap:operation soapAction="urn:legacy/RunBatch"/>
      <wsdl:input><soap:body use="encoded"/></wsdl:input>
      <wsdl:output><soap:body use="encoded"/></wsdl:output>
    </wsdl:operation>
  </wsdl:binding>
  <wsdl:service name="Legacy">
    <wsdl:port name="LegacyPort" binding="tns:LegacyBinding">
      <soap:address location="https://legacy.example.com/rpc"/>
    </wsdl:port>
  </wsdl:service>
</wsdl:definitions>`;

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
      expect(op.sourceRef.binding?.soapAction).toBeDefined();
    }
  });

  it("still refuses a SOAP binding it declines to encode", async () => {
    // rpc/encoded wraps the parts in an operation-named element and carries
    // per-element type attributes. Both are expressible and neither is
    // implemented, so the compiler records no binding and the gate holds —
    // which is the whole posture: refuse rather than encode on a guess.
    const air = await compile({ spec: RPC_ENCODED_WSDL, serviceId: "legacy" });
    const approved = air.operations.map((op) => ({ ...op, state: "approved" as const }));
    const bundleAir = { ...air, operations: approved };
    expect(approved.every((op) => op.sourceRef.binding === undefined)).toBe(true);
    expect(air.diagnostics.map((d) => d.code)).toContain("soap_binding_unencodable");

    const cert = certifyBundle(generateBundle(bundleAir).files, bundleAir, {
      now: clock("2026-01-01T00:00:00.000Z"),
    });
    const failed = cert.checks
      .filter((check) => check.status === "failed")
      .map((check) => check.id);
    expect(failed).toContain("safety.protocol-runtime-executable");
  });

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
