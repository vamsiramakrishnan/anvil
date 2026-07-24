import { describe, expect, it } from "vitest";
import {
  gatewayAgentServiceId,
  gatewayDeploymentNamespace,
  gatewayImportIdentity,
  gatewayImportIdentitySlug,
  resolveGatewayApiSelection,
  verifyGatewayImportIdentity,
} from "./identity.js";
import { finalizeInventory } from "./inventory.js";
import type { GatewayApiSummary } from "./model.js";

function api(
  version: string,
  environmentIds: string[],
  overrides: Partial<GatewayApiSummary> = {},
): GatewayApiSummary {
  return {
    id: "orders",
    name: "Orders",
    version,
    environmentIds,
    routes: [],
    hasSpec: false,
    productIds: [],
    hasQuota: false,
    ...overrides,
  };
}

describe("gateway import identity", () => {
  it("separates stable coordinate ownership from whole-estate evidence lineage", () => {
    const baseline = {
      vendor: "kong" as const,
      gatewayId: "gateway-a",
      gatewayIdSource: "operator" as const,
      apiId: "orders",
      serviceId: "orders",
      environment: "prod",
      revision: "v1",
      exportDigest: `sha256:${"a".repeat(64)}`,
      inventoryDigest: "inventory-a",
    };
    const first = gatewayImportIdentity(baseline);
    expect(verifyGatewayImportIdentity(first)).toMatchObject({ ok: true });

    const coordinateVariants = [
      { vendor: "wso2" as const },
      { gatewayId: "gateway-b" },
      { apiId: "refunds" },
      { serviceId: "orders-v2" },
      { environment: "test" },
      { revision: "v2" },
    ];
    for (const variant of coordinateVariants) {
      expect(gatewayImportIdentity({ ...baseline, ...variant }).digest).not.toBe(first.digest);
    }

    for (const evidenceVariant of [
      { gatewayIdSource: "export" as const },
      { exportDigest: `sha256:${"b".repeat(64)}` },
      { inventoryDigest: "inventory-b" },
    ]) {
      const changed = gatewayImportIdentity({ ...baseline, ...evidenceVariant });
      expect(changed.digest).toBe(first.digest);
      expect(gatewayImportIdentitySlug(changed)).toBe(gatewayImportIdentitySlug(first));
      expect(gatewayDeploymentNamespace(changed)).toBe(gatewayDeploymentNamespace(first));
      expect(changed.lineageDigest).not.toBe(first.lineageDigest);
    }

    expect(gatewayDeploymentNamespace(first)).toMatch(/^orders-[0-9a-f]{24}$/);
    expect(
      gatewayDeploymentNamespace(gatewayImportIdentity({ ...baseline, environment: "test" })),
    ).not.toBe(gatewayDeploymentNamespace(first));
    expect(
      gatewayAgentServiceId({
        vendor: baseline.vendor,
        gatewayId: baseline.gatewayId,
        apiId: baseline.apiId,
        environment: baseline.environment,
        revision: baseline.revision,
      }),
    ).toMatch(/^orders-prod-v1-[0-9a-f]{16}$/);
    expect(
      gatewayAgentServiceId({
        vendor: baseline.vendor,
        gatewayId: baseline.gatewayId,
        apiId: baseline.apiId,
        environment: "test",
        revision: baseline.revision,
      }),
    ).not.toBe(
      gatewayAgentServiceId({
        vendor: baseline.vendor,
        gatewayId: baseline.gatewayId,
        apiId: baseline.apiId,
        environment: baseline.environment,
        revision: baseline.revision,
      }),
    );
  });

  it("requires explicit environment and revision instead of choosing the first API row", () => {
    const estate = [
      api("v1", ["prod"]),
      api("v1", ["test"]),
      api("v2", ["prod"]),
      api("v2", ["test"]),
    ];

    expect(resolveGatewayApiSelection(estate, { apiId: "orders" })).toMatchObject({
      ok: false,
      failure: { code: "gateway_selection/revision_required" },
    });
    expect(resolveGatewayApiSelection(estate, { apiId: "orders", revision: "v2" })).toMatchObject({
      ok: false,
      failure: { code: "gateway_selection/environment_required" },
    });
    expect(
      resolveGatewayApiSelection(estate, {
        apiId: "orders",
        revision: "v2",
        environment: "test",
      }),
    ).toMatchObject({
      ok: true,
      selection: {
        revision: "v2",
        environment: "test",
        api: { id: "orders", version: "v2", environmentIds: ["test"] },
      },
    });
  });

  it("never attests concrete revision or environment values when source axes are absent", () => {
    for (const unprovenVersion of ["", "0.0.0"]) {
      expect(
        resolveGatewayApiSelection([api(unprovenVersion, [])], {
          apiId: "orders",
          revision: "2026-07-24.1",
          environment: "prod-eu",
        }),
      ).toMatchObject({
        ok: false,
        failure: { code: "gateway_selection/revision_not_found" },
      });
    }

    expect(
      resolveGatewayApiSelection([api("", [])], {
        apiId: "orders",
        revision: "unversioned",
        environment: "prod-eu",
      }),
    ).toMatchObject({
      ok: false,
      failure: { code: "gateway_selection/environment_not_found" },
    });

    // Sentinels describe source absence; they do not invent a native value.
    expect(
      resolveGatewayApiSelection([api("", [])], {
        apiId: "orders",
        revision: "unversioned",
        environment: "unscoped",
      }),
    ).toMatchObject({
      ok: true,
      selection: {
        revision: "unversioned",
        environment: "unscoped",
      },
    });
  });

  it("allows the same API id across environments and revisions but rejects an exact collision", () => {
    const distinct = finalizeInventory({
      schemaVersion: 1,
      gateway: { kind: "apigee", id: "gateway-a" },
      environments: [{ id: "prod" }, { id: "test" }],
      apis: [api("v1", ["prod"]), api("v1", ["test"]), api("v2", ["prod"])],
      products: [],
      diagnostics: [],
    });
    expect(distinct.diagnostics).toEqual([]);

    const duplicate = finalizeInventory({
      schemaVersion: 1,
      gateway: { kind: "apigee", id: "gateway-a" },
      environments: [{ id: "prod" }],
      apis: [api("v1", ["prod"]), api("v1", ["prod"])],
      products: [],
      diagnostics: [],
    });
    expect(duplicate.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        code: "gateway/duplicate_api_coordinate",
      }),
    );
  });

  it("keeps inventory identity stable across semantically irrelevant permutations", () => {
    const draft = {
      schemaVersion: 1 as const,
      gateway: { kind: "kong" as const, id: "gateway-a" },
      environments: [{ id: "test" }, { id: "prod" }],
      apis: [
        api("v1", ["test", "prod"], {
          routes: [
            {
              id: "orders",
              methods: ["POST", "GET"],
              paths: ["/orders/{id}", "/orders"],
              hosts: ["b.example.test", "a.example.test"],
              protocols: ["https", "http"],
            },
          ],
          productIds: ["premium", "standard"],
          identityEvidence: [
            {
              basis: "explicit_configuration" as const,
              operationRef: "GET /orders",
              issuer: "https://identity.example.test/",
              scopes: ["orders:write", "orders:read"],
              coordinate: {
                origin: "gateway-export://sha256:abc",
                pointer: "/services/0/plugins/0",
              },
            },
          ],
        }),
      ],
      products: [{ id: "orders", name: "Orders", plans: ["gold", "silver"] }],
      diagnostics: [
        { level: "warning" as const, code: "b", message: "second" },
        { level: "info" as const, code: "a", message: "first" },
      ],
    };
    const permuted = structuredClone(draft);
    permuted.environments.reverse();
    permuted.apis[0]?.environmentIds.reverse();
    permuted.apis[0]?.routes.reverse();
    permuted.apis[0]?.routes[0]?.methods.reverse();
    permuted.apis[0]?.routes[0]?.paths.reverse();
    permuted.apis[0]?.routes[0]?.hosts.reverse();
    permuted.apis[0]?.routes[0]?.protocols.reverse();
    permuted.apis[0]?.productIds.reverse();
    permuted.apis[0]?.identityEvidence?.reverse();
    permuted.apis[0]?.identityEvidence?.[0]?.scopes?.reverse();
    permuted.products.reverse();
    permuted.products[0]?.plans.reverse();
    permuted.diagnostics.reverse();

    expect(finalizeInventory(permuted).digest).toBe(finalizeInventory(draft).digest);
  });

  it("reserves absence sentinels while allowing truly omitted native coordinates", () => {
    const snapshot = finalizeInventory({
      schemaVersion: 1,
      gateway: { kind: "apigee", id: "gateway-a" },
      environments: [],
      apis: [
        api("unversioned", ["prod"], { id: "declared-revision" }),
        api("v1", ["unscoped"], { id: "declared-environment" }),
        api("", [], { id: "omitted-coordinate" }),
      ],
      products: [],
      diagnostics: [],
    });

    expect(snapshot.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "error",
          code: "gateway/reserved_api_revision",
          message: expect.stringContaining("declared-revision@unversioned"),
        }),
        expect.objectContaining({
          level: "error",
          code: "gateway/reserved_api_environment",
          message: expect.stringContaining("declared-environment@v1#unscoped"),
        }),
      ]),
    );
    expect(snapshot.diagnostics.map((diagnostic) => diagnostic.message).join("\n")).not.toContain(
      "omitted-coordinate@unversioned",
    );
  });
});
