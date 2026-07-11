/**
 * Layer 6 — semantic contract drift. `diffContracts` compares two AIR documents
 * (the stored contract vs a fresh in-memory recompile of the current spec) and
 * reports every *meaningful* difference as a typed DriftItem. This is a diff of
 * the CONTRACT, not of bytes: two specs that reorder keys produce no drift, and
 * a one-word description tweak is info-level, while a dropped confirmation is
 * blocking. Pure and deterministic — same inputs always yield the same items
 * with the same content-derived ids — so a drift record is reproducible
 * evidence, never a mood.
 *
 * Distinct from `semanticDiff` in @anvil/refinement, which renders the changes
 * a refinement pack *applied* to AIR; this module detects what an upstream
 * spec change *would mean* for an AIR that has not been touched.
 */
import { createHash } from "node:crypto";
import type { AirDocument, Operation } from "@anvil/air";
import { z } from "zod";

/* -------------------------------------------------------------------------- */
/* Model                                                                       */
/* -------------------------------------------------------------------------- */

/** Shared severity ladder (matches the refinement detectors' vocabulary). */
export const DriftSeverity = z.enum(["info", "low", "medium", "high", "blocking"]);
export type DriftSeverity = z.infer<typeof DriftSeverity>;

/** Highest first — the order reports group by. */
export const DRIFT_SEVERITY_ORDER: readonly DriftSeverity[] = [
  "blocking",
  "high",
  "medium",
  "low",
  "info",
];

export const DriftKind = z.enum([
  "operation_added",
  "operation_removed",
  "field_added",
  "field_removed",
  "field_type_changed",
  "field_requiredness_changed",
  "auth_changed",
  "idempotency_changed",
  "retry_changed",
  "confirmation_changed",
  "pagination_changed",
  "docs_changed",
]);
export type DriftKind = z.infer<typeof DriftKind>;

/**
 * One detected contract difference. `id` is a content-derived hash of the
 * item's coordinates (kind + operation + coordinate + facts) so identical drift
 * always carries the identical id; severity, message, and the affected
 * capabilities are *derived* from those coordinates and deliberately excluded
 * from the hash.
 */
export const DriftItem = z.object({
  id: z.string(),
  kind: DriftKind,
  severity: DriftSeverity,
  /** The touched operation (AIR operation id). */
  operationId: z.string(),
  /** Where inside the operation the drift sits, e.g. "input.body.amount". */
  coordinate: z.string(),
  /** Human explanation of what changed and why the severity. */
  message: z.string(),
  /** Machine facts — before/after values and any extra context. */
  facts: z.record(z.string(), z.unknown()).default({}),
  /**
   * Capabilities whose member set includes the touched operation. For added
   * operations this is the capability the new grouping would assign; for
   * changed operations it is the union of the old and new membership (a
   * grouping move affects both sides).
   */
  affectedCapabilityIds: z.array(z.string()).default([]),
});
export type DriftItem = z.infer<typeof DriftItem>;

/* -------------------------------------------------------------------------- */
/* Determinism helpers                                                         */
/* -------------------------------------------------------------------------- */

/** Recursively sort object keys so hashing never depends on insertion order. */
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

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

/** The stable, content-derived id of a drift item's coordinates. */
function driftId(
  kind: DriftKind,
  operationId: string,
  coordinate: string,
  facts: Record<string, unknown>,
): string {
  return sha256({ kind, operationId, coordinate, facts }).slice(0, 16);
}

/* -------------------------------------------------------------------------- */
/* Diff                                                                        */
/* -------------------------------------------------------------------------- */

/** Capabilities that list the operation as a member, in the given document. */
function capsContaining(air: AirDocument, operationId: string): string[] {
  return air.capabilities.filter((c) => c.operationIds.includes(operationId)).map((c) => c.id);
}

/** Deep-copy a JSON value with every `description` key removed, so schema
 * comparison sees structure and types — prose changes are docs drift. */
function stripDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripDescriptions);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "description") continue;
      out[k] = stripDescriptions(v);
    }
    return out;
  }
  return value;
}

/** Structural equality over canonical JSON. */
function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}

/** A minimal builder: derive the id, keep everything else as given. */
function item(
  kind: DriftKind,
  severity: DriftSeverity,
  operationId: string,
  coordinate: string,
  message: string,
  facts: Record<string, unknown>,
  affectedCapabilityIds: string[],
): DriftItem {
  return {
    id: driftId(kind, operationId, coordinate, facts),
    kind,
    severity,
    operationId,
    coordinate,
    message,
    facts,
    affectedCapabilityIds: [...new Set(affectedCapabilityIds)].sort(),
  };
}

/**
 * The one comparable "field" projection: non-body params keyed by location and
 * name, body fields keyed by name. Body fields are compared through the
 * `fields` projection (the agent-facing surface); a `whole`-projection body is
 * compared as one field named `body`.
 */
interface FieldView {
  coordinate: string;
  label: string;
  required: boolean;
  schema: unknown;
  description?: string;
}

function fieldViews(op: Operation): Map<string, FieldView> {
  const out = new Map<string, FieldView>();
  for (const p of op.input.params) {
    out.set(`param.${p.in}.${p.name}`, {
      coordinate: `input.param.${p.in}.${p.name}`,
      label: `${p.in} parameter '${p.name}'`,
      required: p.required,
      schema: p.schema,
      description: p.description,
    });
  }
  const body = op.input.body;
  if (body?.projection === "fields") {
    for (const f of body.fields) {
      out.set(`body.${f.name}`, {
        coordinate: `input.body.${f.name}`,
        label: `body field '${f.name}'`,
        required: f.required,
        schema: f.schema,
        description: f.description,
      });
    }
  } else if (body) {
    out.set("body", {
      coordinate: "input.body",
      label: "request body",
      required: body.required,
      schema: body.schema,
    });
  }
  return out;
}

/** True when a mode string means "no idempotency claimed". */
const noIdempotency = (mode: string): boolean => mode === "none";

/**
 * Diff two operations that exist on both sides. The severity policy is
 * asymmetric on purpose, mirroring the reconciler's trust rule: drift that
 * LOOSENS safety (a dropped confirmation, retries where there were none, an
 * idempotency claim appearing or vanishing, auth disappearing) is blocking;
 * other safety-semantic drift is high; interface-shape drift is medium/low;
 * prose is info.
 */
