/**
 * The IBM API Connect adapter. API Connect groups APIs into products with plans
 * (rate limits), and each API is an OpenAPI doc with an `x-ibm-configuration`
 * assembly (invoke/map/…). Declared OAuth and plan rate limits normalize into the
 * overlay/inventory; `map`/custom assembly actions are classified **opaque**.
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
  GatewayProduct,
} from "../model.js";
import type { GatewayFact } from "../overlay.js";
import { asObjects, asRecord, asStrings, safeParseYaml } from "../parse-safe.js";
import { buildGatewayApiImport, normalizePath, type SynthOp, synthOperationId } from "../synth.js";

interface ApicResource {
  method: string;
  path: string;
  scopes?: string[];
}
interface ApicAssembly {
  execute?: { type: string }[];
}
interface ApicApi {
  name: string;
  version?: string;
  basePath?: string;
  resources?: ApicResource[];
  assembly?: ApicAssembly;
  oauthProviders?: string[];
}
interface ApicPlan {
  name: string;
  rateLimit?: string;
  apis?: string[];
}
interface ApicProduct {
  name: string;
  plans?: ApicPlan[];
}

export interface ApiConnectConnection extends GatewayConnection {
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
  consumers: true,
  trafficAnalytics: false,
  drift: false,
  publish: false,
};

interface ApicExport {
  products?: ApicProduct[];
  apis?: ApicApi[];
}

function parseExport(config: string): ApicExport {
  return asRecord(safeParseYaml(config)) as ApicExport;
}

function opsOf(api: ApicApi): SynthOp[] {
  return asObjects<ApicResource>(api.resources).map((r) => ({
    operationId: synthOperationId(api.name, r.method, r.path),
    method: r.method,
    path: normalizePath(r.path),
  }));
}

/** Product rate-limit + which product this API belongs to. */
function quotaForApi(
  exp: ApicExport,
  apiName: string,
): { hasQuota: boolean; productIds: string[] } {
  const productIds: string[] = [];
  let hasQuota = false;
  for (const product of asObjects<ApicProduct>(exp.products)) {
    for (const plan of asObjects<ApicPlan>(product.plans)) {
      if (asStrings(plan.apis).includes(apiName)) {
        productIds.push(product.name);
        if (plan.rateLimit) hasQuota = true;
      }
    }
  }
  return { hasQuota, productIds: [...new Set(productIds)].sort() };
}

function normalizeApi(exp: ApicExport, api: ApicApi, apiIndex: number, origin: string) {
  const ops = opsOf(api);
  const facts: GatewayFact[] = [];
  const diagnostics: GatewayDiagnostic[] = [];

  asObjects<ApicResource>(api.resources).forEach((r, j) => {
    const scopes = asStrings(r.scopes);
    if (scopes.length > 0) {
      const coordinate: EvidenceCoordinate = {
        origin,
        pointer: `/apis/${apiIndex}/resources/${j}/scopes`,
      };
      facts.push({
        target: { scope: "operation", ref: synthOperationId(api.name, r.method, r.path) },
        predicate: "auth.scopes",
        operation: "restrict",
        value: scopes,
        coordinate,
        note: "API Connect OAuth scopes",
      });
    }
  });

  asObjects<{ type: string }>(api.assembly?.execute).forEach((action, k) => {
    if (action.type === "map" || action.type === "gatewayscript" || action.type === "xslt") {
      diagnostics.push({
        level: "warning",
        code: "gateway/opaque_policy",
        message: `API Connect assembly action '${action.type}' on '${api.name}' transforms the message and is not modelled.`,
        coordinate: { origin, pointer: `/apis/${apiIndex}/assembly/execute/${k}` },
      });
    }
  });

  const { hasQuota, productIds } = quotaForApi(exp, api.name);
  if (hasQuota) {
    diagnostics.push({
      level: "info",
      code: "apiconnect/plan_rate_limit",
      message: `A plan rate limit applies to '${api.name}' but is not an operation semantic.`,
      coordinate: { origin, pointer: `/apis/${apiIndex}` },
    });
  }
  return { ops, facts, diagnostics, hasQuota, productIds };
}

export class ApiConnectGatewayAdapter implements GatewayAdapter<ApiConnectConnection> {
  readonly kind = "api_connect" as const;
  readonly capabilities = CAPABILITIES;

  async probe(connection: ApiConnectConnection, _ctx: AdapterContext): Promise<GatewayProbeResult> {
    return {
      reachable: asObjects(parseExport(connection.config).apis).length > 0,
      capabilities: CAPABILITIES,
      diagnostics: [],
    };
  }

  async inventory(
    connection: ApiConnectConnection,
    _ctx: AdapterContext,
  ): Promise<GatewayInventorySnapshot> {
    const origin = connection.origin ?? "apiconnect.yaml";
    const exp = parseExport(connection.config);
    const diagnostics: GatewayDiagnostic[] = [];
    const summaries: GatewayApiSummary[] = asObjects<ApicApi>(exp.apis).map((api, i) => {
      const norm = normalizeApi(exp, api, i, origin);
      diagnostics.push(...norm.diagnostics);
      return {
        id: api.name,
        name: api.name,
        version: api.version ?? "0.0.0",
        lifecycle: "published",
        environmentIds: [],
        routes: norm.ops.map((o) => ({
          id: o.operationId,
          methods: [o.method],
          paths: [o.path],
          hosts: [],
          protocols: [],
        })),
        hasSpec: norm.ops.length > 0,
        productIds: norm.productIds,
        authSummary: asStrings(api.oauthProviders).length > 0 ? "OAuth2" : undefined,
        hasQuota: norm.hasQuota,
      };
    });
    const products: GatewayProduct[] = asObjects<ApicProduct>(exp.products).map((p) => ({
      id: p.name,
      name: p.name,
      plans: asObjects<ApicPlan>(p.plans).map((plan) => plan.name),
    }));
    return finalizeInventory({
      schemaVersion: 1,
      gateway: { kind: "api_connect", id: connection.id, name: origin },
      environments: [],
      apis: summaries,
      products,
      diagnostics,
    });
  }

  async extractApi(
    connection: ApiConnectConnection,
    api: GatewayApiRef,
    _ctx: AdapterContext,
  ): Promise<GatewayApiImport> {
    const origin = connection.origin ?? "apiconnect.yaml";
    const exp = parseExport(connection.config);
    const apis = asObjects<ApicApi>(exp.apis);
    const apiIndex = apis.findIndex((a) => a.name === api.id);
    const found = apis[apiIndex];
    if (!found) {
      const empty = buildGatewayApiImport({
        originKind: "api_connect",
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
            code: "apiconnect/unknown_api",
            message: `No API Connect API '${api.id}'.`,
          },
        ],
      };
    }
    const norm = normalizeApi(exp, found, apiIndex, origin);
    return buildGatewayApiImport({
      originKind: "api_connect",
      apiName: found.name,
      version: found.version,
      ops: norm.ops,
      facts: norm.facts,
      diagnostics: norm.diagnostics,
    });
  }
}
