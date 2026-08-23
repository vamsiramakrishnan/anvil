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

  it("leaves a REST bundle's SDKs alone", () => {
    expect(sdkGateDrift(rest.files, rest.air)).toEqual([]);
  });
});