function diffOperation(before: Operation, after: Operation, caps: string[]): DriftItem[] {
  const items: DriftItem[] = [];
  const opId = before.id;

  // --- fields: type + requiredness + presence -----------------------------
  const beforeFields = fieldViews(before);
  const afterFields = fieldViews(after);
  for (const [key, b] of beforeFields) {
    const a = afterFields.get(key);
    if (!a) {
      items.push(
        item(
          "field_removed",
          "medium",
          opId,
          b.coordinate,
          `${b.label} was removed from the spec.`,
          { before: { required: b.required, schema: b.schema } },
          caps,
        ),
      );
      continue;
    }
    if (!sameJson(stripDescriptions(b.schema), stripDescriptions(a.schema))) {
      const t = (s: unknown) => (s as { type?: string })?.type ?? "unknown";
      items.push(
        item(
          "field_type_changed",
          "medium",
          opId,
          b.coordinate,
          `${b.label} changed type: ${t(b.schema)} → ${t(a.schema)}.`,
          { before: b.schema, after: a.schema },
          caps,
        ),
      );
    }
    if (b.required !== a.required) {
      // Becoming required breaks every existing caller that omits the field;
      // becoming optional merely relaxes the contract.
      items.push(
        item(
          "field_requiredness_changed",
          a.required ? "high" : "low",
          opId,
          b.coordinate,
          `${b.label} is now ${a.required ? "required (was optional — breaking)" : "optional (was required)"}.`,
          { before: b.required, after: a.required },
          caps,
        ),
      );
    }
  }
  for (const [key, a] of afterFields) {
    if (beforeFields.has(key)) continue;
    items.push(
      item(
        "field_added",
        a.required ? "medium" : "low",
        opId,
        a.coordinate,
        `${a.label} was added${a.required ? " and is required (breaking for stored inputs)" : ""}.`,
        { after: { required: a.required, schema: a.schema } },
        caps,
      ),
    );
  }

  // --- auth ----------------------------------------------------------------
  if (before.auth.type !== after.auth.type) {
    // Auth vanishing entirely is a loosened contract — blocking.
    items.push(
      item(
        "auth_changed",
        after.auth.type === "none" ? "blocking" : "high",
        opId,
        "auth.type",
        `Auth type changed: ${before.auth.type} → ${after.auth.type}.`,
        { before: before.auth.type, after: after.auth.type },
        caps,
      ),
    );
  }
  const beforeScopes = [...before.auth.scopes].sort();
  const afterScopes = [...after.auth.scopes].sort();
  if (!sameJson(beforeScopes, afterScopes)) {
    items.push(
      item(
        "auth_changed",
        "high",
        opId,
        "auth.scopes",
        `Auth scopes changed: [${beforeScopes.join(", ")}] → [${afterScopes.join(", ")}].`,
        { before: beforeScopes, after: afterScopes },
        caps,
      ),
    );
  }

  // --- idempotency ----------------------------------------------------------
  const bIdem = before.idempotency;
  const aIdem = after.idempotency;
  if (bIdem.mode !== aIdem.mode || bIdem.mechanism !== aIdem.mechanism || bIdem.key !== aIdem.key) {
    // Any transition across the "none" boundary changes what may be retried:
    // a new claim must be re-proven, and a lost claim means deployed artifacts
    // may still be retrying an unsafe mutation. Both are blocking.
    const crossesNone = noIdempotency(bIdem.mode) !== noIdempotency(aIdem.mode);
    items.push(
      item(
        "idempotency_changed",
        crossesNone ? "blocking" : "high",
        opId,
        "idempotency",
        `Idempotency changed: ${bIdem.mode}/${bIdem.mechanism} → ${aIdem.mode}/${aIdem.mechanism}.`,
        { before: bIdem, after: aIdem },
        caps,
      ),
    );
  }

  // --- retries ----------------------------------------------------------------
  const bRetry = before.retries;
  const aRetry = after.retries;
  if (
    bRetry.mode !== aRetry.mode ||
    bRetry.maxAttempts !== aRetry.maxAttempts ||
    !sameJson([...bRetry.retryOn].sort(), [...aRetry.retryOn].sort())
  ) {
    // Retries appearing where there were none is loosened safety — blocking.
    const loosened = bRetry.mode === "none" && aRetry.mode !== "none";
    items.push(
      item(
        "retry_changed",
        loosened ? "blocking" : "high",
        opId,
        "retries",
        `Retry policy changed: ${bRetry.mode}×${bRetry.maxAttempts} → ${aRetry.mode}×${aRetry.maxAttempts}.`,
        {
          before: { mode: bRetry.mode, maxAttempts: bRetry.maxAttempts, retryOn: bRetry.retryOn },
          after: { mode: aRetry.mode, maxAttempts: aRetry.maxAttempts, retryOn: aRetry.retryOn },
        },
        caps,
      ),
    );
  }

  // --- confirmation ------------------------------------------------------------
  if (before.confirmation.required !== after.confirmation.required) {
    items.push(
      item(
        "confirmation_changed",
        after.confirmation.required ? "high" : "blocking", // dropping the guard loosens safety
        opId,
        "confirmation.required",
        `Confirmation requirement ${after.confirmation.required ? "added" : "REMOVED"} (${before.confirmation.required} → ${after.confirmation.required}).`,
        { before: before.confirmation.required, after: after.confirmation.required },
        caps,
      ),
    );
  }

  // --- pagination -----------------------------------------------------------------
  if (!sameJson(before.pagination ?? null, after.pagination ?? null)) {
    items.push(
      item(
        "pagination_changed",
        "medium",
        opId,
        "pagination",
        `Pagination changed: ${before.pagination?.style ?? "none"} → ${after.pagination?.style ?? "none"}.`,
        { before: before.pagination ?? null, after: after.pagination ?? null },
        caps,
      ),
    );
  }

  // --- documentation-only ------------------------------------------------------------
  // Prose changes are collected into ONE info item per operation so a big
  // copy-edit does not drown the semantic drift above it.
  const docChanges: Record<string, { before?: string; after?: string }> = {};
  if (before.description !== after.description) {
    docChanges.description = { before: before.description, after: after.description };
  }
  if ((before.output.description ?? "") !== (after.output.description ?? "")) {
    docChanges["output.description"] = {
      before: before.output.description,
      after: after.output.description,
    };
  }
  for (const [key, b] of beforeFields) {
    const a = afterFields.get(key);
    if (a && (b.description ?? "") !== (a.description ?? "")) {
      docChanges[`${b.coordinate}.description`] = { before: b.description, after: a.description };
    }
  }
  if (Object.keys(docChanges).length > 0) {
    items.push(
      item(
        "docs_changed",
        "info",
        opId,
        "docs",
        `Documentation text changed (${Object.keys(docChanges).sort().join(", ")}).`,
        { changed: docChanges },
        caps,
      ),
    );
  }

  return items;
}

