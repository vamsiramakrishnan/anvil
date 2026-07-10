import { createHash } from "node:crypto";
import type { AirDocument, JsonSchema, Operation } from "@anvil/air";
import { loadAirDocument } from "@anvil/air";
import { type GeneratedBundle, generateBundle } from "./bundle.js";
import type { ResourceOptions } from "./resources.js";

/**
 * Capability-scoped builds. `capabilityView` narrows a whole-service AIR
 * document to ONE approved capability — its approved member operations, the
 * workflows those operations fully satisfy, and only the schemas they reach —
 * and `generateCapabilityBundle` compiles that view through the ordinary
 * whole-service `generateBundle`, so a capability bundle is not a new artifact
 * kind: it is the same aligned CLI + MCP + skill projection of a smaller model.
 *
 * The safety contract holds by construction: an operation that is not an
 * approved member of the capability never *enters* the view, so it cannot
 * appear on any generated surface.
 */

/** A structured, typed failure from a capability build. */
export class CapabilityBuildError extends Error {
  readonly code: "capability_not_found" | "capability_not_approved" | "capability_empty";

  constructor(code: CapabilityBuildError["code"], message: string) {
    super(message);
    this.name = "CapabilityBuildError";
    this.code = code;
  }
}

/**
 * Narrow an AIR document to one capability's approved surface. Refuses (with a
 * typed error) a capability that is missing, not lifecycle-approved, or whose
 * approved member set is empty — a silently-empty bundle would look like a
 * successful build while exposing nothing.
 */
export function capabilityView(air: AirDocument, capabilityId: string): AirDocument {
  const capability = air.capabilities.find((c) => c.id === capabilityId);
  if (!capability) {
    const known = air.capabilities.map((c) => c.id).join(", ") || "(none)";
    throw new CapabilityBuildError(
      "capability_not_found",
      `No capability '${capabilityId}'. Known capabilities: ${known}.`,
    );
  }
  if (capability.lifecycle !== "approved") {
    throw new CapabilityBuildError(
      "capability_not_approved",
      `Capability '${capabilityId}' is '${capability.lifecycle}', not approved. ` +
        `Review it first: anvil capability approve <dir> ${capabilityId}.`,
    );
  }

  const memberIds = new Set(capability.operationIds);
  const operations = air.operations.filter((op) => memberIds.has(op.id) && op.state === "approved");
  if (operations.length === 0) {
    const states = capability.operationIds
      .map((id) => `${id}=${air.operations.find((o) => o.id === id)?.state ?? "missing"}`)
      .join(", ");
    throw new CapabilityBuildError(
      "capability_empty",
      `Capability '${capabilityId}' has no approved operations (${states || "no members"}). ` +
        `Approve operations with \`anvil approve\` before building.`,
    );
  }
  const keptIds = new Set(operations.map((op) => op.id));

  // A workflow survives only if every step it takes stays in the view —
  // shipping a workflow whose step is not exposed would be a broken promise.
  const workflows = air.workflows.filter(
    (wf) => wf.capabilityId === capabilityId && wf.steps.every((s) => keptIds.has(s.operationId)),
  );
  const workflowIds = new Set(workflows.map((wf) => wf.id));

  const narrowedCapability = {
    ...capability,
    operationIds: capability.operationIds.filter((id) => keptIds.has(id)),
    workflowIds: capability.workflowIds.filter((id) => workflowIds.has(id)),
  };

  // Keep only diagnostics that refer to something inside the view. Anonymous
  // diagnostics may mention operations that are deliberately excluded, so they
  // are dropped rather than leaked into the narrowed artifact.
  const diagnostics = air.diagnostics.filter(
    (d) =>
      (d.operationId !== undefined && keptIds.has(d.operationId)) ||
      d.capabilityId === capabilityId,
  );

  const view: AirDocument = {
    anvilVersion: air.anvilVersion,
    service: air.service,
    operations,
    capabilities: [narrowedCapability],
    workflows,
    schemas: reachableSchemas(air.schemas, operations),
    diagnostics,
  };
  // Re-validate and deep-clone through the schema so the view never aliases
  // (and can never mutate) the whole-service document it was cut from.
  return loadAirDocument(structuredClone(view));
}

/**
 * The component schemas transitively reachable from the given operations.
 * References are collected structurally (`#/components/schemas/<name>` pointers
 * anywhere in an operation, plus `output.schemaRef` names), then closed over
 * the references inside the kept schemas themselves.
 */
