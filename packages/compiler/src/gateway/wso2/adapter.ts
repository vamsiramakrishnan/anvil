/**
 * The WSO2 API Manager adapter. WSO2 exports an API definition (api.yaml) with
 * per-operation verbs, scopes, and security scheme, plus throttling tiers. The
 * adapter normalizes those into the common source + overlay; no WSO2 type escapes.
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
  joinGatewayPath,
  routeOnlyContract,
  type SynthOp,
  synthOperationId,
} from "../synth.js";

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

interface LocatedWsoApi {
  api: WsoApi;
  pointer?: string;
}

function parseExport(
  config: string,
  origin: string,
): { apis: LocatedWsoApi[]; diagnostics: GatewayDiagnostic[] } {
  const parsed = parseGatewayDocument(config, "wso2", origin);
  if (!parsed.document) return { apis: [], diagnostics: parsed.diagnostics };
  let apis: LocatedWsoApi[] = [];
  if (Array.isArray(parsed.document.apis)) {
    apis = asObjects<WsoApi>(parsed.document.apis).map((api, i) => ({
      api,
      pointer: `/apis/${i}`,
    }));
    if (parsed.document.apis.length === 0) {
      return {
        apis: [],
        diagnostics: [
          {
            level: "error",
            code: "wso2/empty_export",
            message: "The WSO2 export contains no APIs.",
            coordinate: { origin, pointer: "/apis" },
          },
        ],
      };
    }
  } else if (
    parsed.document.data !== null &&
    typeof parsed.document.data === "object" &&
    !Array.isArray(parsed.document.data)
  ) {
    apis = [{ api: parsed.document.data as WsoApi, pointer: "/data" }];
  } else if (typeof parsed.document.name === "string") {
    apis = [{ api: parsed.document as unknown as WsoApi }];
  } else {
    return {
      apis: [],
      diagnostics: [
        {
          level: "error",
          code: "wso2/invalid_export",
          message:
            "The WSO2 export must be an API object, a `data` API object, or contain an `apis` array.",
          coordinate: { origin },
        },
      ],
    };
  }
  if (
    apis.length === 0 ||
    apis.some(({ api }) => typeof api.name !== "string" || api.name.length === 0)
  ) {
    return {
      apis: [],
      diagnostics: [
        {
          level: "error",
          code: "wso2/invalid_export",
          message: "Every WSO2 API must be an object with a non-empty `name`.",
          coordinate: { origin },
        },
      ],
    };
  }
  return { apis, diagnostics: [] };
}

function opsOf(api: WsoApi): SynthOp[] {
  return asObjects<WsoOperation>(api.operations).map((op) => {
    const path = joinGatewayPath(api.context, op.target);
    return {
      operationId: synthOperationId(api.name, op.verb, path),
      method: op.verb,
      path,
    };
  });
}

function normalizeApi(
  api: WsoApi,
  pointer: string | undefined,
  origin: string,
): { ops: SynthOp[]; facts: GatewayFact[]; diagnostics: GatewayDiagnostic[]; hasQuota: boolean } {
  const ops = opsOf(api);
  const facts: GatewayFact[] = [];
  const diagnostics: GatewayDiagnostic[] = [];

  asObjects<WsoOperation>(api.operations).forEach((op, j) => {
    const scopes = asStrings(op.scopes);
    if (scopes.length > 0) {
      const coordinate: EvidenceCoordinate = {
        origin,
        pointer: `${pointer ?? ""}/operations/${j}/scopes`,
      };
      facts.push({
        target: {
          scope: "operation",
          ref: synthOperationId(api.name, op.verb, joinGatewayPath(api.context, op.target)),
        },
        predicate: "auth.scopes",
        operation: "restrict",
        value: scopes,
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
      coordinate: { origin, pointer: `${pointer ?? ""}/apiThrottlingPolicy` },
    });
  }
  if (api.mediationPolicies && api.mediationPolicies.length > 0) {
    diagnostics.push({
      level: "warning",
      code: "gateway/opaque_policy",
      message: `WSO2 mediation on '${api.name}' is not modelled; it may transform requests/responses.`,
      coordinate: { origin, pointer: `${pointer ?? ""}/mediationPolicies` },
    });
  }
  return { ops, facts, diagnostics, hasQuota };
}

export class Wso2GatewayAdapter implements GatewayAdapter<Wso2Connection> {
  readonly kind = "wso2" as const;
  readonly capabilities = CAPABILITIES;

  async probe(connection: Wso2Connection, _ctx: AdapterContext): Promise<GatewayProbeResult> {
    const origin = connection.origin ?? "wso2-api.yaml";
    const parsed = parseExport(connection.config, origin);
    return {
      reachable: parsed.diagnostics.every((d) => d.level !== "error"),
      capabilities: CAPABILITIES,
      diagnostics: parsed.diagnostics,
    };
  }

  async inventory(
    connection: Wso2Connection,
    _ctx: AdapterContext,
  ): Promise<GatewayInventorySnapshot> {
    const origin = connection.origin ?? "wso2-api.yaml";
    const parsed = parseExport(connection.config, origin);
    const diagnostics: GatewayDiagnostic[] = [...parsed.diagnostics];
    const summaries: GatewayApiSummary[] = parsed.apis.map(({ api, pointer }) => {
      const norm = normalizeApi(api, pointer, origin);
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
        hasSpec: false,
        contract: routeOnlyContract({ origin, pointer }),
        productIds: [],
        owner: api.provider,
        authSummary: asStrings(api.securityScheme).join(", ") || undefined,
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
    const parsed = parseExport(connection.config, origin);
    const found = parsed.apis.find(({ api: candidate }) => candidate.name === api.id);
    if (!found) {
      const empty = buildGatewayApiImport({
        originKind: "wso2",
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
          { level: "error", code: "wso2/unknown_api", message: `No WSO2 API '${api.id}'.` },
        ],
      };
    }
    const norm = normalizeApi(found.api, found.pointer, origin);
    return buildGatewayApiImport({
      originKind: "wso2",
      apiName: found.api.name,
      version: found.api.version,
      sourceCoordinate: { origin, pointer: found.pointer },
      ops: norm.ops,
      facts: norm.facts,
      authConfigured:
        asStrings(found.api.securityScheme).length > 0 ||
        asObjects<WsoOperation>(found.api.operations).some((op) => Boolean(op.authType)),
      diagnostics: norm.diagnostics,
    });
  }
}