/**
 * The semantic contract diff. `before` is the stored AIR (the contract agents
 * currently hold); `after` is the fresh recompile of the current spec.
 * Operations are matched by their stable AIR id. Deterministic: items are
 * sorted by (operationId, kind, coordinate) and every id is content-derived.
 */
export function diffContracts(before: AirDocument, after: AirDocument): DriftItem[] {
  const beforeOps = new Map(before.operations.map((op) => [op.id, op]));
  const afterOps = new Map(after.operations.map((op) => [op.id, op]));
  const items: DriftItem[] = [];

  for (const [id, op] of beforeOps) {
    if (afterOps.has(id)) continue;
    // An operation vanishing from the spec strands every surface that exposes
    // it. If it was approved (agents can call it today) that is blocking.
    items.push(
      item(
        "operation_removed",
        op.state === "approved" ? "blocking" : "high",
        id,
        "operation",
        `Operation '${id}' (${op.cli.command}) was removed from the spec${op.state === "approved" ? " while approved and exposed" : ""}.`,
        { cli: op.cli.command, mcpTool: op.mcp.toolName, state: op.state },
        capsContaining(before, id),
      ),
    );
  }

  for (const [id, op] of afterOps) {
    if (beforeOps.has(id)) continue;
    // New surface is not dangerous by itself — it arrives unapproved — but it
    // is drift the owning capability's reviewers must see.
    items.push(
      item(
        "operation_added",
        "medium",
        id,
        "operation",
        `Operation '${id}' (${op.cli.command}) is new in the spec (arrives unapproved).`,
        { cli: op.cli.command, mcpTool: op.mcp.toolName, effect: op.effect.kind },
        capsContaining(after, id),
      ),
    );
  }

  for (const [id, b] of beforeOps) {
    const a = afterOps.get(id);
    if (!a) continue;
    const caps = [...capsContaining(before, id), ...capsContaining(after, id)];
    items.push(...diffOperation(b, a, caps));
  }

  return items.sort(
    (x, y) =>
      x.operationId.localeCompare(y.operationId) ||
      x.kind.localeCompare(y.kind) ||
      x.coordinate.localeCompare(y.coordinate),
  );
}

/** Union of every item's affected capabilities (sorted, deduped). */
export function affectedCapabilities(items: DriftItem[]): string[] {
  return [...new Set(items.flatMap((i) => i.affectedCapabilityIds))].sort();
}