function reachableSchemas(
  schemas: Record<string, JsonSchema>,
  operations: Operation[],
): Record<string, JsonSchema> {
  const refPattern = /#\/components\/schemas\/([A-Za-z0-9_.-]+)/g;
  const refsIn = (value: unknown): string[] =>
    [...(JSON.stringify(value ?? null) ?? "").matchAll(refPattern)].map((m) => m[1] as string);

  const queue: string[] = [];
  for (const op of operations) {
    queue.push(...refsIn(op));
    const bare = op.output.schemaRef;
    if (bare && bare in schemas) queue.push(bare);
  }
  const kept = new Set<string>();
  while (queue.length > 0) {
    const name = queue.shift() as string;
    if (kept.has(name) || !(name in schemas)) continue;
    kept.add(name);
    queue.push(...refsIn(schemas[name]));
  }
  // Deterministic key order, independent of traversal order.
  const out: Record<string, JsonSchema> = {};
  for (const name of [...kept].sort()) out[name] = schemas[name] as JsonSchema;
  return out;
}

export const CAPABILITY_BUNDLE_SCHEMA_VERSION = 1;

/** One surface's entry in the capability manifest. */
export interface CapabilitySurface {
  entrypoint: string;
  /** The operations this surface exposes, in the surface's own naming. */
  operations: string[];
  /** The contract this surface was compiled from — identical across surfaces. */
  contractHash: string;
}

/**
 * `bundle.json` — the capability bundle's identity card. All hashes are
 * content-derived from the narrowed AIR (no timestamps), so rebuilding an
 * unchanged input reproduces the identical manifest, and every surface carries
 * the one contract hash it was compiled from: a mismatch anywhere is drift.
 */
export interface CapabilityBundleManifest {
  schemaVersion: typeof CAPABILITY_BUNDLE_SCHEMA_VERSION;
  capabilityId: string;
  /** The service version the capability was cut from. */
  capabilityVersion: string;
  /** Hash of the narrowed capability node (grouping identity). */
  capabilityHash: string;
  /** Hash of the full narrowed contract every surface is generated from. */
  contractHash: string;
  surfaces: { cli: CapabilitySurface; mcp: CapabilitySurface; skill: CapabilitySurface };
}

/** Recursively sort object keys so hashing is independent of insertion order. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** sha256 of the canonical (key-sorted) JSON of a value. */
export function hashCanonical(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

export interface CapabilityBundle {
  /** The narrowed AIR document the bundle was generated from. */
  view: AirDocument;
  manifest: CapabilityBundleManifest;
  /** The ordinary aligned bundle plus `bundle.json` at its root. */
  bundle: GeneratedBundle;
}

/**
 * Compile ONE approved capability into an aligned bundle: narrow the document
 * (`capabilityView`), reuse the whole-service `generateBundle`, and stamp a
 * content-addressed `bundle.json` at the root. Diagnostics are excluded from
 * the hashed contract — they are commentary about the model, not the contract
 * the surfaces implement.
 */
export function generateCapabilityBundle(
  air: AirDocument,
  capabilityId: string,
  options: ResourceOptions = {},
): CapabilityBundle {
  const view = capabilityView(air, capabilityId);
  const bundle = generateBundle(view, options);

  const capability = view.capabilities[0] as AirDocument["capabilities"][number];
  const contractHash = hashCanonical({ ...view, diagnostics: undefined });
  const capabilityHash = hashCanonical(capability);
  const ops = view.operations;
  const manifest: CapabilityBundleManifest = {
    schemaVersion: CAPABILITY_BUNDLE_SCHEMA_VERSION,
    capabilityId,
    capabilityVersion: view.service.version,
    capabilityHash,
    contractHash,
    surfaces: {
      cli: {
        entrypoint: `cli/${view.service.id}.mjs`,
        operations: ops.map((op) => op.cli.command).sort(),
        contractHash,
      },
      mcp: {
        entrypoint: "mcp/server.js",
        operations: ops.map((op) => op.mcp.toolName).sort(),
        contractHash,
      },
      skill: {
        entrypoint: "skill/SKILL.md",
        operations: ops.map((op) => op.canonicalName).sort(),
        contractHash,
      },
    },
  };
  bundle.files["bundle.json"] = `${JSON.stringify(manifest, null, 2)}\n`;
  return { view, manifest, bundle };
}
