/**
 * The WSO2 API Manager adapter. WSO2 exports an API definition (api.yaml) with
 * per-operation verbs, scopes, and security scheme, plus throttling tiers. The
 * adapter normalizes those into the common source + overlay; no WSO2 type escapes.
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

interface WsoOperation {
  target: string;
  verb: string;
  scopes?: string[];
  authType?: string;
}
interface WsoApi {
  name: string;
  context?: string;
  version?: string;
  lifeCycleStatus?: string;
  provider?: string;
  operations?: WsoOperation[];
  securityScheme?: string[];
  apiThrottlingPolicy?: string;
  mediationPolicies?: unknown[];
}

/** A read-only connection to a WSO2 API export (one or more api.yaml documents). */
export interface Wso2Connection extends GatewayConnection {
  config: string;
  origin?: string;
}

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
  consumers: false,
  trafficAnalytics: false,
  drift: false,
  publish: false,
};

function apisOf(config: string): WsoApi[] {
  const doc = parseYaml(config) as { apis?: WsoApi[]; data?: WsoApi } | WsoApi | null;
  if (!doc || typeof doc !== "object") return [];
  if (Array.isArray((doc as { apis?: WsoApi[] }).apis)) return (doc as { apis: WsoApi[] }).apis;
  if ((doc as { data?: WsoApi }).data) return [(doc as { data: WsoApi }).data];
  if ((doc as WsoApi).name) return [doc as WsoApi];
  return [];
}

function opsOf(api: WsoApi): SynthOp[] {
  return (api.operations ?? []).map((op) => ({
    operationId: synthOperationId(api.name, op.verb, op.target),
    method: op.verb,
    path: normalizePath(op.target),
  }));
}

function normalizeApi(
  api: WsoApi,
  apiIndex: number,
  origin: string,
): { ops: SynthOp[]; facts: GatewayFact[]; diagnostics: GatewayDiagnostic[]; hasQuota: boolean } {
  const ops = opsOf(api);
  const facts: GatewayFact[] = [];
  const diagnostics: GatewayDiagnostic[] = [];

  (api.operations ?? []).forEach((op, j) => {
    if (op.scopes && op.scopes.length > 0) {
      const coordinate: EvidenceCoordinate = {
        origin,
        pointer: `/apis/${apiIndex}/operations/${j}/scopes`,
      };
      facts.push({
        target: { scope: "operation", ref: synthOperationId(api.name, op.verb, op.target) },
        predicate: "auth.scopes",
        operation: "restrict",
        value: op.scopes,
        coordinate,
        note: "WSO2 operation scopes",
      });
    }
  });

  const hasQuota = Boolean(api.apiThrottlingPolicy);
  if (hasQuota) {
    diagnostics.push({
      level: "info",
      code: "wso2/throttling_present",
      message: `Throttling tier '${api.apiThrottlingPolicy}' on '${api.name}' applies but is not an operation semantic.`,
      coordinate: { origin, pointer: `/apis/${apiIndex}/apiThrottlingPolicy` },
    });
  }
  if (api.mediationPolicies && api.mediationPolicies.length > 0) {
    diagnostics.push({
      level: "warning",
      code: "gateway/opaque_policy",
      message: `WSO2 mediation on '${api.name}' is not modelled; it may transform requests/responses.`,
      coordinate: { origin, pointer: `/apis/${apiIndex}/mediationPolicies` },
    });
  }
  return { ops, facts, diagnostics, hasQuota };
}

export class Wso2GatewayAdapter implements GatewayAdapter<Wso2Connection> {
  readonly kind = "wso2" as const;
  readonly capabilities = CAPABILITIES;

  async probe(connection: Wso2Connection, _ctx: AdapterContext): Promise<GatewayProbeResult> {
    return {
      reachable: apisOf(connection.config).length > 0,
      capabilities: CAPABILITIES,
      diagnostics: [],
    };
  }

  async inventory(
    connection: Wso2Connection,
    _ctx: AdapterContext,
  ): Promise<GatewayInventorySnapshot> {
    const origin = connection.origin ?? "wso2-api.yaml";
    const apis = apisOf(connection.config);
    const diagnostics: GatewayDiagnostic[] = [];
    const summaries: GatewayApiSummary[] = apis.map((api, i) => {
      const norm = normalizeApi(api, i, origin);
      diagnostics.push(...norm.diagnostics);
      return {
        id: api.name,
        name: api.name,
        version: api.version ?? "0.0.0",
        lifecycle: api.lifeCycleStatus ?? "CREATED",
        environmentIds: [],
        routes: norm.ops.map((o) => ({
          id: o.operationId,
          methods: [o.method],
          paths: [o.path],
          hosts: [],
          protocols: [],
        })),
        hasSpec: norm.ops.length > 0,
        productIds: [],
        owner: api.provider,
        authSummary: (api.securityScheme ?? []).join(", ") || undefined,
        hasQuota: norm.hasQuota,
      };
    });
    return finalizeInventory({
      schemaVersion: 1,
      gateway: { kind: "wso2", id: connection.id, name: origin },
      environments: [],
      apis: summaries,
      products: [],
      diagnostics,
    });
  }

  async extractApi(
    connection: Wso2Connection,
    api: GatewayApiRef,
    _ctx: AdapterContext,
  ): Promise<GatewayApiImport> {
    const origin = connection.origin ?? "wso2-api.yaml";
    const apis = apisOf(connection.config);
    const apiIndex = apis.findIndex((a) => a.name === api.id);
    const found = apis[apiIndex];
    if (!found) {
      return {
        source: buildGatewayApiImport({
          originKind: "wso2",
          apiName: api.id,
          ops: [],
          facts: [],
          diagnostics: [],
        }).source,
        overlay: buildGatewayApiImport({
          originKind: "wso2",
          apiName: api.id,
          ops: [],
          facts: [],
          diagnostics: [],
        }).overlay,
        diagnostics: [
          { level: "error", code: "wso2/unknown_api", message: `No WSO2 API '${api.id}'.` },
        ],
      };
    }
    const norm = normalizeApi(found, apiIndex, origin);
    return buildGatewayApiImport({
      originKind: "wso2",
      apiName: found.name,
      version: found.version,
      ops: norm.ops,
      facts: norm.facts,
      diagnostics: norm.diagnostics,
    });
  }
}
