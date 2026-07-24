import type { AirDocument, JsonSchema, Operation } from "@anvil/air";
import { hashCanonical, kebabCase, loadAirDocument } from "@anvil/air";
import {
  GatewayImportReceiptView,
  type GatewayImportReceiptView as GatewayImportReceiptViewType,
} from "@anvil/compiler";
import { type GeneratedBundle, generateBundle } from "./bundle.js";
import type { ResourceOptions } from "./resources.js";

/**
 * Capability-scoped builds. `capabilityView` narrows a whole-service AIR
 * document to ONE approved capability — its approved public operations, the
 * approved dependency closure of its authored workflows, and only the schemas
 * those operations reach —
 * and `generateCapabilityBundle` compiles that view through the ordinary
 * whole-service `generateBundle`, so a capability bundle is not a new artifact
 * kind: it is the same aligned CLI + MCP + skill projection of a smaller model.
 *
 * The safety contract holds by construction: only approved public members and
 * explicitly recorded workflow dependencies enter the view. A missing or
 * unapproved dependency stops the build rather than dropping the workflow.
 */

/** A structured, typed failure from a capability build. */
export class CapabilityBuildError extends Error {
  readonly code:
    | "capability_not_found"
    | "capability_not_approved"
    | "capability_empty"
    | "capability_workflow_incomplete"
    | "capability_workflow_dependency_unapproved"
    | "capability_parent_gateway_receipt_missing"
    | "capability_parent_gateway_receipt_invalid";

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

  const publicMemberIds = new Set(capability.operationIds);
  const publicOperations = air.operations.filter(
    (op) => publicMemberIds.has(op.id) && op.state === "approved",
  );
  if (publicOperations.length === 0) {
    const states = capability.operationIds
      .map((id) => `${id}=${air.operations.find((o) => o.id === id)?.state ?? "missing"}`)
      .join(", ");
    throw new CapabilityBuildError(
      "capability_empty",
      `Capability '${capabilityId}' has no approved operations (${states || "no members"}). ` +
        `Approve operations with \`anvil approve\` before building.`,
    );
  }

  // An authored workflow is a contract, not optional decoration. Close the
  // view over every approved operation it invokes so a capability build never
  // silently drops the workflow merely because one step is owned by another
  // discovery grouping. Missing or unapproved dependencies fail loudly.
  const workflows = air.workflows.filter((wf) => wf.capabilityId === capabilityId);
  const workflowDependencyIds = new Set(
    workflows.flatMap((wf) => wf.steps.map((step) => step.operationId)),
  );
  for (const operationId of workflowDependencyIds) {
    const dependency = air.operations.find((op) => op.id === operationId);
    if (!dependency) {
      throw new CapabilityBuildError(
        "capability_workflow_incomplete",
        `Capability '${capabilityId}' workflow dependency '${operationId}' is missing from AIR. ` +
          "Repair or remove the authored workflow before building.",
      );
    }
    if (dependency.state !== "approved") {
      throw new CapabilityBuildError(
        "capability_workflow_dependency_unapproved",
        `Capability '${capabilityId}' workflow dependency '${operationId}' is '${dependency.state}', not approved. ` +
          "Inspect and approve that operation, or repair the authored workflow before building.",
      );
    }
  }

  const keptIds = new Set([...publicOperations.map((op) => op.id), ...workflowDependencyIds]);
  const operations = air.operations
    .filter((op) => keptIds.has(op.id))
    .map((op) => {
      if (publicMemberIds.has(op.id)) return op;
      const sourceCapabilityId = op.capabilityId;
      return {
        ...op,
        capabilityId,
        reviewNotes: [
          ...op.reviewNotes,
          `Included in ${capabilityId} as an authored workflow dependency from ${sourceCapabilityId ?? "an ungrouped operation"}.`,
        ],
        evidence: {
          claims: [
            ...op.evidence.claims,
            {
              subject: op.id,
              predicate: "capability.workflow_dependency",
              value: { capabilityId, sourceCapabilityId },
              source: "inferred" as const,
              method: "authored_workflow_dependency_closure",
              confidence: 1,
              review: "accepted" as const,
              note: `Included by an authored workflow owned by ${capabilityId}.`,
            },
          ],
        },
      };
    });
  const workflowIds = new Set(workflows.map((wf) => wf.id));

  const narrowedCapability = {
    ...capability,
    operationIds: [
      ...capability.operationIds.filter((id) => keptIds.has(id)),
      ...[...workflowDependencyIds].filter((id) => !publicMemberIds.has(id)).sort(),
    ],
    workflowIds: [...workflowIds].sort(),
  };

  // Keep diagnostics that refer to the view plus anonymous blockers and
  // gateway evidence. Dropping an unscoped error or gateway policy finding
  // would let narrowing launder a blocked parent into an apparently clean
  // capability bundle.
  const diagnostics = air.diagnostics.filter(
    (d) =>
      (d.operationId !== undefined && keptIds.has(d.operationId)) ||
      d.capabilityId === capabilityId ||
      (d.operationId === undefined &&
        d.capabilityId === undefined &&
        (d.level === "error" || d.code.startsWith("gateway/"))),
  );

