/**
 * The Apigee adapter. Apigee organizes API proxies (with revisions and
 * environments), API products (scopes + quota), and policies (OAuthV2, Quota,
 * SpikeArrest, AssignMessage/JavaScript, …). Product scopes and quota normalize
 * into the overlay/inventory; message-mutating policies are classified **opaque**.
 */
import type { AdapterContext, GatewayAdapter, GatewayConnection } from "../adapter.js";
import {
  type ExplicitGatewayIdentityConfiguration,
  projectConfiguredAuthType,
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

interface ApigeeFlow {
  name?: string;
  method: string;
  path: string;
  /** Exact operation identity fields in Anvil's normalized Apigee document. */
  identity?: ExplicitGatewayIdentityConfiguration;
}
interface ApigeePolicy {
  type: string;
  name?: string;
  /** Exact policy configuration; never inferred from the policy name/type. */
  identity?: ExplicitGatewayIdentityConfiguration;
}
interface ApigeeProxy {
  name: string;
  basePath?: string;
  revision?: string;
  environments?: string[];
  flows?: ApigeeFlow[];
  policies?: ApigeePolicy[];
  /** Exact proxy-wide identity fields in Anvil's normalized Apigee document. */
  identity?: ExplicitGatewayIdentityConfiguration;
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
const AUTH_POLICIES = new Set([
  "OAuthV2",
  "VerifyAPIKey",
  "VerifyJWT",
  "SAMLAssertion",
  "AccessControl",
]);

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

function parseExport(
  config: string,
  origin: string,
): { exp: ApigeeExport; diagnostics: GatewayDiagnostic[] } {
  const parsed = parseGatewayDocument(config, "apigee", origin);
  if (!parsed.document) return { exp: {}, diagnostics: parsed.diagnostics };
  const proxies = parsed.document.proxies;
  if (!Array.isArray(proxies)) {
    return {
      exp: {},
      diagnostics: [
        {
          level: "error",
          code: "apigee/invalid_export",
          message: "The Apigee export must contain a `proxies` array.",
          coordinate: { origin },
        },
      ],
    };
  }
  if (proxies.length === 0) {
    return {
      exp: {},
      diagnostics: [
        {
          level: "error",
          code: "apigee/empty_export",
          message: "The Apigee export contains no API proxies.",
          coordinate: { origin, pointer: "/proxies" },
        },
      ],
    };
  }
  if (
    asObjects<ApigeeProxy>(proxies).length !== proxies.length ||
    asObjects<ApigeeProxy>(proxies).some(
      (proxy) => typeof proxy.name !== "string" || proxy.name.length === 0,
    )
  ) {
    return {
      exp: {},
      diagnostics: [
        {
          level: "error",
          code: "apigee/invalid_export",
          message: "Every Apigee proxy must be an object with a non-empty `name`.",
          coordinate: { origin, pointer: "/proxies" },
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
          code: "apigee/invalid_export",
          message: "Apigee `products`, when present, must be an array.",
          coordinate: { origin, pointer: "/products" },
        },
      ],
    };
  }
  return { exp: parsed.document as ApigeeExport, diagnostics: [] };
}

function opsOf(proxy: ApigeeProxy): SynthOp[] {
  return asObjects<ApigeeFlow>(proxy.flows).map((f) => {
    const path = joinGatewayPath(proxy.basePath, f.path);
    return {
      operationId: synthOperationId(proxy.name, f.method, path),
      method: f.method,
      path,
    };
  });
}

/** The product(s) fronting a proxy provide its scopes + quota. */
function productFor(
  exp: ApigeeExport,
  proxyName: string,
): { scopes: string[]; hasQuota: boolean; productIds: string[] } {
  const scopes = new Set<string>();
  const productIds: string[] = [];
  let hasQuota = false;
  for (const product of asObjects<ApigeeProduct>(exp.products)) {
    if (asStrings(product.proxies).includes(proxyName)) {
      productIds.push(product.name);
      for (const s of asStrings(product.scopes)) scopes.add(s);
      if (product.quota) hasQuota = true;
    }
  }
  return { scopes: [...scopes].sort(), hasQuota, productIds: [...new Set(productIds)].sort() };
}

function normalizeProxy(exp: ApigeeExport, proxy: ApigeeProxy, proxyIndex: number, origin: string) {
  const ops = opsOf(proxy);
  const facts: GatewayFact[] = [];
  const diagnostics: GatewayDiagnostic[] = [];
  const identityEvidence: GatewayIdentityEvidence[] = [];
  let authConfigured = false;
  const operationIdentityRefs = ops.map((op) => gatewayOperationRef(op.method, op.path));
  const environments = asStrings(proxy.environments);
  const apiSubject = {
    api: {
      id: proxy.name,
      ...(proxy.revision ? { revision: proxy.revision } : {}),
      ...(environments.length === 1 ? { environment: environments[0] } : {}),
    },
  };

  const proxyIdentity = projectExplicitIdentityConfiguration({
    configuration: proxy.identity,
    coordinate: { origin, pointer: `/proxies/${proxyIndex}/identity` },
    operationRefs: operationIdentityRefs,
  });
  identityEvidence.push(...proxyIdentity.evidence);
  diagnostics.push(...withGatewayDiagnosticSubject(proxyIdentity.diagnostics, apiSubject));

  asObjects<ApigeeFlow>(proxy.flows).forEach((flow, flowIndex) => {
    const operationIdentityRef = gatewayOperationRef(
      flow.method,
      joinGatewayPath(proxy.basePath, flow.path),
    );
    const flowIdentity = projectExplicitIdentityConfiguration({
      configuration: flow.identity,
      coordinate: {
        origin,
        pointer: `/proxies/${proxyIndex}/flows/${flowIndex}/identity`,
      },
      operationRefs: [operationIdentityRef],
    });
    identityEvidence.push(...flowIdentity.evidence);
    diagnostics.push(
      ...withGatewayDiagnosticSubject(flowIdentity.diagnostics, {
        ...apiSubject,
        route: {
          ...(flow.name ? { id: flow.name } : {}),
          method: flow.method,
          path: joinGatewayPath(proxy.basePath, flow.path),
          operationRef: operationIdentityRef,
        },
      }),
    );
  });

  const { scopes, hasQuota, productIds } = productFor(exp, proxy.name);
  if (scopes.length > 0) {
    for (const op of ops) {
      const productIndex = asObjects<ApigeeProduct>(exp.products).findIndex((p) =>
        asStrings(p.proxies).includes(proxy.name),
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
  asObjects<ApigeeProduct>(exp.products).forEach((product, productIndex) => {
    if (!asStrings(product.proxies).includes(proxy.name) || product.scopes === undefined) return;
    const productIdentity = projectExplicitIdentityConfiguration({
      configuration: { scopes: product.scopes },
      coordinate: { origin, pointer: `/products/${productIndex}` },
      operationRefs: operationIdentityRefs,
      fields: ["scopes"],
    });
    identityEvidence.push(...productIdentity.evidence);
    diagnostics.push(...withGatewayDiagnosticSubject(productIdentity.diagnostics, apiSubject));
  });

  asObjects<ApigeePolicy>(proxy.policies).forEach((policy, k) => {
    const coordinate: EvidenceCoordinate = {
      origin,
      pointer: `/proxies/${proxyIndex}/policies/${k}`,
    };
    if (AUTH_POLICIES.has(policy.type)) {
      authConfigured = true;
      const type =
        policy.type === "VerifyAPIKey"
          ? "api_key"
          : policy.type === "VerifyJWT"
            ? "jwt_bearer"
            : undefined;
      if (type) {
        identityEvidence.push(
          ...projectConfiguredAuthType({
            type,
            coordinate: { origin, pointer: `${coordinate.pointer}/type` },
            operationRefs: operationIdentityRefs,
          }),
        );
      }
      const policyIdentity = projectExplicitIdentityConfiguration({
        configuration: policy.identity,
        coordinate: { origin, pointer: `${coordinate.pointer}/identity` },
        operationRefs: operationIdentityRefs,
      });
      identityEvidence.push(...policyIdentity.evidence);
      diagnostics.push(...withGatewayDiagnosticSubject(policyIdentity.diagnostics, apiSubject));
    } else if (TRANSFORM_POLICIES.has(policy.type)) {
      diagnostics.push({
        level: "warning",
        code: "gateway/opaque_policy",
        message: `Apigee policy '${policy.type}' on '${proxy.name}' mutates the message and is not modelled.`,
        coordinate,
        subject: apiSubject,
      });
    } else if (policy.type === "Quota" || policy.type === "SpikeArrest") {
      diagnostics.push({
        level: "info",
        code: "apigee/traffic_policy",
        message: `Apigee traffic policy '${policy.type}' on '${proxy.name}' applies but is not an operation semantic.`,
        coordinate,
        subject: apiSubject,
      });
    } else {
      diagnostics.push({
        level: "warning",
        code: "gateway/opaque_policy",
        message: `Apigee policy '${String(policy.type ?? "(unnamed)")}' on '${proxy.name}' is not modelled and may change effective request behavior.`,
        coordinate,
        subject: apiSubject,
      });
    }
  });

  return {
    ops,
    facts,
    diagnostics,
    identityEvidence,
    hasQuota,
    productIds,
    authConfigured,
  };
}

export class ApigeeGatewayAdapter implements GatewayAdapter<ApigeeConnection> {
  readonly kind = "apigee" as const;
  readonly capabilities = CAPABILITIES;

  async probe(connection: ApigeeConnection, _ctx: AdapterContext): Promise<GatewayProbeResult> {
    const origin = connection.origin ?? "apigee.yaml";
    const parsed = parseExport(connection.config, origin);
    return {
      reachable: parsed.diagnostics.every((d) => d.level !== "error"),
      capabilities: CAPABILITIES,
      diagnostics: parsed.diagnostics,
    };
  }

  async inventory(
    connection: ApigeeConnection,
    _ctx: AdapterContext,
  ): Promise<GatewayInventorySnapshot> {
    const origin = connection.origin ?? "apigee.yaml";
    const parsed = parseExport(connection.config, origin);
    const exp = parsed.exp;
    const diagnostics: GatewayDiagnostic[] = [...parsed.diagnostics];
    const environments = new Set<string>();
    const summaries: GatewayApiSummary[] = asObjects<ApigeeProxy>(exp.proxies).map((proxy, i) => {
      const norm = normalizeProxy(exp, proxy, i, origin);
      diagnostics.push(...norm.diagnostics);
      for (const e of asStrings(proxy.environments)) environments.add(e);
      return {
        id: proxy.name,
        name: proxy.name,
        version: proxy.revision ?? "1",
        lifecycle: "deployed",
        environmentIds: asStrings(proxy.environments),
        routes: norm.ops.map((o) => ({
          id: o.operationId,
          methods: [o.method],
          paths: [o.path],
          hosts: [],
          protocols: [],
        })),
        hasSpec: false,
        contract: routeOnlyContract({ origin, pointer: `/proxies/${i}` }),
        productIds: norm.productIds,
        authSummary:
          norm.authConfigured || norm.facts.length > 0
            ? "Gateway authentication policy (details require supplied contract)"
            : undefined,
        ...(norm.identityEvidence.length > 0 ? { identityEvidence: norm.identityEvidence } : {}),
        hasQuota: norm.hasQuota,
      };
    });
    const products: GatewayProduct[] = asObjects<ApigeeProduct>(exp.products).map((p) => ({
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
    const parsed = parseExport(connection.config, origin);
    const exp = parsed.exp;
    const proxies = asObjects<ApigeeProxy>(exp.proxies);
    const proxyIndex = proxies.findIndex(
      (proxy) =>
        proxy.name === api.id &&
        (!api.version || !proxy.revision || proxy.revision === api.version) &&
        (!api.environmentId ||
          asStrings(proxy.environments).length === 0 ||
          asStrings(proxy.environments).includes(api.environmentId)),
    );
    const proxy = proxies[proxyIndex];
    if (!proxy) {
      const empty = buildGatewayApiImport({
        originKind: "apigee",
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
            code: "apigee/unknown_proxy",
            message: `No Apigee proxy '${api.id}'.`,
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
    const norm = normalizeProxy(exp, proxy, proxyIndex, origin);
    return {
      ...buildGatewayApiImport({
        originKind: "apigee",
        apiName: proxy.name,
        version: proxy.revision,
        sourceCoordinate: { origin, pointer: `/proxies/${proxyIndex}` },
        ops: norm.ops,
        facts: norm.facts,
        authConfigured:
          norm.authConfigured || norm.facts.some((fact) => fact.predicate.startsWith("auth.")),
        diagnostics: norm.diagnostics,
      }),
      ...(norm.identityEvidence.length > 0 ? { identityEvidence: norm.identityEvidence } : {}),
    };
  }
}
