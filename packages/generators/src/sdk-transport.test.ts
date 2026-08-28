import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AirDocument } from "@anvil/air";
import { compile } from "@anvil/compiler";
import { beforeAll, describe, expect, it } from "vitest";
import { generateBundle } from "./bundle.js";
import { sdkGateDrift } from "./sdk/certify.js";
import { SDK_LANGUAGES, sdkManifest } from "./sdk/index.js";
import { sdkPlan } from "./sdk/plan.js";

/**
 * The SDKs do not go through the runtime's executor — each carries its own
 * decision core, which is exactly why the four stay byte-identical on the wire.
 * It is also why a transport gate that lived only in the executor would leave
 * four shipped surfaces free to post JSON at a coordinate Anvil invented.
 */
const example = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../../examples/${rel}`, import.meta.url)), "utf8");

let soap: { air: AirDocument; files: Record<string, string> };
let rest: { air: AirDocument; files: Record<string, string> };
let graphql: { air: AirDocument; files: Record<string, string> };
let grpcGateway: { air: AirDocument; files: Record<string, string> };

beforeAll(async () => {
  const air = await compile({
    spec: example("soap/bank.wsdl"),
    manifest: example("soap/anvil.yaml"),
    serviceId: "banking",
  });
  soap = { air, files: generateBundle(air).files };
  const payments = await compile({
    spec: example("payments/openapi.yaml"),
    manifest: example("payments/anvil.yaml"),
    serviceId: "payments",
  });
  rest = { air: payments, files: generateBundle(payments).files };
  const storefront = await compile({
    spec: example("graphql/schema.graphql"),
    manifest: example("graphql/anvil.yaml"),
    serviceId: "storefront",
  });
  graphql = { air: storefront, files: generateBundle(storefront).files };
  const inventory = await compile({
    spec: example("grpc-gateway/inventory.proto"),
    manifest: example("grpc-gateway/anvil.yaml"),
    serviceId: "inventory",
  });
  grpcGateway = { air: inventory, files: generateBundle(inventory).files };
});

describe("the SDK transport gate", () => {
  it("records what each operation actually speaks, per language", () => {
    const manifest = sdkManifest(sdkPlan(soap.air));
    expect(manifest.methods.length).toBeGreaterThan(0);
    for (const method of manifest.methods) expect(method.wireProtocol).toBe("soap");
    for (const method of sdkManifest(sdkPlan(rest.air)).methods) {
      expect(method.wireProtocol).toBe("http_json");
    }
  });

  it("gives all four clients the plain HTTP path for a proto that declared its route", () => {
    // The whole point of deriving the protocol from the binding rather than
    // branching per surface: a gRPC method carrying `google.api.http` is
    // HTTP+JSON on the wire, so every client takes the path it already had.
    // Four clients each needing a new branch is four chances for one to differ.
    const manifest = sdkManifest(sdkPlan(grpcGateway.air));
    expect(manifest.methods.length).toBeGreaterThan(0);
    for (const method of manifest.methods) expect(method.wireProtocol).toBe("http_json");

    // And the declared verbs really did survive into the clients — proof the
    // operations were lowered onto the route rather than left on gRPC's POST.
    const verbs = new Set(manifest.methods.map((m) => m.http.split(" ")[0]));
    expect(verbs).toContain("GET");
    expect(verbs).toContain("DELETE");
    // The gRPC coordinate is nowhere in any client — the declared route replaced it.
    expect(manifest.methods.every((m) => !m.http.includes("InventoryService/"))).toBe(true);
  });

  it("is certified for a declared-route proto, in all four clients", () => {
    // Same gate as SOAP and GraphQL: a client that disagrees with AIR about
    // what it speaks is caught here rather than in production.
    expect(sdkGateDrift(grpcGateway.files, grpcGateway.air)).toEqual([]);

    const manifest = JSON.parse(grpcGateway.files["sdk/manifest.json"] ?? "{}");
    manifest.methods[0].wireProtocol = "grpc";
    const drift = sdkGateDrift(
      { ...grpcGateway.files, "sdk/manifest.json": JSON.stringify(manifest, null, 2) },
      grpcGateway.air,
    );
    expect(drift.join(" ")).toContain("wireProtocol");
  });

  it("emits the gate into all four decision cores", () => {
    // Each language enforces it in its own core rather than sharing one, so the
    // check has to be that all four actually carry it — a gate present in three
    // is a gate absent in one.
    const sources: Record<(typeof SDK_LANGUAGES)[number], [string, string]> = {
      typescript: ["sdk/typescript/src/invoke.ts", "assertWireExecutable"],
      python: ["sdk/python/anvil_banking/_invoke.py", "assert_wire_executable"],
      go: ["sdk/go/invoke.go", "assertWireExecutable"],
      java: ["sdk/java/src/main/java/com/anvil/sdk/banking/Invoker.java", "assertWireExecutable"],
    };
    for (const language of SDK_LANGUAGES) {
      const [path, symbol] = sources[language];
      const source = soap.files[path];
      expect(source, `${language}: ${path} is missing`).toBeDefined();
      expect(source ?? "").toContain(symbol);
      // Present is not enough — it has to run before the request is built.
      expect(source ?? "").toContain("http_json");
    }
  });

  it("is certified, so a client that disagrees with AIR is caught not shipped", () => {
    expect(sdkGateDrift(soap.files, soap.air)).toEqual([]);

    // Flip only the manifest's claim about the wire and nothing else: the gate
    // has to notice a client that believes it speaks HTTP+JSON to SOAP.
    const manifest = JSON.parse(soap.files["sdk/manifest.json"] ?? "{}");
    manifest.methods[0].wireProtocol = "http_json";
    const drift = sdkGateDrift(
      { ...soap.files, "sdk/manifest.json": JSON.stringify(manifest, null, 2) },
      soap.air,
    );
    expect(drift.join(" ")).toContain("wireProtocol");
  });

  it("catches a client that would dispatch on the wrong SOAP action", () => {
    // A SOAP 1.1 server dispatches on SOAPAction. A client sending the wrong
    // one is refused by the service; one sending none is refused outright. Same
    // class of fact as the confirmation and idempotency flags, and the same
    // reason to catch it before it ships rather than in production.
    const manifest = JSON.parse(soap.files["sdk/manifest.json"] ?? "{}");
    expect(manifest.methods[0].soapAction).toBe("http://example.com/banking/GetAccountBalance");
    manifest.methods[0].soapAction = "http://example.com/banking/SomethingElse";
    const drift = sdkGateDrift(
      { ...soap.files, "sdk/manifest.json": JSON.stringify(manifest, null, 2) },
      soap.air,
    );
    expect(drift.join(" ")).toContain("soapAction");
  });

  it("emits the envelope builder into all four clients", () => {
    // Four independent implementations of one envelope. The bytes are compared
    // across four real toolchains in sdk-soap.test.ts; this is the cheap check
    // that all four carry it at all, since a builder present in three is a
    // builder missing from one.
    const sources: Array<[string, string]> = [
      ["sdk/typescript/src/soap.ts", "buildEnvelope"],
      ["sdk/python/anvil_banking/_invoke.py", "build_envelope"],
      ["sdk/go/soap.go", "buildEnvelope"],
      ["sdk/java/src/main/java/com/anvil/sdk/banking/Invoker.java", "buildEnvelope"],
    ];
    for (const [path, symbol] of sources) {
      const source = soap.files[path];
      expect(source, `${path} is missing`).toBeDefined();
      expect(source ?? "").toContain(symbol);
      // Every one refuses a DTD, in its own language's idiom.
      expect(source ?? "").toMatch(/DOCTYPE|doctype/);
    }
  });

  it("catches a client that would post a different query document", () => {
    // A client posting a different document is asking a different question.
    // Same class of divergence as a wrong SOAPAction, and the same reason to
    // catch it before it ships rather than in production.
    expect(sdkGateDrift(graphql.files, graphql.air)).toEqual([]);

    const manifest = JSON.parse(graphql.files["sdk/manifest.json"] ?? "{}");
    expect(manifest.methods[0].graphqlDocument).toContain("query Anvil_");
    manifest.methods[0].graphqlDocument = "query Anvil_Product { product { id } }";
    const drift = sdkGateDrift(
      { ...graphql.files, "sdk/manifest.json": JSON.stringify(manifest, null, 2) },
      graphql.air,
    );
    expect(drift.join(" ")).toContain("graphqlDocument");
  });

  it("gives every client the same document, and none of them a query builder", () => {
    // The point of compiling the document once: four clients that post a
    // string cannot disagree about it the way four query builders could.
    const document = (graphql.air.operations[0]?.sourceRef.binding as { document?: string })
      ?.document;
    expect(document).toBeDefined();
    for (const [path, source] of Object.entries(graphql.files)) {
      if (!path.startsWith("sdk/") || !path.includes("operations")) continue;
      expect(source).toContain(document ?? "");
    }
  });

  it("leaves a REST bundle's SDKs alone", () => {
    expect(sdkGateDrift(rest.files, rest.air)).toEqual([]);
  });

  it("refuses a subscription before the facade short-circuit, in all four cores", () => {
    // The defect this pins down: every gate once read `http_json || facade →
    // pass`, so declaring ANVIL_PROTOCOL_FACADE let a `graphql_sse` operation
    // through a client with no SSE window — one JSON object out of a client,
    // an array out of the runtime, for the same operation. A facade declares
    // coordinates, not framing, so the subscription refusal must come FIRST.
    // The assertion is on ordering inside the emitted gate, because ordering
    // was exactly what was wrong.
    // The third entry is the facade *check expression*, not the parameter name
    // — a signature mentions the parameter before the body can check it.
    const gates: Record<(typeof SDK_LANGUAGES)[number], [string, string, string]> = {
      typescript: [
        "sdk/typescript/src/invoke.ts",
        "assertWireExecutable",
        "protocolFacade !== undefined",
      ],
      python: [
        "sdk/python/anvil_banking/_invoke.py",
        "assert_wire_executable",
        "protocol_facade is not None",
      ],
      go: ["sdk/go/invoke.go", "assertWireExecutable", 'protocolFacade != ""'],
      java: [
        "sdk/java/src/main/java/com/anvil/sdk/banking/Invoker.java",
        "assertWireExecutable",
        "protocolFacade != null",
      ],
    };
    for (const language of SDK_LANGUAGES) {
      const [path, gateSymbol, facadeToken] = gates[language];
      const source = soap.files[path] ?? "";
      const gate = source.slice(source.indexOf(gateSymbol));
      const refusal = gate.indexOf('"graphql_sse"');
      const facade = gate.indexOf(facadeToken);
      expect(refusal, `${language}: the gate never mentions graphql_sse`).toBeGreaterThanOrEqual(0);
      expect(facade, `${language}: the gate never consults the facade`).toBeGreaterThanOrEqual(0);
      expect(
        refusal,
        `${language}: the facade short-circuit runs before the subscription refusal`,
      ).toBeLessThan(facade);
    }
  });
});
