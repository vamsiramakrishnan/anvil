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
 * internal `Client`. This is the same wire protocol a remote caller uses, and
 * never renames an approved operation's OWN tool name (`op.mcp.toolName`,
 * `anvil/operation_id` in `_meta`) — only the wire name a caller dials.
 *
 * **With exactly one bundle mounted, the fleet does not prefix at all**: the
 * wire name a caller dials, the tool's `_meta`, `annotations`, `title`, and
 * `description`, and the `CallToolResult` a call returns, are the same
 * values the bundle would produce served without --fleet (see the
 * byte-identity test in fleet.test.ts, which diffs the two responses
 * directly rather than trusting this comment). The one thing that is NOT
 * guaranteed identical is the JSON *key order* inside a reconstructed
 * `inputSchema`: `tools/list` is read back through a real `Client`, so an
 * input schema is round-tripped JSON-Schema -> zod raw shape
 * (`jsonSchemaShapeFor`) -> JSON-Schema again by the SDK before it reaches a
 * fleet caller, and the SDK's own zod-to-JSON-Schema conversion does not
 * promise to preserve property key order across that round trip. The
 * *values* are identical (see the test); only their serialized order can
 * differ. From two bundles on, every tool is mounted under a stable
 * per-bundle prefix (`fleetToolName`) to disambiguate.
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
   * This bundle's own certified state, read AND verified by the CALLER
   * against its current content hash (`@anvil/generators`'s
   * `verifyCertification`) — fleet.ts itself never reads the filesystem or
   * depends on `@anvil/generators` (that dependency runs the other way).
   * `fresh` distinguishes "certified, and that certification still describes
   * what's on disk right now" from "certified, but the bundle has since
   * changed underneath it (or the record was copied in from elsewhere)" — a
   * bundle is ready ONLY when both `status === "passed"` AND `fresh`. Absent
   * `fresh` (older/hand-built inputs, e.g. direct `buildFleetServer` callers
   * that never verified freshness themselves) is treated as fresh, so this
   * stays backward compatible with a caller that only ever checked `status`.
   * Absent `certification` entirely when the bundle has never been
   * certified.
   */
  certification?: {
    hash: string;
    status: "passed" | "failed" | "expired";
    fresh?: boolean;
    /** Present when not ready and a reason is known (e.g. a stale hash). */
    reason?: string;
  };
}

export interface FleetBundleReadiness {
  id: string;
  serviceId: string;
  toolCount: number;
  certifiedHash?: string;
  certificationStatus?: "passed" | "failed" | "expired";
  /**
   * True only when this bundle is certified `passed` AND that certification's
   * hash still matches the bundle's current content — the fleet-wide `ready`
   * folds these.
   */
  ready: boolean;
  /** Present when `ready` is false and a certification exists: why (e.g. a stale hash). */
  reason?: string;
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
 * **With exactly one bundle, nothing is prefixed.** Prefixing exists to
 * disambiguate two bundles that would otherwise collide; with only one
 * bundle there is nothing to disambiguate, and the fleet mounts its tools
 * under their own names with no fleet-only `_meta` added — this is what
 * makes the byte-identity test below hold. From two bundles on, every tool
 * is mounted under its stable per-bundle prefix, unconditionally (see
 * `fleetToolName`) — a fleet never renames a bundle's tools just because a
 * peer bundle happened not to collide with it, which would make a tool's
 * public name depend on what else is deployed alongside it.
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
  const singleBundle = bundles.length === 1;

  const fleet = new McpServer({
    name: opts.name ?? "anvil-fleet",
    version: opts.version ?? "0.0.0",
  });
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
      const finalName = singleBundle ? tool.name : fleetToolName(bundle.id, tool.name);
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
          // Fleet-only bookkeeping (`fleet_bundle_id`/`fleet_tool_name`) is
          // added only once there is a fleet decision to record — with a
          // single bundle, `finalName` already equals `tool.name` and there
          // is nothing to disambiguate, so `_meta` is forwarded verbatim.
          // This, together with the unprefixed name above, is what makes a
          // single-bundle fleet's `tools/list`/`tools/call` responses
          // byte-identical to the same bundle served without --fleet.
          _meta: singleBundle
            ? tool._meta
            : {
                ...tool._meta,
                "anvil/fleet_bundle_id": bundle.id,
                "anvil/fleet_tool_name": tool.name,
              },
        },
        // Forwards the client's own CallToolResult verbatim. `callTool`'s return
        // type is a union across its overloads that does not structurally match
        // registerTool's handler type byte-for-byte (both are "the same shape
        // MCP defines", typed two different ways in the SDK) — the cast below is
        // narrower than a bare `any` return type would be.
        async (args: Record<string, unknown>) => {
          const result = await client.callTool({ name: tool.name, arguments: args });
          // biome-ignore lint/suspicious/noExplicitAny: see the comment above this handler.
          return result as any;
        },
      );
    }

    // A bundle is ready only when its certification is BOTH `passed` and
    // fresh (still describes what's on disk) — `fresh` absent (a caller that
    // never verified freshness) is treated as fresh, so a hand-built
    // `FleetBundleInput` that only ever set `status` keeps working exactly
    // as before this field existed.
    const certificationFresh = bundle.certification?.fresh !== false;
    const ready = bundle.certification?.status === "passed" && certificationFresh;
    readiness.push({
      id: bundle.id,
      serviceId: bundle.air.service.id,
      toolCount: listed.tools.length,
      certifiedHash: bundle.certification?.hash,
      certificationStatus: bundle.certification?.status,
      ready,
      reason: ready ? undefined : bundle.certification?.reason,
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
