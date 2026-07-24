import { describe, expect, it } from "vitest";
import { ApiConnectGatewayAdapter } from "./apiconnect/adapter.js";
import { ApigeeGatewayAdapter } from "./apigee/adapter.js";
import { KongGatewayAdapter } from "./kong/adapter.js";
import { GatewayKind } from "./model.js";
import { MulesoftGatewayAdapter } from "./mulesoft/adapter.js";
import {
  GATEWAY_SUPPORT_CONTRACTS,
  GatewayEvidenceDimension,
  GatewaySemanticDimension,
  gatewaySupportContract,
  gatewaySupportRegistryConformance,
} from "./support-contract.js";
import { Wso2GatewayAdapter } from "./wso2/adapter.js";

describe("gateway support release truth", () => {
  it("covers every real GatewayKind exactly once while keeping Mashery research-only", () => {
    expect(gatewaySupportRegistryConformance()).toEqual([]);
    expect(GATEWAY_SUPPORT_CONTRACTS.map((contract) => contract.vendor)).toEqual([
      "kong",
      "wso2",
      "apigee",
      "mulesoft",
      "api_connect",
      "mashery",
    ]);

    const implemented = GatewayKind.options.filter((kind) => kind !== "fixture");
    expect(
      GATEWAY_SUPPORT_CONTRACTS.filter((contract) => contract.adapterKind !== null).map(
        (contract) => contract.adapterKind,
      ),
    ).toEqual(implemented);
    expect(GatewayKind.options).not.toContain("mashery");
    expect(gatewaySupportContract("mashery")).toMatchObject({
      adapterKind: null,
      releaseTier: "research_only",
      acceptedInputs: [],
      scaleProof: { kind: "none", apiCount: 0 },
    });
  });

  it("separates input tier, semantic coverage, authority evidence, and proof provenance", () => {
    for (const contract of GATEWAY_SUPPORT_CONTRACTS) {
      expect(contract.semantics.map((entry) => entry.dimension)).toEqual(
        GatewaySemanticDimension.options,
      );
      expect(contract.authorityEvidence.map((entry) => entry.dimension)).toEqual(
        GatewayEvidenceDimension.options,
      );
      expect(
        contract.officialReferences.every((reference) => reference.url.startsWith("https://")),
      ).toBe(true);
    }

    for (const vendor of ["apigee", "mulesoft", "api_connect"] as const) {
      const contract = gatewaySupportContract(vendor);
      expect(contract.releaseTier).toBe("normalized_interchange");
      expect(contract.acceptedInputs.every((input) => input.native === false)).toBe(true);
      expect(contract.fixtureProvenance.kind).toBe("synthetic_normalized");
      expect(contract.scaleProof.kind).toBe("synthetic_normalized");
    }

    for (const vendor of ["kong", "wso2"] as const) {
      const contract = gatewaySupportContract(vendor);
      expect(contract.acceptedInputs.some((input) => input.native)).toBe(true);
      expect(contract.fixtureProvenance.kind).toBe("vendor_schema_derived_synthetic");
      expect(contract.scaleProof.kind).toBe("synthetic_native_shape");
      expect(contract.scaleProof.statement).toMatch(/not (?:a )?(?:vendor-captured|captured)/i);
    }
  });

  it("advertises products only when the normalized inventory actually emits products", async () => {
    const wso2 = new Wso2GatewayAdapter();
    const wsoInventory = await wso2.inventory(
      {
        id: "wso",
        config: `data:
  name: Orders
  version: "1"
  operations: [{ target: /orders, verb: GET }]
`,
      },
      {},
    );
    expect(wsoInventory.products).toEqual([]);
    expect(wso2.capabilities.products).toBe(false);

    const mule = new MulesoftGatewayAdapter();
    const muleInventory = await mule.inventory(
      {
        id: "mule",
        config: `apis:
  - assetId: orders
    resources: [{ method: GET, path: /orders }]
`,
      },
      {},
    );
    expect(muleInventory.products).toEqual([]);
    expect(mule.capabilities.products).toBe(false);

    const apigee = new ApigeeGatewayAdapter();
    const apigeeInventory = await apigee.inventory(
      {
        id: "apigee",
        config: `proxies:
  - name: orders
    flows: [{ method: GET, path: /orders }]
products:
  - name: internal
    proxies: [orders]
`,
      },
      {},
    );
    expect(apigeeInventory.products.map((product) => product.id)).toEqual(["internal"]);
    expect(apigee.capabilities.products).toBe(true);

    const apiConnect = new ApiConnectGatewayAdapter();
    const apiConnectInventory = await apiConnect.inventory(
      {
        id: "apic",
        config: `apis:
  - name: orders
    resources: [{ method: GET, path: /orders }]
products:
  - name: internal
    plans: [{ name: default, apis: [orders] }]
`,
      },
      {},
    );
    expect(apiConnectInventory.products.map((product) => product.id)).toEqual(["internal"]);
    expect(apiConnect.capabilities.products).toBe(true);
  });

  it("does not advertise consumers or Apigee fault semantics that have no observable model", async () => {
    const kong = new KongGatewayAdapter();
    const kongInventory = await kong.inventory(
      {
        id: "kong",
        config: `_format_version: "3.0"
services:
  - name: orders
    routes: [{ methods: [GET], paths: [/orders] }]
consumers:
  - username: alice
`,
      },
      {},
    );
    expect(kongInventory.apis.map((api) => api.id)).toEqual(["orders"]);
    expect(kong.capabilities.consumers).toBe(false);

    const apigee = new ApigeeGatewayAdapter();
    const imported = await apigee.extractApi(
      {
        id: "apigee",
        config: `proxies:
  - name: orders
    flows: [{ method: GET, path: /orders }]
    policies: [{ type: RaiseFault }]
`,
      },
      { id: "orders" },
      {},
    );
    expect(imported.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "gateway/opaque_policy",
          message: expect.stringContaining("RaiseFault"),
        }),
      ]),
    );
    expect(apigee.capabilities.faultPolicies).toBe(false);

    expect(new Wso2GatewayAdapter().capabilities.consumers).toBe(false);
    expect(new MulesoftGatewayAdapter().capabilities.consumers).toBe(false);
    expect(new ApiConnectGatewayAdapter().capabilities.consumers).toBe(false);
    expect(apigee.capabilities.consumers).toBe(false);
  });
});
