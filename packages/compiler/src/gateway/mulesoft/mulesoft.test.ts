import { describe, expect, it } from "vitest";
import { MulesoftGatewayAdapter } from "./adapter.js";

/**
 * Two entries share `assetId: orders-api`: one with no `instanceLabel`, one
 * bound to `instanceLabel: prod`. A caller-supplied environment is a hard
 * constraint — it must never match the entry missing `instanceLabel` just
 * because that entry has nothing to compare against.
 */
const DUPLICATE_ASSET_EXPORT = `apis:
  - assetId: orders-api
    resources:
      - { method: "GET", path: "/orders" }
  - assetId: orders-api
    instanceLabel: prod
    resources:
      - { method: "GET", path: "/orders" }
`;

describe("MuleSoft adapter extractApi lineage integrity", () => {
  it("does not bind a caller-requested environment to an asset missing that environment", async () => {
    const adapter = new MulesoftGatewayAdapter();
    const connection = { id: "mule-dup", config: DUPLICATE_ASSET_EXPORT };

    const imported = await adapter.extractApi(
      connection,
      { id: "orders-api", environmentId: "prod" },
      {},
    );

    expect(imported.contract.location.pointer).toBe("/apis/1");
    expect(imported.diagnostics.some((d) => d.code === "mulesoft/unknown_api")).toBe(false);
  });

  it("does not bind a caller-requested version to an asset missing that version", async () => {
    const adapter = new MulesoftGatewayAdapter();
    const connection = {
      id: "mule-dup-version",
      config: `apis:
  - assetId: orders-api
    resources:
      - { method: "GET", path: "/orders" }
  - assetId: orders-api
    productVersion: v2
    resources:
      - { method: "GET", path: "/orders" }
`,
    };

    const imported = await adapter.extractApi(connection, { id: "orders-api", version: "v2" }, {});

    expect(imported.contract.location.pointer).toBe("/apis/1");
  });
});

describe("MuleSoft adapter inventory authSummary", () => {
  it("falls back to a scoped auth signal when resource scopes exist without an AUTH_POLICIES match", async () => {
    const adapter = new MulesoftGatewayAdapter();
    const connection = {
      id: "mule-scopes",
      config: `apis:
  - assetId: orders-api
    resources:
      - { method: "GET", path: "/orders", scopes: ["read:orders"] }
    policies:
      - { policyId: custom-dataweave }
`,
    };

    const inv = await adapter.inventory(connection, {});
    expect(inv.apis[0]?.authSummary).toBeDefined();
  });

  it("leaves authSummary undefined with neither an auth policy nor scopes", async () => {
    const adapter = new MulesoftGatewayAdapter();
    const connection = {
      id: "mule-no-auth",
      config: `apis:
  - assetId: orders-api
    resources:
      - { method: "GET", path: "/orders" }
`,
    };

    const inv = await adapter.inventory(connection, {});
    expect(inv.apis[0]?.authSummary).toBeUndefined();
  });
});
