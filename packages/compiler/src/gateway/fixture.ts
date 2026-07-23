/**
 * A fake gateway adapter. It ships no vendor code and talks to nothing — it
 * exists to prove, in tests and in the conformance suite, that an adapter which
 * emits only `SourceSnapshot + GatewayPolicyOverlay` can feed the entire compiler
 * pipeline. It is the reference implementation of `GatewayAdapter`: deterministic,
 * secret-free, evidence-backed, and read-only (no publish).
 */

import { ephemeralCompilerSource } from "../source/compiler-source.js";
import type { AdapterContext, GatewayAdapter, GatewayConnection } from "./adapter.js";
import { finalizeInventory } from "./inventory.js";
import type {
  GatewayAdapterCapabilities,
  GatewayApiImport,
  GatewayApiRef,
  GatewayContractProvenance,
  GatewayDiagnostic,
  GatewayInventorySnapshot,
  GatewayProbeResult,
} from "./model.js";
import { buildGatewayOverlay, type GatewayFact } from "./overlay.js";

const CAPABILITIES: GatewayAdapterCapabilities = {
  inventory: true,
  apiSpecs: true,
  routes: true,
  authentication: true,
  authorization: true,
  trafficPolicies: true,
  transformations: "partial", // some plugins are modelled; opaque ones are diagnosed.
  faultPolicies: false,
  products: true,
  consumers: false,
  trafficAnalytics: false,
  drift: false,
  publish: false,
};

/** A synthesized OpenAPI spec for one fixture API, byte-identical across runs. */
const REFUNDS_SPEC = `openapi: "3.0.3"
info: { title: Refunds, version: "2.1.0" }
paths:
  /refunds:
    post:
      operationId: createRefund
      responses: { "201": { description: created } }
  /refunds/{id}:
    get:
      operationId: getRefund
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
      responses: { "200": { description: ok } }
`;

const REPORTING_SPEC = `openapi: "3.0.3"
info: { title: Reporting, version: "1.4.0" }
paths:
  /reports:
    get:
      operationId: listReports
      responses: { "200": { description: ok } }
`;

const SPECS: Record<string, string> = { refunds: REFUNDS_SPEC, reporting: REPORTING_SPEC };

/** The export archive name this fixture pretends to have decoded (for coordinates). */
const EXPORT = "fixture-export.yaml";

/**
 * A fake gateway with two APIs — a transactional `refunds` service and a
 * read-only `reporting` service — plus a product, two environments, and one
 * deliberately opaque plugin the adapter refuses to pretend it understands.
 */
export class FakeGatewayAdapter implements GatewayAdapter {
  readonly kind = "fixture" as const;
  readonly capabilities = CAPABILITIES;

  async probe(_c: GatewayConnection, _ctx: AdapterContext): Promise<GatewayProbeResult> {
    return {
      reachable: true,
      protocolVersion: "fixture/1",
      capabilities: CAPABILITIES,
      diagnostics: [],
    };
  }

  async inventory(_c: GatewayConnection, _ctx: AdapterContext): Promise<GatewayInventorySnapshot> {
    return finalizeInventory({
      schemaVersion: 1,
      gateway: { kind: "fixture", id: "fixture-gw", name: "Fixture Gateway" },
      environments: [
        { id: "sandbox", name: "Sandbox", kind: "non-prod" },
        { id: "prod", name: "Production", kind: "prod" },
      ],
      apis: [
        {
          id: "refunds",
          name: "Refunds",
          version: "2.1.0",
          lifecycle: "published",
          environmentIds: ["sandbox", "prod"],
          routes: [
            {
              id: "refunds-post",
              methods: ["POST"],
              paths: ["/refunds"],
              hosts: [],
              protocols: ["https"],
            },
          ],
          hasSpec: true,
          contract: {
            kind: "native",
            fidelity: "full",
            format: "openapi",
            version: "3.0.3",
            location: { origin: EXPORT, pointer: "/apis/refunds/spec" },
          },
          productIds: ["gold"],
          owner: "payments-team",
          authSummary: "OAuth2 (openid-connect)",
          hasQuota: true,
          trafficSummary: "high",
        },
        {
          id: "reporting",
          name: "Reporting",
          version: "1.4.0",
          lifecycle: "published",
          environmentIds: ["prod"],
          routes: [
            {
              id: "reports-get",
              methods: ["GET"],
              paths: ["/reports"],
              hosts: [],
              protocols: ["https"],
            },
          ],
          hasSpec: true,
          contract: {
            kind: "native",
            fidelity: "full",
            format: "openapi",
            version: "3.0.3",
            location: { origin: EXPORT, pointer: "/apis/reporting/spec" },
          },
          productIds: ["gold"],
          owner: "analytics-team",
          authSummary: "API key",
          hasQuota: false,
          trafficSummary: "low",
        },
      ],
      products: [{ id: "gold", name: "Gold", plans: ["gold-monthly"] }],
      diagnostics: [],
    });
  }