/* -------------------------------------------------------------------------- */
/* Certification invalidation                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A structural view of a stored certification — just what invalidation needs.
 * Kept structural (not the @anvil/generators `Certification` type) because the
 * compiler must never depend on the generator foundry; the CLI adapts real
 * certification.json records into this shape.
 */
export interface CertificationRef {
  /** Where the record lives, relative to the bundle dir. */
  path: string;
  /** The capability the cert judges; absent for a whole-service cert. */
  capabilityId?: string;
  status: string;
}

export interface CertificationImpact {
  ref: CertificationRef;
  /** The drift item ids that invalidate this certification. */
  invalidatedBy: string[];
}

/**
 * The SEMANTIC recertification verdict. Certification is already hash-bound
 * (stale bytes fail `verifyCertification`); this layer answers the different
 * question "does this drift touch what capability X was certified *about*?"
 * — so X's cert must be re-earned even when its own bundle bytes are
 * untouched. Docs-only (info) drift never forces recertification: no gate
 * judges prose. A capability-scoped cert is invalidated only by drift whose
 * affected capabilities include it; a whole-service cert is invalidated by any
 * non-info drift (its subject is the whole surface).
 */
export function invalidatedCertifications(
  items: DriftItem[],
  certifications: CertificationRef[],
): CertificationImpact[] {
  const material = items.filter((i) => i.severity !== "info");
  const impacts: CertificationImpact[] = [];
  for (const ref of certifications) {
    const invalidatedBy = material
      .filter((i) =>
        ref.capabilityId === undefined ? true : i.affectedCapabilityIds.includes(ref.capabilityId),
      )
      .map((i) => i.id)
      .sort();
    if (invalidatedBy.length > 0) impacts.push({ ref, invalidatedBy });
  }
  return impacts;
}

/* -------------------------------------------------------------------------- */
/* Drift records                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The stored record `anvil sync` writes under `.anvil/drift/<id>.json` and
 * `anvil drift` reads back. Bookkeeping only: accepting a record marks it
 * reviewed; it never changes AIR, snapshots, or certifications.
 */
export const DriftRecord = z.object({
  schemaVersion: z.literal(1),
  /** Content-derived (service + hashes + item ids) — see `driftRecordId`. */
  id: z.string(),
  serviceId: z.string(),
  /** The spec path the sync re-imported. */
  sourceUri: z.string(),
  /** The locked snapshot the drift was computed from. */
  snapshotId: z.string(),
  previousSourceHash: z.string().optional(),
  sourceHash: z.string(),
  /** The stored bundle the fresh compile was diffed against. */
  bundleDir: z.string(),
  /** Provenance only — never part of the id. */
  detectedAt: z.string(),
  items: z.array(DriftItem),
  affectedCapabilityIds: z.array(z.string()),
  invalidatedCertifications: z.array(
    z.object({
      path: z.string(),
      capabilityId: z.string().optional(),
      status: z.string(),
      invalidatedBy: z.array(z.string()),
    }),
  ),
  /** Set by `anvil drift accept` — review bookkeeping, nothing else. */
  reviewedAt: z.string().optional(),
  reviewNote: z.string().optional(),
});
export type DriftRecord = z.infer<typeof DriftRecord>;

/**
 * Content-derived record id: the same service drifting the same way between
 * the same source hashes always lands in the same record slot, so re-running
 * `anvil sync` never multiplies records for one unchanged situation.
 */
export function driftRecordId(input: {
  serviceId: string;
  sourceHash: string;
  previousSourceHash?: string;
  itemIds: string[];
}): string {
  const hash = sha256({
    serviceId: input.serviceId,
    sourceHash: input.sourceHash,
    previousSourceHash: input.previousSourceHash ?? null,
    itemIds: [...input.itemIds].sort(),
  });
  return `${input.serviceId}-${hash.slice(0, 12)}`;
}
