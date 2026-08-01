import { describe, expect, it } from "vitest";
import { ApiConnectGatewayAdapter } from "./adapter.js";

/**
 * Two APIs share the name `orders`: one with no `version` field, one with
 * `version: "2"`. A caller-supplied version is a hard constraint — it must
 * never match the unversioned entry just because it lacks a version to
 * compare against.
 */
const DUPLICATE_NAME_EXPORT = `apis:
  - name: orders
    resources:
      - { method: "GET", path: "/orders" }
  - name: orders
    version: "2"
    resources:
      - { method: "GET", path: "/orders" }
`;

describe("API Connect adapter extractApi lineage integrity", () => {
  it("does not bind a caller-requested version to an API missing that version", async () => {
    const adapter = new ApiConnectGatewayAdapter();
    const connection = { id: "apic-dup", config: DUPLICATE_NAME_EXPORT };

    const imported = await adapter.extractApi(connection, { id: "orders", version: "2" }, {});

    expect(imported.contract.location.pointer).toBe("/apis/1");
    expect(imported.diagnostics.some((d) => d.code === "apiconnect/unknown_api")).toBe(false);
  });

  it("reports unknown_api when no API satisfies the requested version", async () => {
    const adapter = new ApiConnectGatewayAdapter();
    const connection = {
      id: "apic-no-match",
      config: `apis:
  - name: orders
    resources:
      - { method: "GET", path: "/orders" }
`,
    };

    const imported = await adapter.extractApi(connection, { id: "orders", version: "2" }, {});

    expect(imported.diagnostics.some((d) => d.code === "apiconnect/unknown_api")).toBe(true);
  });
});

describe("API Connect adapter inventory authSummary", () => {
  it("reflects resource-level scopes even without a declared oauthProvider", async () => {
    const adapter = new ApiConnectGatewayAdapter();
    const connection = {
      id: "apic-scopes",
      config: `apis:
  - name: orders
    resources:
      - { method: "GET", path: "/orders", scopes: ["read:orders"] }
`,
    };

    const inv = await adapter.inventory(connection, {});
    expect(inv.apis[0]?.authSummary).toBe("OAuth2");
  });

  it("leaves authSummary undefined with neither oauthProviders nor scopes", async () => {
    const adapter = new ApiConnectGatewayAdapter();
    const connection = {
      id: "apic-no-auth",
      config: `apis:
  - name: orders
    resources:
      - { method: "GET", path: "/orders" }
`,
    };

    const inv = await adapter.inventory(connection, {});
    expect(inv.apis[0]?.authSummary).toBeUndefined();
  });
});
