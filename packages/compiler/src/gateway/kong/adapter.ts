/**
 * The Kong adapter — the first real vendor adapter. It reads a Kong declarative
 * config and emits only the common artifacts: a `GatewayInventorySnapshot` and,
 * per service, a `GatewayApiImport { source, overlay }`. No Kong type escapes this
 * package; the compiler pipeline consumes the result exactly as it would any other
 * source + overlay. Source synthesis is the shared `synth` helper — one path for
 * every vendor.
 */
import type { AdapterContext, GatewayAdapter, GatewayConnection } from "../adapter.js";
import { finalizeInventory } from "../inventory.js";
import type {
  GatewayAdapterCapabilities,
  GatewayApiImport,
  GatewayApiRef,
  GatewayApiSummary,
  GatewayDiagnostic,
  GatewayInventorySnapshot,
  GatewayProbeResult,
  GatewayRoute,
} from "../model.js";
import { asObjects, asStrings } from "../parse-safe.js";
import { buildGatewayApiImport, normalizePath, type SynthOp, synthOperationId } from "../synth.js";
import type { KongRoute, KongService } from "./model.js";
import { parseKongConfig } from "./parse.js";
import { normalizeServicePlugins } from "./plugins.js";

/** A read-only connection to a Kong declarative config. */
export interface KongConnection extends GatewayConnection {
  /** The declarative config text (a `deck` dump). */
  config: string;
  /** The origin name recorded in evidence coordinates. */
  origin?: string;
}

const CAPABILITIES: GatewayAdapterCapabilities = {
  inventory: true,
  apiSpecs: true,
  routes: true,
  authentication: true,
  authorization: false,
  trafficPolicies: true,
  transformations: "partial",
  faultPolicies: false,
  products: false,
  consumers: true,
  trafficAnalytics: false,
  drift: false,
  publish: false,
};

/** The (path, method) operations a service exposes, deduped and sorted. */
function serviceOps(service: KongService): SynthOp[] {
  const ops = new Map<string, SynthOp>();
  for (const route of asObjects<KongRoute>(service.routes)) {
    const routePaths = asStrings(route.paths);
    const routeMethods = asStrings(route.methods);
    const paths = routePaths.length ? routePaths : ["/"];
    const methods = routeMethods.length ? routeMethods : ["GET"];
    for (const path of paths) {
      for (const method of methods) {
        const operationId = synthOperationId(service.name, method, path);
        ops.set(operationId, { operationId, method, path: normalizePath(path) });
      }
    }
  }
  return [...ops.values()].sort((a, b) => a.operationId.localeCompare(b.operationId));
}

function routesOf(service: KongService): GatewayRoute[] {
  return asObjects<KongRoute>(service.routes).map((r, i) => ({
    id: r.name ?? `${service.name}-route-${i}`,
    methods: asStrings(r.methods),
    paths: asStrings(r.paths),
    hosts: asStrings(r.hosts),
    protocols: asStrings(r.protocols),
  }));
}

export class KongGatewayAdapter implements GatewayAdapter<KongConnection> {
  readonly kind = "kong" as const;
  readonly capabilities = CAPABILITIES;

  async probe(connection: KongConnection, _ctx: AdapterContext): Promise<GatewayProbeResult> {
    const parsed = parseKongConfig(connection.config, connection.origin);
    return {
      reachable: parsed.ok,
      protocolVersion: parsed.ok ? (parsed.config._format_version ?? "unknown") : undefined,
      capabilities: CAPABILITIES,
      diagnostics: parsed.ok ? [] : parsed.diagnostics,
    };
  }

  async inventory(
    connection: KongConnection,
    _ctx: AdapterContext,
  ): Promise<GatewayInventorySnapshot> {
    const origin = connection.origin ?? "kong.yaml";
    const parsed = parseKongConfig(connection.config, origin);
    if (!parsed.ok) {
      return finalizeInventory({
        schemaVersion: 1,
        gateway: { kind: "kong", id: connection.id },
        environments: [],
        apis: [],
        products: [],
        diagnostics: parsed.diagnostics,
      });
    }
    const services = asObjects<KongService>(parsed.config.services);
    const diagnostics: GatewayDiagnostic[] = [];
    const apis: GatewayApiSummary[] = services.map((service, svcIndex) => {
      const operationIds = serviceOps(service).map((o) => o.operationId);
      const norm = normalizeServicePlugins(service, svcIndex, operationIds, origin);
      diagnostics.push(...norm.diagnostics);
      return {
        id: service.name,
        name: service.name,
        version: "0.0.0",
        lifecycle: "published",
        environmentIds: [],
        routes: routesOf(service),
        hasSpec: operationIds.length > 0,
        productIds: [],
        owner: asStrings(service.tags)[0],
        authSummary: norm.authSummary,
        hasQuota: norm.hasQuota,
      };
    });
    return finalizeInventory({
      schemaVersion: 1,
      gateway: { kind: "kong", id: connection.id, name: origin },
      environments: [],
      apis,
      products: [],
      diagnostics,
    });
  }

  async extractApi(
    connection: KongConnection,
    api: GatewayApiRef,
    _ctx: AdapterContext,
  ): Promise<GatewayApiImport> {
    const origin = connection.origin ?? "kong.yaml";
    const parsed = parseKongConfig(connection.config, origin);
    const empty = () =>
      buildGatewayApiImport({
        originKind: "kong",
        apiName: api.id,
        ops: [],
        facts: [],
        diagnostics: [],
      });
    if (!parsed.ok) return { ...empty(), diagnostics: parsed.diagnostics };

    const services = asObjects<KongService>(parsed.config.services);
    const svcIndex = services.findIndex((s) => s.name === api.id);
    const service = services[svcIndex];
    if (!service) {
      return {
        ...empty(),
        diagnostics: [
          { level: "error", code: "kong/unknown_service", message: `No Kong service '${api.id}'.` },
        ],
      };
    }

    const ops = serviceOps(service);
    const norm = normalizeServicePlugins(
      service,
      svcIndex,
      ops.map((o) => o.operationId),
      origin,
    );
    return buildGatewayApiImport({
      originKind: "kong",
      apiName: service.name,
      ops,
      facts: norm.facts,
      diagnostics: norm.diagnostics,
    });
  }
}
