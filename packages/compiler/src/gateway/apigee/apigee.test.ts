import { describe, expect, it } from "vitest";
import { ApigeeGatewayAdapter } from "./adapter.js";

/**
 * Two proxies share the name `orders`: an undeployed/draft entry with no
 * `revision` (and no `environments`), and a deployed entry with
 * `revision: "2"` bound to `prod`. A caller-supplied version/environment is a
 * hard constraint — it must never match the draft entry just because the
 * draft is missing the disambiguating field.
 */
const DUPLICATE_NAME_EXPORT = `proxies:
  - name: orders
    flows:
      - { method: "GET", path: "/orders" }
  - name: orders
    revision: "2"
    environments: ["prod"]
    flows:
      - { method: "GET", path: "/orders" }
`;

describe("Apigee adapter extractApi lineage integrity", () => {
  it("does not bind a caller-requested revision to a proxy missing that revision", async () => {
    const adapter = new ApigeeGatewayAdapter();
    const connection = { id: "apigee-dup", config: DUPLICATE_NAME_EXPORT };

    const imported = await adapter.extractApi(connection, { id: "orders", version: "2" }, {});

    expect(imported.contract.location.pointer).toBe("/proxies/1");
    expect(imported.diagnostics.some((d) => d.code === "apigee/unknown_proxy")).toBe(false);
  });

  it("does not bind a caller-requested environment to a proxy missing that environment", async () => {
    const adapter = new ApigeeGatewayAdapter();
    const connection = { id: "apigee-dup-env", config: DUPLICATE_NAME_EXPORT };

    const imported = await adapter.extractApi(
      connection,
      { id: "orders", environmentId: "prod" },
      {},
    );

    expect(imported.contract.location.pointer).toBe("/proxies/1");
  });

  it("reports unknown_proxy when no proxy satisfies the requested version", async () => {
    const adapter = new ApigeeGatewayAdapter();
    const connection = {
      id: "apigee-no-match",
      config: `proxies:
  - name: orders
    flows:
      - { method: "GET", path: "/orders" }
`,
    };

    const imported = await adapter.extractApi(connection, { id: "orders", version: "2" }, {});

    expect(imported.diagnostics.some((d) => d.code === "apigee/unknown_proxy")).toBe(true);
  });
});
