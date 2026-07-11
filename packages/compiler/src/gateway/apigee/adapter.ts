/**
 * The Apigee adapter. Apigee organizes API proxies (with revisions and
 * environments), API products (scopes + quota), and policies (OAuthV2, Quota,
 * SpikeArrest, AssignMessage/JavaScript, …). Product scopes and quota normalize
 * into the overlay/inventory; message-mutating policies are classified **opaque**.
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
  GatewayProduct,
} from "../model.js";
import type { GatewayFact } from "../overlay.js";
import { buildGatewayApiImport, normalizePath, type SynthOp, synthOperationId } from "../synth.js";

interface ApigeeFlow {
  name?: string;
  method: string;
  path: string;
}
interface ApigeePolicy {
  type: string;
  name?: string;
}
interface ApigeeProxy {
  name: string;
  basePath?: string;
  revision?: string;
  environments?: string[];
  flows?: ApigeeFlow[];
  policies?: ApigeePolicy[];
}
interface ApigeeProduct {
  name: string;
  scopes?: string[];
  quota?: string;
  proxies?: string[];
}
interface ApigeeExport {
  proxies?: ApigeeProxy[];
  products?: ApigeeProduct[];
}

export interface ApigeeConnection extends GatewayConnection {
  config: string;
  origin?: string;
}

const TRANSFORM_POLICIES = new Set([
  "AssignMessage",
  "JavaScript",
  "XSL",
  "JSONToXML",
  "XMLToJSON",
]);

const CAPABILITIES: GatewayAdapterCapabilities = {
  inventory: true,
  apiSpecs: true,
  routes: true,
  authentication: true,
  authorization: true,
  trafficPolicies: true,
  transformations: "partial",
  faultPolicies: true,
  products: true,
  consumers: true,
  trafficAnalytics: false,
  drift: false,
  publish: false,
};

function parseExport(config: string): ApigeeExport {
  const doc = parseYaml(config) as ApigeeExport | null;
  return doc && typeof doc === "object" ? doc : {};
}

function opsOf(proxy: ApigeeProxy): SynthOp[] {
  return (proxy.flows ?? []).map((f) => ({
    operationId: synthOperationId(proxy.name, f.method, f.path),
    method: f.method,
    path: normalizePath(f.path),
  }));
}

/** The product(s) fronting a proxy provide its scopes + quota. */
function productFor(
  exp: ApigeeExport,
  proxyName: string,
): { scopes: string[]; hasQuota: boolean; productIds: string[] } {
  const scopes = new Set<string>();
  const productIds: string[] = [];
  let hasQuota = false;
  for (const product of exp.products ?? []) {
    if ((product.proxies ?? []).includes(proxyName)) {
      productIds.push(product.name);
      for (const s of product.scopes ?? []) scopes.add(s);
      if (product.quota) hasQuota = true;
    }
  }
  return { scopes: [...scopes].sort(), hasQuota, productIds: [...new Set(productIds)].sort() };
}

function normalizeProxy(exp: ApigeeExport, proxy: ApigeeProxy, proxyIndex: number, origin: string) {
  const ops = opsOf(proxy);
  const facts: GatewayFact[] = [];
  const diagnostics: GatewayDiagnostic[] = [];

  const { scopes, hasQuota, productIds } = productFor(exp, proxy.name);
  if (scopes.length > 0) {
    for (const op of ops) {
      const productIndex = (exp.products ?? []).findIndex((p) =>
        (p.proxies ?? []).includes(proxy.name),
      );
      const coordinate: EvidenceCoordinate = {
        origin,
        pointer: `/products/${productIndex}/scopes`,
      };
      facts.push({
        target: { scope: "operation", ref: op.operationId },
        predicate: "auth.scopes",
        operation: "restrict",
        value: scopes,
        coordinate,
        note: "Apigee product scopes",
      });
    }
  }

  (proxy.policies ?? []).forEach((policy, k) => {
    const coordinate: EvidenceCoordinate = {
      origin,
      pointer: `/proxies/${proxyIndex}/policies/${k}`,
    };
    if (TRANSFORM_POLICIES.has(policy.type)) {
      diagnostics.push({
        level: "warning",
        code: "gateway/opaque_policy",
        message: `Apigee policy '${policy.type}' on '${proxy.name}' mutates the message and is not modelled.`,
        coordinate,
      });
    } else if (policy.type === "Quota" || policy.type === "SpikeArrest") {
      diagnostics.push({
        level: "info",
        code: "apigee/traffic_policy",
        message: `Apigee traffic policy '${policy.type}' on '${proxy.name}' applies but is not an operation semantic.`,
        coordinate,
      });
    }
  });

  return { ops, facts, diagnostics, hasQuota, productIds };
}

