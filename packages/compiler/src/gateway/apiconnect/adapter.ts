/**
 * The IBM API Connect adapter. API Connect groups APIs into products with plans
 * (rate limits), and each API is an OpenAPI doc with an `x-ibm-configuration`
 * assembly (invoke/map/…). Declared OAuth and plan rate limits normalize into the
 * overlay/inventory; `map`/custom assembly actions are classified **opaque**.
 */
import type { AdapterContext, GatewayAdapter, GatewayConnection } from "../adapter.js";
import {
  type ExplicitGatewayIdentityConfiguration,
  projectExplicitIdentityConfiguration,
} from "../identity-evidence.js";
import { finalizeInventory } from "../inventory.js";
import type {
  EvidenceCoordinate,
  GatewayAdapterCapabilities,
  GatewayApiImport,
  GatewayApiRef,
  GatewayApiSummary,
  GatewayDiagnostic,
  GatewayIdentityEvidence,
  GatewayInventorySnapshot,
  GatewayProbeResult,
  GatewayProduct,
} from "../model.js";
import { withGatewayDiagnosticSubject } from "../model.js";
import type { GatewayFact } from "../overlay.js";
import { asObjects, asStrings, parseGatewayDocument } from "../parse-safe.js";
import {
  buildGatewayApiImport,
  gatewayOperationRef,
  joinGatewayPath,
  routeOnlyContract,
  type SynthOp,
  synthOperationId,
} from "../synth.js";

