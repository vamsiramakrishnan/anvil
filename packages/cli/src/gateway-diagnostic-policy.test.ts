import type { GatewayDiagnostic } from "@anvil/compiler";
import { describe, expect, it } from "vitest";
import {
  dedupeGatewayDiagnostics,
  gatewayDiagnosticAppliesToSelection,
} from "./commands/gateway-diagnostic-policy.js";

const PROJECT_A = `sha256:${"a".repeat(64)}`;
const PROJECT_B = `sha256:${"b".repeat(64)}`;

describe("gateway diagnostic selection policy", () => {
  it("treats only a missing subject as truly global", () => {
    const global: GatewayDiagnostic = {
      level: "error",
      code: "gateway/export_invalid",
      message: "The whole export cannot be parsed.",
    };
    expect(
      gatewayDiagnosticAppliesToSelection(global, {
        id: "orders",
        revision: "7",
        environment: "prod",
      }),
    ).toBe(true);
  });

  it("matches every populated API coordinate constraint", () => {
    const diagnostic: GatewayDiagnostic = {
      level: "error",
      code: "gateway/duplicate_api_coordinate",
      message: "Duplicate coordinate.",
      subject: {
        api: {
          id: "orders",
          apiVersion: "2.1.0",
          revision: "7",
          environment: "prod",
        },
      },
    };
    const selected = {
      id: "orders",
      apiVersion: "2.1.0",
      revision: "7",
      environment: "prod",
    };
    expect(gatewayDiagnosticAppliesToSelection(diagnostic, selected)).toBe(true);
    expect(
      gatewayDiagnosticAppliesToSelection(diagnostic, { ...selected, apiVersion: "2.0.0" }),
    ).toBe(false);
    expect(gatewayDiagnosticAppliesToSelection(diagnostic, { ...selected, revision: "8" })).toBe(
      false,
    );
    expect(
      gatewayDiagnosticAppliesToSelection(diagnostic, { ...selected, environment: "staging" }),
    ).toBe(false);
  });

  it("isolates an API-unknown project error by content-addressed artifact lineage", () => {
    const diagnostic: GatewayDiagnostic = {
      level: "error",
      code: "wso2/project_invalid",
      message: "This API project cannot be parsed.",
      subject: {
        artifact: {
          origin: "gateway-export://project-b",
          digest: PROJECT_B,
        },
      },
    };
    const baseSelection = {
      id: "orders",
      revision: "unversioned",
      environment: "unscoped",
    };
    expect(
      gatewayDiagnosticAppliesToSelection(diagnostic, {
        ...baseSelection,
        artifacts: [
          {
            origin: "gateway-export://project-a",
            digest: PROJECT_A,
          },
        ],
      }),
    ).toBe(false);
    expect(
      gatewayDiagnosticAppliesToSelection(diagnostic, {
        ...baseSelection,
        artifacts: [
          {
            origin: "gateway-export://project-b/member",
            digest: PROJECT_A,
            parent: {
              origin: "gateway-export://project-b",
              digest: PROJECT_B,
            },
          },
        ],
      }),
    ).toBe(true);
    expect(gatewayDiagnosticAppliesToSelection(diagnostic, baseSelection)).toBe(false);
  });

  it("ANDs API and artifact constraints instead of weakening either", () => {
    const diagnostic: GatewayDiagnostic = {
      level: "warning",
      code: "gateway/opaque_policy",
      message: "Opaque policy.",
      subject: {
        api: { id: "orders" },
        artifact: {
          origin: "gateway-export://orders",
          digest: PROJECT_A,
        },
      },
    };
    const artifacts = [{ origin: "gateway-export://orders", digest: PROJECT_A }];
    expect(
      gatewayDiagnosticAppliesToSelection(diagnostic, {
        id: "orders",
        revision: "unversioned",
        environment: "unscoped",
        artifacts,
      }),
    ).toBe(true);
    expect(
      gatewayDiagnosticAppliesToSelection(diagnostic, {
        id: "payments",
        revision: "unversioned",
        environment: "unscoped",
        artifacts,
      }),
    ).toBe(false);
  });

  it("deduplicates semantic repeats canonically but preserves distinct route ownership", () => {
    const first: GatewayDiagnostic = {
      level: "warning",
      code: "gateway/opaque_policy",
      message: "Opaque policy.",
      coordinate: { origin: "kong.yaml", pointer: "/services/0/plugins/0" },
      subject: { api: { id: "orders" } },
    };
    const sameWithDifferentPropertyOrder = {
      subject: { api: { id: "orders" } },
      message: "Opaque policy.",
      code: "gateway/opaque_policy",
      coordinate: { pointer: "/services/0/plugins/0", origin: "kong.yaml" },
      level: "warning",
    } as GatewayDiagnostic;
    const otherRoute: GatewayDiagnostic = {
      ...first,
      subject: { api: { id: "orders" }, route: { id: "create-order" } },
    };
    expect(dedupeGatewayDiagnostics([first, sameWithDifferentPropertyOrder])).toHaveLength(1);
    expect(dedupeGatewayDiagnostics([first, otherRoute])).toHaveLength(2);
  });
});
