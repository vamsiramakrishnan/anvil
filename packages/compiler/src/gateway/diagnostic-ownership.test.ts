import { describe, expect, it } from "vitest";
import { finalizeInventory, type InventoryDraft } from "./inventory.js";
import { GatewayDiagnostic } from "./model.js";

function api(
  id: string,
  options: { version?: string; revision?: string; environments?: string[] } = {},
): InventoryDraft["apis"][number] {
  return {
    id,
    name: id,
    ...(options.version ? { version: options.version } : {}),
    ...(options.revision ? { revision: options.revision } : {}),
    environmentIds: options.environments ?? [],
    routes: [],
    hasSpec: false,
    productIds: [],
    hasQuota: false,
  };
}

function inventory(apis: InventoryDraft["apis"]): ReturnType<typeof finalizeInventory> {
  return finalizeInventory({
    schemaVersion: 1,
    gateway: { kind: "wso2", id: "corp" },
    environments: [],
    apis,
    products: [],
    diagnostics: [],
  });
}

describe("gateway diagnostic ownership", () => {
  it("accepts artifact-only ownership but rejects an empty or route-only subject", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    expect(
      GatewayDiagnostic.safeParse({
        level: "error",
        code: "wso2/project_invalid",
        message: "Project-local parse error.",
        subject: {
          artifact: {
            origin: "gateway-export://project-a",
            digest,
          },
        },
      }).success,
    ).toBe(true);
    expect(
      GatewayDiagnostic.safeParse({
        level: "error",
        code: "gateway/invalid_subject",
        message: "No ownership.",
        subject: {},
      }).success,
    ).toBe(false);
    expect(
      GatewayDiagnostic.safeParse({
        level: "error",
        code: "gateway/invalid_subject",
        message: "A route cannot float outside an API.",
        subject: { route: { id: "route-a" } },
      }).success,
    ).toBe(false);
  });

  it("does not confuse distinct semantic API versions at one gateway revision", () => {
    const snapshot = inventory([
      api("orders", { version: "0.0.0", revision: "revision-7", environments: ["prod"] }),
      api("orders", { version: "1.0.0", revision: "revision-7", environments: ["prod"] }),
      api("orders", { version: "2.0.0", revision: "revision-7", environments: ["prod"] }),
    ]);
    expect(snapshot.diagnostics).toEqual([]);
  });

  it("scopes a duplicate to the exact API-version/revision/environment coordinate", () => {
    const snapshot = inventory([
      api("good-a"),
      api("orders", { version: "2.0.0", revision: "revision-7", environments: ["prod"] }),
      api("orders", { version: "2.0.0", revision: "revision-7", environments: ["prod"] }),
      api("orders", {
        version: "2.0.0",
        revision: "revision-7",
        environments: ["staging"],
      }),
    ]);
    expect(snapshot.diagnostics).toEqual([
      expect.objectContaining({
        level: "error",
        code: "gateway/duplicate_api_coordinate",
        subject: {
          api: {
            id: "orders",
            apiVersion: "2.0.0",
            revision: "revision-7",
            environment: "prod",
          },
        },
      }),
    ]);
  });

  it("preserves semantic API version 0.0.0 when a distinct gateway revision exists", () => {
    const snapshot = inventory([
      api("orders", { version: "0.0.0", revision: "revision-8", environments: ["staging"] }),
      api("orders", { version: "0.0.0", revision: "revision-8", environments: ["staging"] }),
    ]);
    expect(snapshot.diagnostics).toEqual([
      expect.objectContaining({
        code: "gateway/duplicate_api_coordinate",
        subject: {
          api: {
            id: "orders",
            apiVersion: "0.0.0",
            revision: "revision-8",
            environment: "staging",
          },
        },
      }),
    ]);
  });
});
