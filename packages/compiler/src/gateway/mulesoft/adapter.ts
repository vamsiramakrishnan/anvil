/**
 * The MuleSoft (API Manager / Exchange) adapter. MuleSoft fronts an asset's API
 * with policies (client-id enforcement, OAuth/JWT, SLA rate limits) and mediation
 * (DataWeave/flows). Declared policies normalize into the overlay; DataWeave and
 * arbitrary flow logic are classified **opaque** — Anvil does not claim to
 * understand them.
 */
import type { AdapterContext, GatewayAdapter, GatewayConnection } from "../adapter.js";
import { finalizeInventory } from "../inventory.js";
import type {
  EvidenceCoordinate,
  GatewayAdapterCapabilities,
  GatewayApiImport,
  GatewayApiRef,
  GatewayApiSummary,
  GatewayDiagnostic,
  GatewayInventorySnapshot,
  GatewayProbeResult,
} from "../model.js";
import type { GatewayFact } from "../overlay.js";
import { asObjects, asStrings, parseGatewayDocument } from "../parse-safe.js";
import {
  buildGatewayApiImport,
  normalizePath,
  routeOnlyContract,
  type SynthOp,
  synthOperationId,
} from "../synth.js";

interface MuleResource {
  method: string;
  path: string;
  scopes?: string[];
}
interface MulePolicy {
  policyId: string;
  config?: Record<string, unknown>;
}
interface MuleApi {
  assetId: string;
  productVersion?: string;
  instanceLabel?: string;
  resources?: MuleResource[];
  policies?: MulePolicy[];
}

export interface MulesoftConnection extends GatewayConnection {
  config: string;
  origin?: string;
}

const AUTH_POLICIES = new Set([
  "openidconnect",
  "openid-connect",
  "jwt-validation",
  "client-id-enforcement",
  "oauth2-provider",
]);
const RATE_POLICIES = new Set(["rate-limiting", "rate-limiting-sla", "spike-control"]);

const CAPABILITIES: GatewayAdapterCapabilities = {
  inventory: true,
  apiSpecs: false,
  routes: true,
  authentication: true,
  authorization: true,
  trafficPolicies: true,
  transformations: "partial",
  faultPolicies: false,
  products: true,
  consumers: true,
  trafficAnalytics: false,
  drift: false,
  publish: false,
};

function parseExport(
  config: string,
  origin: string,
): { apis: MuleApi[]; diagnostics: GatewayDiagnostic[] } {
  const parsed = parseGatewayDocument(config, "mulesoft", origin);
  if (!parsed.document) return { apis: [], diagnostics: parsed.diagnostics };
  if (!Array.isArray(parsed.document.apis)) {
    return {
      apis: [],
      diagnostics: [
        {
          level: "error",
          code: "mulesoft/invalid_export",
          message: "The MuleSoft export must contain an `apis` array.",
          coordinate: { origin },
        },
      ],
    };
  }
  if (parsed.document.apis.length === 0) {
    return {
      apis: [],
      diagnostics: [
        {
          level: "error",
          code: "mulesoft/empty_export",
          message: "The MuleSoft export contains no APIs.",
          coordinate: { origin, pointer: "/apis" },
        },
      ],
    };
  }
  const apis = asObjects<MuleApi>(parsed.document.apis);
  if (
    apis.length !== parsed.document.apis.length ||
    apis.some((api) => typeof api.assetId !== "string" || api.assetId.length === 0)
  ) {
    return {
      apis: [],
      diagnostics: [
        {
          level: "error",
          code: "mulesoft/invalid_export",
          message: "Every MuleSoft API must be an object with a non-empty `assetId`.",
          coordinate: { origin, pointer: "/apis" },
        },
      ],
    };
  }
  return { apis, diagnostics: [] };
}

function opsOf(api: MuleApi): SynthOp[] {
  return asObjects<MuleResource>(api.resources).map((r) => ({
    operationId: synthOperationId(api.assetId, r.method, r.path),
    method: r.method,
    path: normalizePath(r.path),
  }));
}

