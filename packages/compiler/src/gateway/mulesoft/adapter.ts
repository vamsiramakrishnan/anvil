/**
 * The MuleSoft (API Manager / Exchange) adapter. MuleSoft fronts an asset's API
 * with policies (client-id enforcement, OAuth/JWT, SLA rate limits) and mediation
 * (DataWeave/flows). Declared policies normalize into the overlay; DataWeave and
 * arbitrary flow logic are classified **opaque** — Anvil does not claim to
 * understand them.
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
} from "../model.js";
import { withGatewayDiagnosticSubject } from "../model.js";
import type { GatewayFact } from "../overlay.js";
import { asObjects, asStrings, parseGatewayDocument } from "../parse-safe.js";
import {
  buildGatewayApiImport,
  gatewayOperationRef,
  normalizePath,
  routeOnlyContract,
  type SynthOp,
  synthOperationId,
} from "../synth.js";

interface MuleResource {
  method: string;
  path: string;
  scopes?: string[];
  identity?: ExplicitGatewayIdentityConfiguration;
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
  identity?: ExplicitGatewayIdentityConfiguration;
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
  products: false,
  consumers: false,
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
  const identityEvidence: GatewayIdentityEvidence[] = [];
  let hasQuota = false;
  let authSummary: string | undefined;
  const operationIdentityRefs = ops.map((op) => gatewayOperationRef(op.method, op.path));
  const apiSubject = {
    api: {
      id: api.assetId,
      ...(api.productVersion ? { revision: api.productVersion } : {}),
      ...(api.instanceLabel ? { environment: api.instanceLabel } : {}),
    },
  };

  const apiIdentity = projectExplicitIdentityConfiguration({
    configuration: api.identity,
    coordinate: { origin, pointer: `/apis/${apiIndex}/identity` },
    operationRefs: operationIdentityRefs,
  });
  identityEvidence.push(...apiIdentity.evidence);
  diagnostics.push(...withGatewayDiagnosticSubject(apiIdentity.diagnostics, apiSubject));

  asObjects<MuleResource>(api.resources).forEach((r, j) => {
    const operationRef = synthOperationId(api.assetId, r.method, r.path);
    const operationIdentityRef = gatewayOperationRef(r.method, r.path);
    const scopes = asStrings(r.scopes);
    if (scopes.length > 0) {
      const coordinate: EvidenceCoordinate = {
        origin,
        pointer: `/apis/${apiIndex}/resources/${j}/scopes`,
      };
      facts.push({
        target: { scope: "operation", ref: operationRef },
        predicate: "auth.scopes",
        operation: "restrict",
        value: scopes,
        coordinate,
        note: "MuleSoft resource scopes",
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
          path: normalizePath(r.path),
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
          path: normalizePath(r.path),
          operationRef: operationIdentityRef,
        },
      }),
    );
  });

  asObjects<MulePolicy>(api.policies).forEach((p, k) => {
    const coordinate: EvidenceCoordinate = { origin, pointer: `/apis/${apiIndex}/policies/${k}` };
    if (AUTH_POLICIES.has(p.policyId)) {
      authSummary = p.policyId;
      const type =
        p.policyId === "client-id-enforcement"
          ? "api_key"
          : p.policyId === "jwt-validation"
            ? "jwt_bearer"
            : undefined;
      if (type) {
        identityEvidence.push(
          ...projectConfiguredAuthType({
            type,
            coordinate: { origin, pointer: `${coordinate.pointer}/policyId` },
            operationRefs: operationIdentityRefs,
          }),
        );
      }
      const policyIdentity = projectExplicitIdentityConfiguration({
        configuration: p.config,
        coordinate: { origin, pointer: `${coordinate.pointer}/config` },
        operationRefs: operationIdentityRefs,
      });
      identityEvidence.push(...policyIdentity.evidence);
      diagnostics.push(...withGatewayDiagnosticSubject(policyIdentity.diagnostics, apiSubject));
    } else if (RATE_POLICIES.has(p.policyId)) {
      hasQuota = true;
      diagnostics.push({
        level: "info",
        code: "mulesoft/sla_present",
        message: `SLA/rate policy '${p.policyId}' on '${api.assetId}' applies but is not an operation semantic.`,
        coordinate,
        subject: apiSubject,
      });
    } else {
      // DataWeave / custom flow logic — classified opaque, not interpreted.
      diagnostics.push({
        level: "warning",
        code: "gateway/opaque_policy",
        message: `MuleSoft policy '${p.policyId}' on '${api.assetId}' is opaque (flow/DataWeave logic is not deterministically understood).`,
        coordinate,
        subject: apiSubject,
      });
    }
  });

  return { ops, facts, diagnostics, identityEvidence, hasQuota, authSummary };
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
        ...(norm.identityEvidence.length > 0 ? { identityEvidence: norm.identityEvidence } : {}),
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
    const apiIndex = parsed.apis.findIndex(
      (candidate) =>
        candidate.assetId === api.id &&
        (!api.version || !candidate.productVersion || candidate.productVersion === api.version) &&
        (!api.environmentId ||
          !candidate.instanceLabel ||
          candidate.instanceLabel === api.environmentId),
    );
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
    const norm = normalizeApi(found, apiIndex, origin);
    return {
      ...buildGatewayApiImport({
        originKind: "mulesoft",
        apiName: found.assetId,
        version: found.productVersion,
        sourceCoordinate: { origin, pointer: `/apis/${apiIndex}` },
        ops: norm.ops,
        facts: norm.facts,
        authConfigured: Boolean(norm.authSummary),
        diagnostics: norm.diagnostics,
      }),
      ...(norm.identityEvidence.length > 0 ? { identityEvidence: norm.identityEvidence } : {}),
    };
  }
}
