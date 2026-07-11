/**
 * The Kong adapter — the first real vendor adapter. It reads a Kong declarative
 * config and emits only the common artifacts: a `GatewayInventorySnapshot` and,
 * per service, a `GatewayApiImport { source, overlay }`. No Kong type escapes this
 * package; the compiler pipeline consumes the result exactly as it would any other
 * source + overlay.
 */
import { ephemeralCompilerSource } from "../../source/compiler-source.js";
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
import { buildGatewayOverlay } from "../overlay.js";
import type { KongService } from "./model.js";
import { parseKongConfig } from "./parse.js";
import { normalizeServicePlugins } from "./plugins.js";
import { serviceOperations, synthesizeOpenApi } from "./spec.js";

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

function routesOf(service: KongService): GatewayRoute[] {
  return (service.routes ?? []).map((r, i) => ({
    id: r.name ?? `${service.name}-route-${i}`,
    methods: r.methods ?? [],
    paths: r.paths ?? [],
    hosts: r.hosts ?? [],
    protocols: r.protocols ?? [],
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
    const services = parsed.config.services ?? [];
    const diagnostics: GatewayDiagnostic[] = [];
    const apis: GatewayApiSummary[] = services.map((service, svcIndex) => {
      const operationIds = serviceOperations(service).map((o) => o.operationId);
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
        owner: service.tags?.[0],
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
    if (!parsed.ok) {
      return {
        source: emptySource(api.id),
        overlay: buildGatewayOverlay([]),
        diagnostics: parsed.diagnostics,
      };
    }
    const services = parsed.config.services ?? [];
    const svcIndex = services.findIndex((s) => s.name === api.id);
    const service = services[svcIndex];
    if (!service) {
      return {
        source: emptySource(api.id),
        overlay: buildGatewayOverlay([]),
        diagnostics: [
          { level: "error", code: "kong/unknown_service", message: `No Kong service '${api.id}'.` },
        ],
      };
    }

    const specText = synthesizeOpenApi(service);
    const base = ephemeralCompilerSource(specText, `${service.name}.openapi.yaml`);
    const source = { ...base, origin: { kind: "kong" as const, uri: `kong://${service.name}` } };

    const operationIds = serviceOperations(service).map((o) => o.operationId);
    const norm = normalizeServicePlugins(service, svcIndex, operationIds, origin);
    const overlay = buildGatewayOverlay(norm.facts, `overlay_kong_${service.name}`);
    return { source, overlay, diagnostics: norm.diagnostics };
  }
}

/** A trivial valid source for the error paths (keeps the return type honest). */
function emptySource(id: string) {
  const base = ephemeralCompilerSource(
    'openapi: "3.0.3"\ninfo: { title: empty, version: "0.0.0" }\npaths: {}\n',
    `${id}.openapi.yaml`,
  );
  return { ...base, origin: { kind: "kong" as const, uri: `kong://${id}` } };
}