export class ApigeeGatewayAdapter implements GatewayAdapter<ApigeeConnection> {
  readonly kind = "apigee" as const;
  readonly capabilities = CAPABILITIES;

  async probe(connection: ApigeeConnection, _ctx: AdapterContext): Promise<GatewayProbeResult> {
    return {
      reachable: (parseExport(connection.config).proxies ?? []).length > 0,
      capabilities: CAPABILITIES,
      diagnostics: [],
    };
  }

  async inventory(
    connection: ApigeeConnection,
    _ctx: AdapterContext,
  ): Promise<GatewayInventorySnapshot> {
    const origin = connection.origin ?? "apigee.yaml";
    const exp = parseExport(connection.config);
    const diagnostics: GatewayDiagnostic[] = [];
    const environments = new Set<string>();
    const summaries: GatewayApiSummary[] = (exp.proxies ?? []).map((proxy, i) => {
      const norm = normalizeProxy(exp, proxy, i, origin);
      diagnostics.push(...norm.diagnostics);
      for (const e of proxy.environments ?? []) environments.add(e);
      return {
        id: proxy.name,
        name: proxy.name,
        version: proxy.revision ?? "1",
        lifecycle: "deployed",
        environmentIds: proxy.environments ?? [],
        routes: norm.ops.map((o) => ({
          id: o.operationId,
          methods: [o.method],
          paths: [o.path],
          hosts: [],
          protocols: [],
        })),
        hasSpec: norm.ops.length > 0,
        productIds: norm.productIds,
        authSummary: norm.facts.length > 0 ? "OAuth2 (product scopes)" : undefined,
        hasQuota: norm.hasQuota,
      };
    });
    const products: GatewayProduct[] = (exp.products ?? []).map((p) => ({
      id: p.name,
      name: p.name,
      plans: [],
    }));
    return finalizeInventory({
      schemaVersion: 1,
      gateway: { kind: "apigee", id: connection.id, name: origin },
      environments: [...environments].sort().map((id) => ({ id })),
      apis: summaries,
      products,
      diagnostics,
    });
  }

  async extractApi(
    connection: ApigeeConnection,
    api: GatewayApiRef,
    _ctx: AdapterContext,
  ): Promise<GatewayApiImport> {
    const origin = connection.origin ?? "apigee.yaml";
    const exp = parseExport(connection.config);
    const proxyIndex = (exp.proxies ?? []).findIndex((p) => p.name === api.id);
    const proxy = (exp.proxies ?? [])[proxyIndex];
    if (!proxy) {
      const empty = buildGatewayApiImport({
        originKind: "apigee",
        apiName: api.id,
        ops: [],
        facts: [],
        diagnostics: [],
      });
      return {
        ...empty,
        diagnostics: [
          { level: "error", code: "apigee/unknown_proxy", message: `No Apigee proxy '${api.id}'.` },
        ],
      };
    }
    const norm = normalizeProxy(exp, proxy, proxyIndex, origin);
    return buildGatewayApiImport({
      originKind: "apigee",
      apiName: proxy.name,
      version: proxy.revision,
      ops: norm.ops,
      facts: norm.facts,
      diagnostics: norm.diagnostics,
    });
  }
}
