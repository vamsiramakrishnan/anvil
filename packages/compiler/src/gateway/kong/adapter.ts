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
import {
  buildGatewayApiImport,
  gatewayOperationRef,
  normalizePath,
  routeOnlyContract,
  type SynthOp,
  synthOperationId,
} from "../synth.js";
import type { KongPlugin, KongRoute, KongService } from "./model.js";
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
  apiSpecs: false,
  routes: true,
  authentication: true,
  authorization: false,
  trafficPolicies: true,
  transformations: "partial",
  faultPolicies: false,
  products: false,
  consumers: false,
  trafficAnalytics: false,
  drift: false,
  publish: false,
};

interface ServiceRouteProjection {
  ops: SynthOp[];
  diagnostics: GatewayDiagnostic[];
}

/**
 * Project only routes whose method and path coordinates are explicit.
 *
 * A missing Kong `methods` field means "any method", and a missing `paths`
 * field means the route may match by another predicate. Choosing GET or `/`
 * would invent a callable contract. Expressions-router predicates are opaque
 * for the same reason: Anvil does not interpret Kong's expression grammar.
 */
function projectServiceRoutes(
  service: KongService,
  serviceIndex: number,
  origin: string,
): ServiceRouteProjection {
  const ops = new Map<string, SynthOp>();
  const diagnostics: GatewayDiagnostic[] = [];
  asObjects<KongRoute>(service.routes).forEach((route, routeIndex) => {
    const routePointer = `/services/${serviceIndex}/routes/${routeIndex}`;
    const routeName = route.name ?? `${service.name}-route-${routeIndex}`;
    if (typeof route.expression === "string" && route.expression.trim().length > 0) {
      diagnostics.push({
        level: "warning",
        code: "gateway/opaque_policy",
        message: `Kong route '${routeName}' uses an expressions-router predicate that Anvil does not interpret; no callable operation was synthesized.`,
        coordinate: { origin, pointer: `${routePointer}/expression` },
        subject: { api: { id: service.name }, route: { id: routeName } },
      });
      return;
    }

    const routePaths = asStrings(route.paths);
    const routeMethods = asStrings(route.methods);
    if (routeMethods.length === 0 || routePaths.length === 0) {
      const missing = [
        ...(routeMethods.length === 0 ? ["HTTP methods"] : []),
        ...(routePaths.length === 0 ? ["paths"] : []),
      ].join(" and ");
      diagnostics.push({
        level: "warning",
        code: "gateway/opaque_policy",
        message: `Kong route '${routeName}' does not explicitly constrain ${missing}; Anvil will not invent GET or /, so no callable operation was synthesized.`,
        coordinate: { origin, pointer: routePointer },
        subject: { api: { id: service.name }, route: { id: routeName } },
      });
      return;
    }

    for (const path of routePaths) {
      for (const method of routeMethods) {
        const operationId = synthOperationId(service.name, method, path);
        ops.set(operationId, { operationId, method, path: normalizePath(path) });
      }
    }
  });
  return {
    ops: [...ops.values()].sort((a, b) => a.operationId.localeCompare(b.operationId)),
    diagnostics,
  };
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

/**
 * decK exports may attach plugins globally or to individual routes. The current
 * semantic normalizer only understands service-level placement, so preserving
 * those effective policies as blockers is safer than silently treating them as
 * absent.
 */
function unmodeledTopLevelPluginDiagnostics(
  config: { plugins?: KongPlugin[] },
  origin: string,
): GatewayDiagnostic[] {
  const diagnostics: GatewayDiagnostic[] = [];
  asObjects<KongPlugin>(config.plugins).forEach((plugin, pluginIndex) => {
    if (plugin.enabled === false) return;
    diagnostics.push({
      level: "warning",
      code: "gateway/opaque_policy",
      message: `Top-level Kong plugin '${String(plugin.name ?? "(unnamed)")}' has unmodelled service/route applicability and must be reviewed.`,
      coordinate: { origin, pointer: `/plugins/${pluginIndex}` },
    });
  });
  return diagnostics;
}

function unmodeledRoutePluginDiagnostics(
  service: KongService,
  serviceIndex: number,
  origin: string,
): GatewayDiagnostic[] {
  const diagnostics: GatewayDiagnostic[] = [];
  asObjects<KongRoute>(service.routes).forEach((route, routeIndex) => {
    asObjects<KongPlugin>(route.plugins).forEach((plugin, pluginIndex) => {
      if (plugin.enabled === false) return;
      diagnostics.push({
        level: "warning",
        code: "gateway/opaque_policy",
        message: `Route-level Kong plugin '${String(plugin.name ?? "(unnamed)")}' on '${service.name}' is not yet projected with route-scoped semantics and must be reviewed.`,
        coordinate: {
          origin,
          pointer: `/services/${serviceIndex}/routes/${routeIndex}/plugins/${pluginIndex}`,
        },
        subject: {
          api: { id: service.name },
          route: { id: route.name ?? `${service.name}-route-${routeIndex}` },
        },
      });
    });
  });
  return diagnostics;
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
    const diagnostics: GatewayDiagnostic[] = [
      ...unmodeledTopLevelPluginDiagnostics(parsed.config, origin),
    ];
    const apis: GatewayApiSummary[] = services.map((service, svcIndex) => {
      const projected = projectServiceRoutes(service, svcIndex, origin);
      const operationIds = projected.ops.map((o) => o.operationId);
      const norm = normalizeServicePlugins(
        service,
        svcIndex,
        operationIds,
        origin,
        projected.ops.map((op) => gatewayOperationRef(op.method, op.path)),
      );
      norm.diagnostics.push(
        ...projected.diagnostics,
        ...unmodeledRoutePluginDiagnostics(service, svcIndex, origin),
      );
      diagnostics.push(...norm.diagnostics);
      return {
        id: service.name,
        name: service.name,
        version: "0.0.0",
        lifecycle: "published",
        environmentIds: [],
        routes: routesOf(service),
        hasSpec: false,
        contract: routeOnlyContract({ origin, pointer: `/services/${svcIndex}` }),
        productIds: [],
        owner: asStrings(service.tags)[0],
        authSummary: norm.authSummary,
        ...(norm.identityEvidence.length > 0 ? { identityEvidence: norm.identityEvidence } : {}),
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
        sourceCoordinate: { origin },
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
          {
            level: "error",
            code: "kong/unknown_service",
            message: `No Kong service '${api.id}'.`,
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

    const projected = projectServiceRoutes(service, svcIndex, origin);
    const ops = projected.ops;
    const norm = normalizeServicePlugins(
      service,
      svcIndex,
      ops.map((o) => o.operationId),
      origin,
      ops.map((op) => gatewayOperationRef(op.method, op.path)),
    );
    norm.diagnostics.push(
      ...projected.diagnostics,
      ...unmodeledTopLevelPluginDiagnostics(parsed.config, origin),
      ...unmodeledRoutePluginDiagnostics(service, svcIndex, origin),
    );
    return {
      ...buildGatewayApiImport({
        originKind: "kong",
        apiName: service.name,
        sourceCoordinate: { origin, pointer: `/services/${svcIndex}` },
        ops,
        facts: norm.facts,
        authConfigured: Boolean(norm.authSummary),
        diagnostics: norm.diagnostics,
      }),
      ...(norm.identityEvidence.length > 0 ? { identityEvidence: norm.identityEvidence } : {}),
    };
  }
}
