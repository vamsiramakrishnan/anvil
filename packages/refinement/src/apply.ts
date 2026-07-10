import type { AirDocument, BodyField, Capability, ErrorSpec, Operation, Param } from "@anvil/air";
import type { JsonValue, SemanticPatch } from "./skills/contract.js";
import { describeTarget, type SemanticTarget } from "./target.js";

/**
 * This module is the ONLY place a refinement proposal touches canonical AIR.
 * Everything upstream (detectors, skills, validation) works with `SemanticTarget`
 * coordinates and `SemanticPatch` values; here — and only here — those coordinates
 * are resolved to a real node and written. Keeping the write path this narrow is
 * what makes "the agent stopped guessing" auditable: every mutation is a located,
 * recorded `SemanticChange`, never a free-form edit.
 */

/** One located, recorded write: what target/key changed, and its before/after value. */
export interface SemanticChange {
  target: SemanticTarget;
  key: string;
  before: unknown;
  after: unknown;
}

/** The result of applying one or more patches: a new document, never the input. */
export interface ApplyResult {
  air: AirDocument;
  changes: SemanticChange[];
}

/** Split a field/enum target's path (`input.params.<name>` | `input.body.<name>`) into its parts. */
function splitFieldPath(path: string): { section: "params" | "body"; name: string } | undefined {
  const parts = path.split(".");
  if (parts.length !== 3 || parts[0] !== "input") return undefined;
  const section = parts[1];
  const name = parts[2];
  if ((section !== "params" && section !== "body") || !name) return undefined;
  return { section, name };
}

/** Find the operation a field/enum/error target refers to. */
function findOperation(air: AirDocument, operationId: string): Operation | undefined {
  return air.operations.find((op) => op.id === operationId);
}

/** Find the `Param` or `BodyField` node a field/enum target addresses, if it exists. */
function findFieldNode(
  air: AirDocument,
  target: SemanticTarget & { kind: "field" | "enum" },
): Param | BodyField | undefined {
  const op = findOperation(air, target.operationId);
  if (!op) return undefined;
  const parsed = splitFieldPath(target.path);
  if (!parsed) return undefined;
  if (parsed.section === "params") {
    return op.input.params.find((p) => p.name === parsed.name);
  }
  // Body fields only exist as addressable nodes under the "fields" projection.
  if (op.input.body?.projection !== "fields") return undefined;
  return op.input.body.fields.find((f) => f.name === parsed.name);
}

/** Find the capability a capability target addresses, if it exists. */
function findCapability(air: AirDocument, capabilityId: string): Capability | undefined {
  return air.capabilities.find((c) => c.id === capabilityId);
}

/** Find the error spec an error target addresses, if it exists. */
function findErrorSpec(
  air: AirDocument,
  target: SemanticTarget & { kind: "error" },
): ErrorSpec | undefined {
  const op = findOperation(air, target.operationId);
  return op?.errors.find((e) => e.code === target.code);
}

/**
 * Apply one semantic patch to a clone of `air`, returning the new document and the
 * changes actually made. Never mutates `air`. Any target/key that cannot be
 * located is skipped silently — a refinement is not allowed to throw the compiler
 * off a valid document just because one proposal has gone stale.
 */
export function applyPatch(air: AirDocument, patch: SemanticPatch): ApplyResult {
  const next: AirDocument = structuredClone(air);
  const changes: SemanticChange[] = [];
  const record = (key: string, before: unknown, after: unknown): void => {
    changes.push({ target: patch.target, key, before, after });
  };

  for (const [key, value] of Object.entries(patch.set)) {
    applyOne(next, patch.target, key, value, record);
  }

  return { air: next, changes };
}

function applyOne(
  air: AirDocument,
  target: SemanticTarget,
  key: string,
  value: JsonValue,
  record: (key: string, before: unknown, after: unknown) => void,
): void {
  switch (target.kind) {
    case "operation": {
      if (key !== "description") return;
      const op = findOperation(air, target.operationId);
      if (!op) return;
      record(key, op.description, value);
      op.description = String(value);
      return;
    }
    case "capability": {
      if (key !== "description") return;
      const cap = findCapability(air, target.capabilityId);
      if (!cap) return;
      record(key, cap.description, value);
      cap.description = String(value);
      return;
    }
    case "field":
    case "enum": {
      const node = findFieldNode(air, target);
      if (!node) return;
      if (key === "description") {
        record(key, node.description, value);
        node.description = String(value);
        return;
      }
      if (key === "examples") {
        record(key, node.schema.examples, value);
        node.schema.examples = value;
        return;
      }
      return;
    }
    case "error": {
      const spec = findErrorSpec(air, target);
      if (!spec) return;
      if (key === "message") {
        record(key, spec.message, value);
        spec.message = String(value);
        return;
      }
      if (key === "retryable") {
        record(key, spec.retryable, Boolean(value));
        spec.retryable = Boolean(value);
        return;
      }
      return;
    }
    case "service":
    case "workflow":
      // No writable keys are defined for these target kinds yet.
      return;
  }
}

/**
 * Fold `applyPatch` across a list of patches, threading the resulting document
 * forward so later patches see earlier ones — matching how a plan's fixes are
 * meant to compose into one coherent revision.
 */
export function applyPatches(air: AirDocument, patches: SemanticPatch[]): ApplyResult {
  let current = air;
  const changes: SemanticChange[] = [];
  for (const patch of patches) {
    const result = applyPatch(current, patch);
    current = result.air;
    changes.push(...result.changes);
  }
  return { air: current, changes };
}

/** Render a human-readable, one-line-per-change semantic diff. */
export function semanticDiff(changes: SemanticChange[]): string {
  if (changes.length === 0) return "(no changes)";
  return changes
    .map(
      (c) =>
        `${describeTarget(c.target)} .${c.key}: ${JSON.stringify(c.before)} → ${JSON.stringify(c.after)}`,
    )
    .join("\n");
}