function normalizeApi(api: MuleApi, apiIndex: number, origin: string) {
  const ops = opsOf(api);
  const facts: GatewayFact[] = [];
  const diagnostics: GatewayDiagnostic[] = [];
  let hasQuota = false;
  let authSummary: string | undefined;

  asObjects<MuleResource>(api.resources).forEach((r, j) => {
    const scopes = asStrings(r.scopes);
    if (scopes.length > 0) {
      const coordinate: EvidenceCoordinate = {
        origin,
        pointer: `/apis/${apiIndex}/resources/${j}/scopes`,
      };
      facts.push({
        target: { scope: "operation", ref: synthOperationId(api.assetId, r.method, r.path) },
        predicate: "auth.scopes",
        operation: "restrict",
        value: scopes,
        coordinate,
        note: "MuleSoft resource scopes",
      });
    }
  });

  asObjects<MulePolicy>(api.policies).forEach((p, k) => {
    const coordinate: EvidenceCoordinate = { origin, pointer: `/apis/${apiIndex}/policies/${k}` };
    if (AUTH_POLICIES.has(p.policyId)) authSummary = p.policyId;
    else if (RATE_POLICIES.has(p.policyId)) {
      hasQuota = true;
      diagnostics.push({
        level: "info",
        code: "mulesoft/sla_present",
        message: `SLA/rate policy '${p.policyId}' on '${api.assetId}' applies but is not an operation semantic.`,
        coordinate,
      });
    } else {
      // DataWeave / custom flow logic — classified opaque, not interpreted.
      diagnostics.push({
        level: "warning",
        code: "gateway/opaque_policy",
        message: `MuleSoft policy '${p.policyId}' on '${api.assetId}' is opaque (flow/DataWeave logic is not deterministically understood).`,
        coordinate,
      });
    }
  });

  return { ops, facts, diagnostics, hasQuota, authSummary };
}

export class MulesoftGatewayAdapter implements GatewayAdapter<MulesoftConnection> {
  readonly kind = "mulesoft" as const;
  readonly capabilities = CAPABILITIES;

  async probe(connection: MulesoftConnection, _ctx: AdapterContext): Promise<GatewayProbeResult> {
    const origin = connection.origin ?? "mulesoft.yaml";
    const parsed = parseExport(connection.config, origin);
    return {
      reachable: parsed.diagnostics.every((d) => d.level !== "error"),
      capabilities: CAPABILITIES,
      diagnostics: parsed.diagnostics,
    };
  }

  async inventory(
    connection: MulesoftConnection,
    _ctx: AdapterContext,
  ): Promise<GatewayInventorySnapshot> {
    const origin = connection.origin ?? "mulesoft.yaml";
    const parsed = parseExport(connection.config, origin);
    const diagnostics: GatewayDiagnostic[] = [...parsed.diagnostics];
    const summaries: GatewayApiSummary[] = parsed.apis.map((api, i) => {
      const norm = normalizeApi(api, i, origin);
      diagnostics.push(...norm.diagnostics);
      return {
        id: api.assetId,
        name: api.assetId,
        version: api.productVersion ?? "0.0.0",
        lifecycle: "published",
        environmentIds: api.instanceLabel ? [api.instanceLabel] : [],
        routes: norm.ops.map((o) => ({
          id: o.operationId,
          methods: [o.method],
          paths: [o.path],
          hosts: [],
          protocols: [],
        })),
        hasSpec: false,
        contract: routeOnlyContract({ origin, pointer: `/apis/${i}` }),
        productIds: [],
        authSummary: norm.authSummary,
        hasQuota: norm.hasQuota,
      };
    });
    return finalizeInventory({
      schemaVersion: 1,
      gateway: { kind: "mulesoft", id: connection.id, name: origin },
      environments: [],
      apis: summaries,
      products: [],
      diagnostics,
    });
  }

  async extractApi(
    connection: MulesoftConnection,
    api: GatewayApiRef,
    _ctx: AdapterContext,
  ): Promise<GatewayApiImport> {
    const origin = connection.origin ?? "mulesoft.yaml";
    const parsed = parseExport(connection.config, origin);
    const apiIndex = parsed.apis.findIndex((a) => a.assetId === api.id);
    const found = parsed.apis[apiIndex];
    if (!found) {
      const empty = buildGatewayApiImport({
        originKind: "mulesoft",
        apiName: api.id,
        sourceCoordinate: { origin },
        ops: [],
        facts: [],
        diagnostics: [],
      });
      return {
        ...empty,
        diagnostics: [
          ...parsed.diagnostics,
          {
            level: "error",
            code: "mulesoft/unknown_api",
            message: `No MuleSoft asset '${api.id}'.`,
          },
        ],
      };
    }
    const norm = normalizeApi(found, apiIndex, origin);
    return buildGatewayApiImport({
      originKind: "mulesoft",
      apiName: found.assetId,
      version: found.productVersion,
      sourceCoordinate: { origin, pointer: `/apis/${apiIndex}` },
      ops: norm.ops,
      facts: norm.facts,
      authConfigured: Boolean(norm.authSummary),
      diagnostics: norm.diagnostics,
    });
  }
}
