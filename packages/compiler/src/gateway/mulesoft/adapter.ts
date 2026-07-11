/**
 * The MuleSoft (API Manager / Exchange) adapter. MuleSoft fronts an asset's API
 * with policies (client-id enforcement, OAuth/JWT, SLA rate limits) and mediation
 * (DataWeave/flows). Declared policies normalize into the overlay; DataWeave and
 * arbitrary flow logic are classified **opaque** — Anvil does not claim to
 * understand them.
 */
import { parse as parseYaml } from "yaml";
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
import { buildGatewayApiImport, normalizePath, type SynthOp, synthOperationId } from "../synth.js";

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
  apiSpecs: true,
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

function apisOf(config: string): MuleApi[] {
  const doc = parseYaml(config) as { apis?: MuleApi[] } | null;
  return Array.isArray(doc?.apis) ? (doc?.apis as MuleApi[]) : [];
}

function opsOf(api: MuleApi): SynthOp[] {
  return (api.resources ?? []).map((r) => ({
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

  (api.resources ?? []).forEach((r, j) => {
    if (r.scopes && r.scopes.length > 0) {
      const coordinate: EvidenceCoordinate = {
        origin,
        pointer: `/apis/${apiIndex}/resources/${j}/scopes`,
      };
      facts.push({
        target: { scope: "operation", ref: synthOperationId(api.assetId, r.method, r.path) },
        predicate: "auth.scopes",
        operation: "restrict",
        value: r.scopes,
        coordinate,
        note: "MuleSoft resource scopes",
      });
    }
  });

  (api.policies ?? []).forEach((p, k) => {
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
    return {
      reachable: apisOf(connection.config).length > 0,
      capabilities: CAPABILITIES,
      diagnostics: [],
    };
  }

  async inventory(
    connection: MulesoftConnection,
    _ctx: AdapterContext,
  ): Promise<GatewayInventorySnapshot> {
    const origin = connection.origin ?? "mulesoft.yaml";
    const apis = apisOf(connection.config);
    const diagnostics: GatewayDiagnostic[] = [];
    const summaries: GatewayApiSummary[] = apis.map((api, i) => {
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
        hasSpec: norm.ops.length > 0,
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
    const apis = apisOf(connection.config);
    const apiIndex = apis.findIndex((a) => a.assetId === api.id);
    const found = apis[apiIndex];
    if (!found) {
      const empty = buildGatewayApiImport({
        originKind: "mulesoft",
        apiName: api.id,
        ops: [],
        facts: [],
        diagnostics: [],
      });
      return {
        ...empty,
        diagnostics: [
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
      ops: norm.ops,
      facts: norm.facts,
      diagnostics: norm.diagnostics,
    });
  }
}
