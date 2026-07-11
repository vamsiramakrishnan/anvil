import { describe, expect, it } from "vitest";
import { compileContract } from "../contract/snapshot.js";
import type { AdapterContext, GatewayAdapter, GatewayConnection } from "./adapter.js";
import { ApiConnectGatewayAdapter } from "./apiconnect/adapter.js";
import { ApigeeGatewayAdapter } from "./apigee/adapter.js";
import { gatewayAdapterConformance } from "./conformance.js";
import { MulesoftGatewayAdapter } from "./mulesoft/adapter.js";
import { Wso2GatewayAdapter } from "./wso2/adapter.js";

/**
 * The same logical API — POST /refunds requiring the `refunds:write` scope —
 * expressed in each vendor's export format. The differential invariant: every
 * adapter must produce the same effective auth scope on the same operation.
 */
const VENDORS: {
  name: string;
  adapter: GatewayAdapter<GatewayConnection & { config: string }>;
  config: string;
}[] = [
  {
    name: "wso2",
    adapter: new Wso2GatewayAdapter(),
    config: `data:
  name: refunds
  version: "1.0.0"
  securityScheme: ["oauth2"]
  apiThrottlingPolicy: "10PerMin"
  operations:
    - { target: "/refunds", verb: "POST", scopes: ["refunds:write"] }
`,
  },
  {
    name: "mulesoft",
    adapter: new MulesoftGatewayAdapter(),
    config: `apis:
  - assetId: refunds
    productVersion: v1
    resources:
      - { method: "POST", path: "/refunds", scopes: ["refunds:write"] }
    policies:
      - { policyId: openidconnect }
      - { policyId: custom-dataweave }
`,
  },
  {
    name: "api_connect",
    adapter: new ApiConnectGatewayAdapter(),
    config: `products:
  - name: refunds-product
    plans:
      - { name: gold, rateLimit: "100/min", apis: ["refunds"] }
apis:
  - name: refunds
    oauthProviders: ["default"]
    resources:
      - { method: "POST", path: "/refunds", scopes: ["refunds:write"] }
    assembly:
      execute:
        - { type: map }
`,
  },
  {
    name: "apigee",
    adapter: new ApigeeGatewayAdapter(),
    config: `proxies:
  - name: refunds
    revision: "2"
    environments: ["prod"]
    flows:
      - { method: "POST", path: "/refunds" }
    policies:
      - { type: OAuthV2 }
      - { type: AssignMessage }
products:
  - name: refunds-product
    scopes: ["refunds:write"]
    quota: "1000pm"
    proxies: ["refunds"]
`,
  },
];

const ctx: AdapterContext = {};

async function effectiveScopes(vendor: (typeof VENDORS)[number]): Promise<string[]> {
  const connection = { id: `${vendor.name}-1`, config: vendor.config };
  const imp = await vendor.adapter.extractApi(connection, { id: "refunds" }, ctx);
  const result = await compileContract(imp.source, [imp.overlay]);
  const contract = result.status === "resolved" ? result.contract : result.partialContract;
  const op = contract.air.operations.find(
    (o) => o.sourceRef.operationId === "refunds_post_refunds",
  );
  return op?.auth.scopes ?? [];
}

describe.each(VENDORS)("$name adapter", (vendor) => {
  const connection = { id: `${vendor.name}-1`, config: vendor.config };

  it("inventories the refunds API", async () => {
    const inv = await vendor.adapter.inventory(connection, ctx);
    expect(inv.apis.map((a) => a.id)).toContain("refunds");
  });

  it("feeds the compiler and applies the required scope", async () => {
    expect(await effectiveScopes(vendor)).toContain("refunds:write");
  });

  it("passes the gateway adapter conformance battery", async () => {
    const report = await gatewayAdapterConformance(
      { connection, api: { id: "refunds" }, secret: "VENDOR_SECRET" },
      vendor.adapter,
    );
    const failed = report.checks.filter((c) => !c.ok).map((c) => `${c.name} — ${c.detail ?? ""}`);
    expect(failed).toEqual([]);
  });
});

describe("cross-vendor differential", () => {
  it("equivalent policy → equivalent effective auth scope across all vendors", async () => {
    const scopeSets = await Promise.all(VENDORS.map(effectiveScopes));
    for (const scopes of scopeSets) expect(scopes).toEqual(["refunds:write"]);
  });
});
