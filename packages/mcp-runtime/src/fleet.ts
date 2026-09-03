import type { AirDocument } from "@anvil/air";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildMcpServer, type McpBuildOptions } from "./server.js";

/**
 * The fleet runtime: many bundles, one MCP surface.
 *
 * `buildMcpServer` (server.ts) is the single-bundle serving path and stays
 * completely untouched by this module — `buildFleetServer` never re-derives
 * tool names, disclosure, or execution semantics; it COMPOSES real,
 * independently-built `McpServer` instances, one per bundle, over an
 * in-process MCP transport pair (`InMemoryTransport.createLinkedPair`) and an
 * internal `Client`. This is the same wire protocol a remote caller uses, so
 * a bundle served through the fleet answers `tools/call` byte-identically to
 * the same bundle served alone — the fleet only adds a stable name prefix in
 * front of what the bundle already decided to expose, and never renames an
 * approved operation's OWN tool name (`op.mcp.toolName`, `anvil/operation_id`
 * in `_meta`) — only the wire name a caller dials.
 *
 * Composing through a real client/server pair (rather than reaching into
 * `McpServer`'s private registration table) is deliberate: the SDK exposes no
 * public API to enumerate or re-dispatch a built server's tools directly, and
 * a fleet that worked by inspecting internals would silently drift from
 * whatever the SDK actually serves on the wire. `tools/list` + `tools/call`
 * over a loopback transport IS the SDK's own public contract, so this reuses
 * it rather than reimplementing it.
 */

/** One bundle mounted into the fleet. */
export interface FleetBundleInput {
  /**
   * The bundle's stable identity — a workspace-relative path from bundle
   * discovery (`@anvil/generators`'s `discoverBundles`), never derived from
   * `air.service.id` alone (two bundles can share a service id across
   * environments). Used verbatim to derive this bundle's tool-name prefix
   * (`fleetToolPrefix`), so a bundle's mounted names are stable across a
   * fleet restart as long as its directory does not move.
   */
  id: string;
  air: AirDocument;
  options: McpBuildOptions;
  /**
   * This bundle's own certified state, read by the CALLER from its
   * `certification.json` (`@anvil/generators`'s `Certification`) — fleet.ts
   * itself never reads the filesystem or depends on `@anvil/generators`
   * (that dependency runs the other way). Absent when the bundle has never
   * been certified.
   */
  certification?: { hash: string; status: "passed" | "failed" | "expired" };
}

export interface FleetBundleReadiness {
  id: string;
  serviceId: string;
  toolCount: number;
  certifiedHash?: string;
  certificationStatus?: "passed" | "failed" | "expired";
  /** True only when this bundle is certified `passed` — the fleet-wide `ready` folds these. */
  ready: boolean;
}

export interface FleetReadyz {
  ready: boolean;
  bundles: FleetBundleReadiness[];
}

/** A cross-bundle tool-name collision — refused by construction, never silently resolved. */
export class FleetToolCollisionError extends Error {
  constructor(
    readonly toolName: string,
    readonly existingBundleId: string,
    readonly incomingBundleId: string,
  ) {
    super(
      `Fleet tool-name collision on '${toolName}': bundle '${existingBundleId}' already mounts it, ` +
        `and bundle '${incomingBundleId}' also produces it under the same prefixed name. ` +
        "Anvil never renames an approved operation's tool name to resolve this silently — " +
        "give one of the two bundles a distinct workspace path (its id is derived from that path).",
    );
    this.name = "FleetToolCollisionError";
  }
}

/** A duplicate bundle id passed to `buildFleetServer` — refused before any bundle is built. */
export class FleetDuplicateBundleError extends Error {
  constructor(readonly bundleId: string) {
    super(`Duplicate bundle id '${bundleId}' passed to buildFleetServer.`);
    this.name = "FleetDuplicateBundleError";
  }
}

const PREFIX_SEPARATOR = "__";

/**
 * The stable per-bundle tool-name prefix, derived from the bundle's
 * workspace-relative id (slashes and anything MCP-unsafe folded to `_`) —
 * the same folding convention `@anvil/compiler`'s naming module uses for
 * MCP-safe identifiers, applied here to a workspace PATH rather than an
 * operation name.
 */
export function fleetToolPrefix(bundleId: string): string {
  const folded = bundleId.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return folded || "bundle";
}

/** The full, wire-facing tool name a fleet mounts one bundle's tool under. */
export function fleetToolName(bundleId: string, toolName: string): string {
  return `${fleetToolPrefix(bundleId)}${PREFIX_SEPARATOR}${toolName}`;
}

