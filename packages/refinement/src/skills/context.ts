import type { AirDocument, Claim, Operation } from "@anvil/air";
import { benchmarkOperations } from "../benchmark/routing.js";
import type { Deficiency } from "../deficiency.js";
import { targetKey, targetOperationId } from "../target.js";
import type { FieldContext, SkillContext } from "./contract.js";
import { groupGrantOf } from "./group-proposal.js";

/** All surfaced input fields of an operation, as read-only field contexts. */
function fieldsOf(op: Operation): FieldContext[] {
  const out: FieldContext[] = [];
  for (const p of op.input.params) {
    const e = p.schema.enum;
    out.push({
      path: `input.params.${p.name}`,
      name: p.name,
      agentName: p.agentName,
      aliases: p.aliases ?? [],
      required: p.required,
      schema: p.schema,
      description: p.description,
      enumValues: Array.isArray(e) ? e : undefined,
      example: p.example,
    });
  }
  const body = op.input.body;
  if (body && body.projection === "fields") {
    for (const f of body.fields) {
      const e = f.schema.enum;
      out.push({
        path: `input.body.${f.name}`,
        name: f.name,
        agentName: f.agentName,
        aliases: f.aliases ?? [],
        required: f.required,
        schema: f.schema,
        description: f.description,
        enumValues: Array.isArray(e) ? e : undefined,
        example: undefined,
      });
    }
  }
  return out;
}

/**
 * The evidence AIR already holds for a deficiency's target — the owning node's
 * active claims, scoped to those actually about this target. A claim is in scope
 * when it is unsubjected, or its `subject` names the target (its key, the
 * operation, the field path, the error code, or the capability). Scoping keeps a
 * sibling field's description evidence from leaking onto the field next to it.
 * This is the evidence a fresh case starts from before the executor gathers more.
 */
export function evidenceForTarget(air: AirDocument, deficiency: Deficiency): Claim[] {
  const t = deficiency.target;
  const opId = targetOperationId(t);
  let claims: Claim[] = [];
  if (opId) claims = air.operations.find((o) => o.id === opId)?.evidence.claims ?? [];
  else if (t.kind === "capability")
    claims = air.capabilities.find((c) => c.id === t.capabilityId)?.evidence.claims ?? [];

  const keys = new Set<string>([targetKey(t)]);
  if (opId) keys.add(opId);
  if (t.kind === "field" || t.kind === "enum") keys.add(t.path);
  if (t.kind === "error") keys.add(t.code);
  if (t.kind === "capability") keys.add(t.capabilityId);
  return claims.filter((c) => !c.subject || keys.has(c.subject));
}

/**
 * Assemble the context a skill needs for one deficiency from AIR plus the
 * evidence already gathered for its target. This is the only place AIR is read
 * on a skill's behalf — the executor then works purely from the returned context,
 * so a run can be replayed from its context alone.
 */
export function assembleContext(
  air: AirDocument,
  deficiency: Deficiency,
  evidence: Claim[] = [],
): SkillContext {
  const ctx: SkillContext = { deficiency, target: deficiency.target, evidence };
  const t = deficiency.target;

  if (t.kind === "capability") {
    ctx.capability = air.capabilities.find((c) => c.id === t.capabilityId);
    // Every capability in the document is a candidate landing spot for an
    // authored routing phrase — see `intent_routes_to_own_tool`. Capabilities
    // carry no approval gate of their own (only `lifecycle`), so unlike the
    // operation catalog below there is no "served vs. not" filter to apply.
    ctx.routingCatalogCapabilities = air.capabilities;
    return structuredClone(ctx);
  }

  if (t.kind === "group") {
    // The grant (member + explicitly-listed related operation ids) rides in the
    // deficiency's facts, hash-bound into the exported task. The OPERATIONS are
    // rebuilt from current AIR here — the task's snapshot helps the harness
    // investigate, but validation only ever grounds against the document.
    const grant = groupGrantOf(deficiency.facts);
    const wanted = [...grant.memberOperationIds, ...grant.relatedOperationIds];
    ctx.groupOperations = wanted
      .map((id) => air.operations.find((op) => op.id === id))
      .filter((op): op is Operation => op !== undefined);
    return structuredClone(ctx);
  }

  const opId =
    t.kind === "operation" || t.kind === "field" || t.kind === "enum" || t.kind === "error"
      ? t.operationId
      : undefined;
  if (!opId) return structuredClone(ctx);

  const op = air.operations.find((o) => o.id === opId);
  if (!op) return structuredClone(ctx);
  ctx.operation = op;
  if (op.capabilityId) ctx.capability = air.capabilities.find((c) => c.id === op.capabilityId);

  if (t.kind === "operation") {
    // The narrow, proactive hint (same resource or capability, excluding
    // self): a harness authoring an intent phrase can see these to avoid a
    // likely collision before it is ever proposed.
    ctx.siblingOperations = air.operations.filter(
      (sibling) =>
        sibling.id !== op.id &&
        ((op.capabilityId !== undefined && sibling.capabilityId === op.capabilityId) ||
          (op.effect.resource !== undefined && sibling.effect.resource === op.effect.resource)),
    );
    // The mandatory routing catalog `intent_routes_to_own_tool` checks against:
    // the served surface plus the target itself. The target is included even
    // when it is not yet approved (`operation_lacks_intent_examples` fires
    // regardless of approval state, and a real live loop found this exact
    // collision on operations approved together, before any of them had
    // shipped intent examples) — a phrase must not collide with a sibling
    // regardless of which of the two is approved first.
    const served = benchmarkOperations(air);
    const byId = new Map(served.map((o) => [o.id, o]));
    byId.set(op.id, op);
    ctx.routingCatalogOperations = [...byId.values()];
  } else if (t.kind === "field" || t.kind === "enum") {
    const all = fieldsOf(op);
    ctx.field = all.find((f) => f.path === t.path);
    ctx.siblingFields = all.filter((f) => f.path !== t.path);
  } else if (t.kind === "error") {
    ctx.errorSpec = op.errors.find((e) => e.code === t.code);
  }
  // Detach every schema, claim, and AIR node from the canonical document. An
  // executor can inspect or even mutate its context without changing AIR.
  return structuredClone(ctx);
}
