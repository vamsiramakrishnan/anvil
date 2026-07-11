/**
 * Surface signatures — the compatibility fingerprint every surface shares.
 *
 * The signature is derived from the *contract* (AIR operations), not from any one
 * surface, so an MCP server, a CLI, a skill, and a simulator that all project the
 * same operations produce the *same* signature. `operationInputSchema` is the one
 * shape the MCP tool `inputSchema`, `cli --schema`, and the skill already share,
 * so the input digest is genuinely cross-surface.
 */
import { type AirDocument, hashCanonical, type Operation, operationInputSchema } from "@anvil/air";
import type {
  CompatibilityClass,
  CompatibilityReport,
  SurfaceChange,
  SurfaceOperationSignature,
  SurfaceSignature,
} from "./model.js";

/** The safety posture that a compatibility check treats as safety-sensitive. */
function effectShape(op: Operation) {
  return {
    kind: op.effect.kind,
    action: op.effect.action,
    risk: op.effect.risk,
    reversible: op.effect.reversible,
    idempotency: op.idempotency,
    retries: { mode: op.retries.mode, basis: op.retries.basis },
    confirmation: { required: op.confirmation.required },
  };
}

/** The per-operation signature: public name + the digests that define its surface. */
export function operationSignature(op: Operation): SurfaceOperationSignature {
  return {
    id: op.id,
    publicName: op.mcp.toolName,
    inputSchemaDigest: hashCanonical(op.input.schema ?? operationInputSchema(op)),
    outputSchemaDigest: hashCanonical(op.output.schema ?? {}),
    errorSchemaDigest: hashCanonical([...op.errors].sort((a, b) => a.code.localeCompare(b.code))),
    effectDigest: hashCanonical(effectShape(op)),
    authDigest: hashCanonical(op.auth),
  };
}

/**
 * Build a surface signature for a capability (or the whole service when
 * `capabilityId` is omitted). Only `approved` operations count — an unapproved
 * op is not on any public surface, so it must not be in the signature. Operations
 * are sorted by id for a stable, order-independent digest.
 */
export function surfaceSignatureFor(air: AirDocument, capabilityId?: string): SurfaceSignature {
  const memberIds = capabilityId
    ? new Set(air.capabilities.find((c) => c.id === capabilityId)?.operationIds ?? [])
    : undefined;
  const operations = air.operations
    .filter((op) => op.state === "approved")
    .filter((op) => !memberIds || memberIds.has(op.id))
    .map(operationSignature)
    .sort((a, b) => a.id.localeCompare(b.id));

  const digest = hashCanonical({ capabilityId: capabilityId ?? air.service.id, operations });
  return {
    schemaVersion: 1,
    capabilityId: capabilityId ?? air.service.id,
    version: air.service.version,
    operations,
    digest,
  };
}

const RANK: Record<CompatibilityClass, number> = {
  compatible: 0,
  additive: 1,
  breaking: 2,
  "safety-sensitive": 3,
};

function worst(a: CompatibilityClass, b: CompatibilityClass): CompatibilityClass {
  return RANK[a] >= RANK[b] ? a : b;
}

/**
 * Classify a change between two versions of one operation's signature. Auth or
 * effect (safety-posture) changes are **safety-sensitive**; an input-schema or
 * public-name change is **breaking**; output/error widening is **additive**.
 */
function classifyChanged(
  prev: SurfaceOperationSignature,
  next: SurfaceOperationSignature,
): { fields: string[]; classification: CompatibilityClass } {
  const fields: string[] = [];
  let cls: CompatibilityClass = "compatible";
  if (prev.authDigest !== next.authDigest) {
    fields.push("auth");
    cls = worst(cls, "safety-sensitive");
  }
  if (prev.effectDigest !== next.effectDigest) {
    fields.push("effect");
    cls = worst(cls, "safety-sensitive");
  }
  if (prev.publicName !== next.publicName) {
    fields.push("publicName");
    cls = worst(cls, "breaking");
  }
  if (prev.inputSchemaDigest !== next.inputSchemaDigest) {
    fields.push("input");
    cls = worst(cls, "breaking");
  }
  if (prev.outputSchemaDigest !== next.outputSchemaDigest) {
    fields.push("output");
    cls = worst(cls, "additive");
  }
  if (prev.errorSchemaDigest !== next.errorSchemaDigest) {
    fields.push("errors");
    cls = worst(cls, "additive");
  }
  return { fields, classification: cls };
}

/**
 * Compare two surface signatures. A removed operation is breaking; an added one
 * is additive; a changed one is classified per field. The overall classification
 * is the worst individual change (`compatible` when identical).
 */
export function diffSurfaceSignature(
  prev: SurfaceSignature,
  next: SurfaceSignature,
): CompatibilityReport {
  const prevById = new Map(prev.operations.map((o) => [o.id, o]));
  const nextById = new Map(next.operations.map((o) => [o.id, o]));
  const changes: SurfaceChange[] = [];

  for (const [id, op] of nextById) {
    const before = prevById.get(id);
    if (!before) {
      changes.push({ operationId: id, change: "added", fields: [], classification: "additive" });
      continue;
    }
    const { fields, classification } = classifyChanged(before, op);
    if (fields.length > 0)
      changes.push({ operationId: id, change: "changed", fields, classification });
  }
  for (const [id] of prevById) {
    if (!nextById.has(id)) {
      changes.push({ operationId: id, change: "removed", fields: [], classification: "breaking" });
    }
  }
  changes.sort((a, b) => a.operationId.localeCompare(b.operationId));

  const classification = changes.reduce<CompatibilityClass>(
    (acc, c) => worst(acc, c.classification),
    "compatible",
  );
  return { classification, changes };
}