  const view: AirDocument = {
    anvilVersion: air.anvilVersion,
    service: {
      ...air.service,
      id: capabilityArtifactId(capabilityId),
      displayName: `${air.service.displayName ?? air.service.id} — ${capability.displayName}`,
    },
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
 * A capability bundle is independently installable, so its CLI/package/skill
 * identity must not collide with another capability cut from the same service.
 */
export function capabilityArtifactId(capabilityId: string): string {
  const candidate = kebabCase(capabilityId.replaceAll(".", "-"));
  if (candidate.length <= 64) return candidate;
  const digest = hashCanonical(capabilityId)
    .replace(/^sha256:/, "")
    .slice(0, 8);
  const prefix = candidate.slice(0, 55).replace(/-+$/, "");
  return `${prefix}-${digest}`;
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
  /** Unique install/package/CLI/skill identity of this derived capability. */
  artifactId: string;
  /** Canonical whole-service identity from which this capability was derived. */
  parentServiceId: string;
  /** The service version the capability was cut from. */
  capabilityVersion: string;
  /** Approved operations directly owned by the reviewed grouping. */
  publicOperationIds: string[];
  /** Additional approved operations required by authored workflows. */
  workflowDependencyOperationIds: string[];
  /** Hash of the narrowed capability node (grouping identity). */
  capabilityHash: string;
  /** Hash of the full narrowed contract every surface is generated from. */
  contractHash: string;
  /** Immutable gateway lineage carried from a gateway-imported parent bundle. */
  parentGatewayImport?: {
    importId: string;
    receiptDigest: string;
    receiptViewDigest: string;
    outputDigest: string;
    lineage: "bound" | "stale";
    blockerCount: number;
  };
  surfaces: { cli: CapabilitySurface; mcp: CapabilitySurface; skill: CapabilitySurface };
}

export interface CapabilityBundle {
  /** The narrowed AIR document the bundle was generated from. */
  view: AirDocument;
  manifest: CapabilityBundleManifest;
  /** The ordinary aligned bundle plus `bundle.json` at its root. */
  bundle: GeneratedBundle;
}

export interface CapabilityBundleOptions extends ResourceOptions {
  /** Validated, redacted gateway receipt view from the parent bundle. */
  parentGatewayReceipt?: GatewayImportReceiptViewType;
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
  options: CapabilityBundleOptions = {},
): CapabilityBundle {
  const { parentGatewayReceipt: rawParentGatewayReceipt, ...resourceOptions } = options;
  const parentGatewayReceipt = rawParentGatewayReceipt
    ? GatewayImportReceiptView.parse(rawParentGatewayReceipt)
    : undefined;
  const view = capabilityView(air, capabilityId);
  const bundle = generateBundle(view, resourceOptions);

  const sourceCapability = air.capabilities.find((cap) => cap.id === capabilityId);
  if (!sourceCapability) {
    throw new CapabilityBuildError("capability_not_found", `No capability '${capabilityId}'.`);
  }
  const publicOperationIds = view.operations
    .filter((op) => sourceCapability.operationIds.includes(op.id))
    .map((op) => op.id)
    .sort();
  const workflowDependencyOperationIds = view.operations
    .filter((op) => !sourceCapability.operationIds.includes(op.id))
    .map((op) => op.id)
    .sort();
  const capability = view.capabilities[0] as AirDocument["capabilities"][number];
  const contractHash = hashCanonical({ ...view, diagnostics: undefined });
  const capabilityHash = hashCanonical(capability);
  const ops = view.operations;
  const manifest: CapabilityBundleManifest = {
    schemaVersion: CAPABILITY_BUNDLE_SCHEMA_VERSION,
    capabilityId,
    artifactId: view.service.id,
    parentServiceId: air.service.id,
    capabilityVersion: view.service.version,
    publicOperationIds,
    workflowDependencyOperationIds,
    capabilityHash,
    contractHash,
    ...(parentGatewayReceipt
      ? {
          parentGatewayImport: {
            importId: parentGatewayReceipt.importId,
            receiptDigest: parentGatewayReceipt.receiptDigest,
            receiptViewDigest: hashCanonical(parentGatewayReceipt),
            outputDigest: parentGatewayReceipt.output.digest,
            lineage: parentGatewayReceipt.lineage.status,
            blockerCount: parentGatewayReceipt.blockers.length,
          },
        }
      : {}),
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
  if (parentGatewayReceipt) {
    bundle.files["provenance/parent-gateway-import.receipt.json"] =
      `${JSON.stringify(parentGatewayReceipt, null, 2)}\n`;
  }
  bundle.files["bundle.json"] = `${JSON.stringify(manifest, null, 2)}\n`;
  return { view, manifest, bundle };
}