/** Convert one served tool's JSON-Schema `inputSchema` into a zod raw shape for re-registration. */
function jsonSchemaShapeFor(inputSchema: {
  properties?: Record<string, object>;
  required?: string[];
}): z.ZodRawShape {
  const properties = inputSchema.properties ?? {};
  const required = new Set(inputSchema.required ?? []);
  const shape: Record<string, z.ZodType> = {};
  for (const [key, propSchema] of Object.entries(properties)) {
    let t = z.fromJSONSchema(propSchema as Parameters<typeof z.fromJSONSchema>[0]);
    const description = (propSchema as { description?: unknown }).description;
    if (typeof description === "string") t = t.describe(description);
    shape[key] = required.has(key) ? t : t.optional();
  }
  return shape;
}

export interface FleetServer {
  /** The fleet's own MCP server — connect this to whatever transport is serving it. */
  server: McpServer;
  /** Per-bundle certified state for `/readyz`; folds to `ready: false` if any bundle isn't `passed`. */
  readyz(): FleetReadyz;
  /** Every mounted tool name -> the bundle id that owns it (for diagnostics/logging). */
  toolOwners: ReadonlyMap<string, string>;
  /** Closes every internal client and every per-bundle server. Idempotent-safe to call once. */
  close(): Promise<void>;
}

/**
 * Mount every bundle's approved tool surface under a stable per-bundle
 * prefix onto one MCP server. Refuses (throws `FleetDuplicateBundleError` /
 * `FleetToolCollisionError`) rather than silently dropping or renaming
 * anything — a fleet operator sees exactly which two bundles collided.
 *
 * Single-bundle behaviour is untouched: this never changes what
 * `buildMcpServer` builds for one bundle, only how many of them one process
 * answers `tools/list`/`tools/call` for.
 */
export async function buildFleetServer(
  bundles: readonly FleetBundleInput[],
  opts: { name?: string; version?: string } = {},
): Promise<FleetServer> {
  if (bundles.length === 0) {
    throw new Error("buildFleetServer requires at least one bundle.");
  }
  const seenIds = new Set<string>();
  for (const bundle of bundles) {
    if (seenIds.has(bundle.id)) throw new FleetDuplicateBundleError(bundle.id);
    seenIds.add(bundle.id);
  }

  const fleet = new McpServer({ name: opts.name ?? "anvil-fleet", version: opts.version ?? "0.0.0" });
  const toolOwners = new Map<string, string>();
  const closers: Array<() => Promise<void>> = [];
  const readiness: FleetBundleReadiness[] = [];

  for (const bundle of bundles) {
    const bundleServer = buildMcpServer(bundle.air, bundle.options);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await bundleServer.connect(serverTransport);
    const client = new Client({ name: `anvil-fleet:${bundle.id}`, version: "0.0.0" });
    await client.connect(clientTransport);
    closers.push(async () => {
      await client.close();
      await bundleServer.close();
    });

    const listed = await client.listTools();
    for (const tool of listed.tools) {
      const finalName = fleetToolName(bundle.id, tool.name);
      const existingOwner = toolOwners.get(finalName);
      if (existingOwner) {
        for (const close of closers) await close().catch(() => undefined);
        throw new FleetToolCollisionError(finalName, existingOwner, bundle.id);
      }
      toolOwners.set(finalName, bundle.id);

      fleet.registerTool(
        finalName,
        {
          title: tool.title ?? tool.name,
          description: tool.description ?? "",
          inputSchema: jsonSchemaShapeFor(tool.inputSchema),
          annotations: tool.annotations,
          _meta: {
            ...tool._meta,
            "anvil/fleet_bundle_id": bundle.id,
            "anvil/fleet_tool_name": tool.name,
          },
        },
        // biome-ignore lint/suspicious/noExplicitAny: forwarding the client's own CallToolResult
        // shape verbatim — re-typing it here would just restate the SDK's own type.
        async (args: Record<string, unknown>): Promise<any> => {
          return client.callTool({ name: tool.name, arguments: args });
        },
      );
    }

    readiness.push({
      id: bundle.id,
      serviceId: bundle.air.service.id,
      toolCount: listed.tools.length,
      certifiedHash: bundle.certification?.hash,
      certificationStatus: bundle.certification?.status,
      ready: bundle.certification?.status === "passed",
    });
  }

  return {
    server: fleet,
    toolOwners,
    readyz: () => ({ ready: readiness.every((b) => b.ready), bundles: readiness }),
    close: async () => {
      for (const close of closers) await close();
    },
  };
}
