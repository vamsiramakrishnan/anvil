import type { AirDocument, BodyField, Capability, ErrorSpec, Operation, Param } from "@anvil/air";
import type { JsonValue, SemanticPatch } from "./skills/contract.js";
import { describeTarget, type SemanticTarget } from "./target.js";
import { singularize } from "./vocabulary.js";

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
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    changes.push({ target: patch.target, key, before, after });
  };

  // `pagination_style` must apply before the other pagination keys: it is the
  // only key allowed to create `op.pagination` (the rest refuse to fabricate a
  // style that was never proposed), and a proposal's key order is not a contract.
  const entries = Object.entries(patch.set).sort(
    (a, b) => Number(b[0] === "pagination_style") - Number(a[0] === "pagination_style"),
  );
  for (const [key, value] of entries) {
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
      const op = findOperation(air, target.operationId);
      if (!op) return;
      if (key === "description") {
        record(key, op.description, value);
        op.description = String(value);
        return;
      }
      // Routing names are one semantic projection. `rename-operation` always
      // proposes all three, and this is the only write path allowed to move
      // them. The stable operation id deliberately remains unchanged.
      if (key === "canonical_name") {
        record(key, op.canonicalName, value);
        op.canonicalName = String(value);
        return;
      }
      if (key === "cli_command") {
        record(key, op.cli.command, value);
        op.cli.command = String(value);
        return;
      }
      if (key === "tool_name") {
        record(key, op.mcp.toolName, value);
        op.mcp.toolName = String(value);
        return;
      }
      // Sole write path for `rehome-resource` — validated upstream (the
      // proposed word must be grounded in the operation's own path or name
      // vocabulary) and ALWAYS review-tier (approval.ts checks the key). The
      // write mirrors the manifest `name: { resource }` override's
      // `effect.resource` assignment (compiler manifest.ts, singularized the
      // same way); the three routing names are deliberately NOT touched here —
      // in this deficiency the vendor's own name is the evidence, and the
      // durable, id-projecting closure is the manifest override recompiled
      // through `projectRoutingNames`.
      if (key === "resource") {
        const next = singularize(String(value));
        record(key, op.effect.resource, next);
        op.effect.resource = next;
        return;
      }
      // The idempotency carrier and retry-basis keys below are the sole write
      // path for `classify-idempotency` — validated upstream (proposal
      // validation resolves the carrier; the heuristic executor only ever
      // proposes an admissible enum member), so this layer trusts the value
      // the same way `description`/`retryable` already do.
      if (key === "idempotency_mode") {
        record(key, op.idempotency.mode, value);
        op.idempotency.mode = value as Operation["idempotency"]["mode"];
        return;
      }
      if (key === "idempotency_mechanism") {
        record(key, op.idempotency.mechanism, value);
        op.idempotency.mechanism = value as Operation["idempotency"]["mechanism"];
        return;
      }
      if (key === "idempotency_key") {
        record(key, op.idempotency.key, value);
        op.idempotency.key = String(value);
        return;
      }
      if (key === "idempotency_key_derivation") {
        record(key, op.idempotency.keyDerivation, value);
        op.idempotency.keyDerivation = value as Operation["idempotency"]["keyDerivation"];
        return;
      }
      if (key === "retry_basis") {
        record(key, op.retries.basis, value);
        op.retries.basis = value as Operation["retries"]["basis"];
        return;
      }
      // Sole write path for `author-intent-examples` — validated upstream
      // (boundary + grounding); templated from spec semantics, never invented.
      if (key === "intent_examples" && Array.isArray(value)) {
        record(key, op.skill.intentExamples, value);
        op.skill.intentExamples = value.map((v) => String(v));
        return;
      }
      // Sole write path for `review-query-passthrough`. Recording a policy is the
      // reviewable unblock: it lifts an unguarded (blocked) passthrough to
      // review_required — never to approved. A human still signs off.
      if (key === "query_policy" && value && typeof value === "object") {
        record(key, op.queryPolicy, value);
        op.queryPolicy = value as typeof op.queryPolicy;
        if (op.state === "blocked") op.state = "review_required";
        return;
      }
      // The pagination carrier keys below are the sole write path for
      // `document-pagination` — validated upstream (pagination binding resolves).
      // Only `pagination_style` may create `op.pagination`: fabricating a default
      // style to anchor a field-only patch would invent a business fact no
      // evidence claimed. Field-only patches on a style-less operation are
      // rejected by validation; if one slips through, skip rather than invent.
      if (key === "pagination_style") {
        record(key, op.pagination?.style, value);
        if (op.pagination) {
          op.pagination.style = value as never;
        } else {
          op.pagination = { style: value as never };
        }
        return;
      }
      if (key === "pagination_cursor_param") {
        if (!op.pagination) return;
        record(key, op.pagination.cursorParam, value);
        op.pagination.cursorParam = String(value);
        return;
      }
      if (key === "pagination_next_field") {
        if (!op.pagination) return;
        record(key, op.pagination.nextField, value);
        op.pagination.nextField = String(value);
        return;
      }
      if (key === "pagination_items_field") {
        if (!op.pagination) return;
        record(key, op.pagination.itemsField, value);
        op.pagination.itemsField = String(value);
        return;
      }
      if (key === "pagination_page_size_param") {
        if (!op.pagination) return;
        record(key, op.pagination.pageSizeParam, value);
        op.pagination.pageSizeParam = String(value);
        return;
      }
      if (key === "pagination_max_page_size") {
        if (!op.pagination) return;
        record(key, op.pagination.maxPageSize, value);
        op.pagination.maxPageSize = Number(value);
        return;
      }
      if (key === "pagination_default_page_size") {
        if (!op.pagination) return;
        record(key, op.pagination.defaultPageSize, value);
        op.pagination.defaultPageSize = Number(value);
        return;
      }
      if (key === "response_projection" && value && typeof value === "object") {
        record(key, op.output.agentProjection, value);
        op.output.agentProjection = value as Operation["output"]["agentProjection"];
        return;
      }
      return;
    }
    case "capability": {
      const cap = findCapability(air, target.capabilityId);
      if (!cap) return;
      if (key === "description") {
        record(key, cap.description, value);
        cap.description = String(value);
        return;
      }
      // Sole write path for `author-routing-phrases` — validated upstream.
      if (key === "intent_examples" && Array.isArray(value)) {
        record(key, cap.intentExamples, value);
        cap.intentExamples = value.map((v) => String(v));
        return;
      }
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
      if (key === "agent_name") {
        record(key, node.agentName, value);
        node.agentName = String(value);
        return;
      }
      if (key === "aliases" && Array.isArray(value)) {
        record(key, node.aliases, value);
        node.aliases = value.map((alias) => String(alias));
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
      if (key === "upstream_code") {
        const upstream = spec.upstream ?? {};
        record(key, upstream.code, value);
        spec.upstream = { ...upstream, code: String(value) };
        return;
      }
      if (key === "recovery_action") {
        const recovery = spec.recovery ?? { action: "" };
        record(key, recovery.action, value);
        spec.recovery = { ...recovery, action: String(value) };
        return;
      }
      if (key === "field_path") {
        const recovery = spec.recovery ?? { action: "Review the invalid field and retry." };
        record(key, recovery.fieldPath, value);
        spec.recovery = { ...recovery, fieldPath: String(value) };
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