interface ApicResource {
  method: string;
  path: string;
  scopes?: string[];
  identity?: ExplicitGatewayIdentityConfiguration;
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
  identity?: ExplicitGatewayIdentityConfiguration;
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
  apiSpecs: false,
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

interface ApicExport {
  products?: ApicProduct[];
  apis?: ApicApi[];
}

function parseExport(
  config: string,
  origin: string,
): { exp: ApicExport; diagnostics: GatewayDiagnostic[] } {
  const parsed = parseGatewayDocument(config, "apiconnect", origin);
  if (!parsed.document) return { exp: {}, diagnostics: parsed.diagnostics };
  if (!Array.isArray(parsed.document.apis)) {
    return {
      exp: {},
      diagnostics: [
        {
          level: "error",
          code: "apiconnect/invalid_export",
          message: "The API Connect export must contain an `apis` array.",
          coordinate: { origin },
        },
      ],
    };
  }
  if (parsed.document.apis.length === 0) {
    return {
      exp: {},
      diagnostics: [
        {
          level: "error",
          code: "apiconnect/empty_export",
          message: "The API Connect export contains no APIs.",
          coordinate: { origin, pointer: "/apis" },
        },
      ],
    };
  }
  const apis = asObjects<ApicApi>(parsed.document.apis);
  if (
    apis.length !== parsed.document.apis.length ||
    apis.some((api) => typeof api.name !== "string" || api.name.length === 0)
  ) {
    return {
      exp: {},
      diagnostics: [
        {
          level: "error",
          code: "apiconnect/invalid_export",
          message: "Every API Connect API must be an object with a non-empty `name`.",
          coordinate: { origin, pointer: "/apis" },
        },
      ],
    };
  }
  if (parsed.document.products !== undefined && !Array.isArray(parsed.document.products)) {
    return {
      exp: {},
      diagnostics: [
        {
          level: "error",
          code: "apiconnect/invalid_export",
          message: "API Connect `products`, when present, must be an array.",
          coordinate: { origin, pointer: "/products" },
        },
      ],
    };
  }
  return { exp: parsed.document as ApicExport, diagnostics: [] };
}

function opsOf(api: ApicApi): SynthOp[] {
  return asObjects<ApicResource>(api.resources).map((r) => {
    const path = joinGatewayPath(api.basePath, r.path);
    return {
      operationId: synthOperationId(api.name, r.method, path),
      method: r.method,
      path,
    };
  });
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
  const identityEvidence: GatewayIdentityEvidence[] = [];
  const operationIdentityRefs = ops.map((op) => gatewayOperationRef(op.method, op.path));
  const apiSubject = {
    api: {
      id: api.name,
      ...(api.version ? { revision: api.version } : {}),
    },
  };

  const apiIdentity = projectExplicitIdentityConfiguration({
    configuration: api.identity,
    coordinate: { origin, pointer: `/apis/${apiIndex}/identity` },
    operationRefs: operationIdentityRefs,
  });
  identityEvidence.push(...apiIdentity.evidence);
  diagnostics.push(...withGatewayDiagnosticSubject(apiIdentity.diagnostics, apiSubject));

  asObjects<ApicResource>(api.resources).forEach((r, j) => {
    const operationRef = synthOperationId(
      api.name,
      r.method,
      joinGatewayPath(api.basePath, r.path),
    );
    const operationIdentityRef = gatewayOperationRef(
      r.method,
      joinGatewayPath(api.basePath, r.path),
    );
    const scopes = asStrings(r.scopes);
    if (scopes.length > 0) {
      const coordinate: EvidenceCoordinate = {
        origin,
        pointer: `/apis/${apiIndex}/resources/${j}/scopes`,
      };
      facts.push({
        target: {
          scope: "operation",
          ref: operationRef,
        },
        predicate: "auth.scopes",
        operation: "restrict",
        value: scopes,
        coordinate,
        note: "API Connect OAuth scopes",
      });
    }
    const resourceScopes = projectExplicitIdentityConfiguration({
      configuration: { ...(r.scopes === undefined ? {} : { scopes: r.scopes }) },
      coordinate: { origin, pointer: `/apis/${apiIndex}/resources/${j}` },
      operationRefs: [operationIdentityRef],
      fields: ["scopes"],
    });
    identityEvidence.push(...resourceScopes.evidence);
    diagnostics.push(
      ...withGatewayDiagnosticSubject(resourceScopes.diagnostics, {
        ...apiSubject,
        route: {
          method: r.method,
          path: joinGatewayPath(api.basePath, r.path),
          operationRef: operationIdentityRef,
        },
      }),
    );
    const resourceIdentity = projectExplicitIdentityConfiguration({
      configuration: r.identity,
      coordinate: { origin, pointer: `/apis/${apiIndex}/resources/${j}/identity` },
      operationRefs: [operationIdentityRef],
    });
    identityEvidence.push(...resourceIdentity.evidence);
    diagnostics.push(
      ...withGatewayDiagnosticSubject(resourceIdentity.diagnostics, {
        ...apiSubject,
        route: {
          method: r.method,
          path: joinGatewayPath(api.basePath, r.path),
          operationRef: operationIdentityRef,
        },
      }),
    );
  });

  asObjects<{ type: string }>(api.assembly?.execute).forEach((action, k) => {
    if (action.type !== "invoke") {
      diagnostics.push({
        level: "warning",
        code: "gateway/opaque_policy",
        message: `API Connect assembly action '${String(action.type ?? "(unnamed)")}' on '${api.name}' is not modelled and may transform, authorize, reject, or reroute the request.`,
        coordinate: { origin, pointer: `/apis/${apiIndex}/assembly/execute/${k}` },
        subject: apiSubject,
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
      subject: apiSubject,
    });
  }
  return { ops, facts, diagnostics, identityEvidence, hasQuota, productIds };
}

export class ApiConnectGatewayAdapter implements GatewayAdapter<ApiConnectConnection> {
  readonly kind = "api_connect" as const;
  readonly capabilities = CAPABILITIES;

  async probe(connection: ApiConnectConnection, _ctx: AdapterContext): Promise<GatewayProbeResult> {
    const origin = connection.origin ?? "apiconnect.yaml";
    const parsed = parseExport(connection.config, origin);
    return {
      reachable: parsed.diagnostics.every((d) => d.level !== "error"),
      capabilities: CAPABILITIES,
      diagnostics: parsed.diagnostics,
    };
  }

  async inventory(
    connection: ApiConnectConnection,
    _ctx: AdapterContext,
  ): Promise<GatewayInventorySnapshot> {
    const origin = connection.origin ?? "apiconnect.yaml";
    const parsed = parseExport(connection.config, origin);
    const exp = parsed.exp;
    const diagnostics: GatewayDiagnostic[] = [...parsed.diagnostics];
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
        hasSpec: false,
        contract: routeOnlyContract({ origin, pointer: `/apis/${i}` }),
        productIds: norm.productIds,
        authSummary: asStrings(api.oauthProviders).length > 0 ? "OAuth2" : undefined,
        ...(norm.identityEvidence.length > 0 ? { identityEvidence: norm.identityEvidence } : {}),
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
    const parsed = parseExport(connection.config, origin);
    const exp = parsed.exp;
    const apis = asObjects<ApicApi>(exp.apis);
    const apiIndex = apis.findIndex(
      (candidate) =>
        candidate.name === api.id &&
        (!api.version || !candidate.version || candidate.version === api.version),
    );
    const found = apis[apiIndex];
    if (!found) {
      const empty = buildGatewayApiImport({
        originKind: "api_connect",
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
            code: "apiconnect/unknown_api",
            message: `No API Connect API '${api.id}'.`,
            subject: {
              api: {
                id: api.id,
                ...(api.version ? { revision: api.version } : {}),
                ...(api.environmentId ? { environment: api.environmentId } : {}),
              },
            },
          },
        ],
      };
    }
    const norm = normalizeApi(exp, found, apiIndex, origin);
    return {
      ...buildGatewayApiImport({
        originKind: "api_connect",
        apiName: found.name,
        version: found.version,
        sourceCoordinate: { origin, pointer: `/apis/${apiIndex}` },
        ops: norm.ops,
        facts: norm.facts,
        authConfigured: asStrings(found.oauthProviders).length > 0,
        diagnostics: norm.diagnostics,
      }),
      ...(norm.identityEvidence.length > 0 ? { identityEvidence: norm.identityEvidence } : {}),
    };
  }
}