  async extractApi(
    _c: GatewayConnection,
    api: GatewayApiRef,
    _ctx: AdapterContext,
  ): Promise<GatewayApiImport> {
    const spec = SPECS[api.id];
    if (!spec) {
      const source = sourceFor("reporting", REPORTING_SPEC);
      return {
        source,
        overlay: buildGatewayOverlay([]),
        contract: nativeContract("reporting", source),
        diagnostics: [
          { level: "error", code: "gateway/unknown_api", message: `No fixture API '${api.id}'.` },
        ],
      };
    }
    const source = sourceFor(api.id, spec);
    const { facts, diagnostics } = api.id === "refunds" ? refundsFacts() : reportingFacts();
    return {
      source,
      overlay: buildGatewayOverlay(facts, `overlay_gateway_${api.id}`),
      contract: nativeContract(api.id, source),
      diagnostics,
    };
  }
}

/** Normalized control-plane facts for the refunds service, each evidenced. */
function refundsFacts(): { facts: GatewayFact[]; diagnostics: GatewayDiagnostic[] } {
  const opTarget = (ref: string) => ({ scope: "operation" as const, ref });
  const facts: GatewayFact[] = [
    {
      target: opTarget("createRefund"),
      predicate: "auth.scopes",
      operation: "restrict",
      value: ["refunds:write"],
      coordinate: {
        origin: EXPORT,
        pointer: "/services/refunds/plugins/openid-connect/config/scopes",
      },
      note: "openid-connect scope requirement",
    },
    {
      target: opTarget("createRefund"),
      predicate: "effect.risk",
      operation: "set",
      value: "financial",
      coordinate: { origin: EXPORT, pointer: "/services/refunds/tags" },
      note: "tagged financial",
    },
    {
      target: opTarget("createRefund"),
      predicate: "confirmation.required",
      operation: "restrict",
      value: true,
      coordinate: { origin: EXPORT, pointer: "/services/refunds/plugins/request-termination" },
      note: "manual-approval gate",
    },
    {
      target: opTarget("getRefund"),
      predicate: "auth.scopes",
      operation: "restrict",
      value: ["refunds:read"],
      coordinate: {
        origin: EXPORT,
        pointer: "/services/refunds/plugins/openid-connect/config/scopes",
      },
      note: "openid-connect scope requirement",
    },
  ];
  const diagnostics: GatewayDiagnostic[] = [
    {
      level: "warning",
      code: "gateway/opaque_policy",
      message:
        "Custom 'pre-function' Lua plugin on /refunds is opaque; its request transformation is not modelled and blocks automatic certification.",
      coordinate: { origin: EXPORT, pointer: "/services/refunds/plugins/pre-function" },
    },
  ];
  return { facts, diagnostics };
}

function reportingFacts(): { facts: GatewayFact[]; diagnostics: GatewayDiagnostic[] } {
  return {
    facts: [
      {
        target: { scope: "operation", ref: "listReports" },
        predicate: "auth.principal",
        operation: "set",
        value: "service",
        coordinate: { origin: EXPORT, pointer: "/services/reporting/plugins/key-auth" },
        note: "api-key service principal",
      },
    ],
    diagnostics: [],
  };
}

/** Build the immutable compiler source for a fixture API, stamped as gateway-origin. */
function sourceFor(apiId: string, spec: string) {
  const base = ephemeralCompilerSource(spec, `${apiId}.openapi.yaml`);
  return { ...base, origin: { kind: "fixture" as const, uri: `fixture://${apiId}` } };
}

function nativeContract(
  apiId: string,
  source: ReturnType<typeof sourceFor>,
): GatewayContractProvenance {
  return {
    kind: "native",
    fidelity: "full",
    format: source.entrypoint.format,
    version: source.entrypoint.version,
    location: { origin: EXPORT, pointer: `/apis/${apiId}/spec` },
    source: {
      snapshotId: source.snapshotId,
      sourceHash: source.sourceHash,
      entrypoint: source.entrypoint.path,
    },
  };
}
