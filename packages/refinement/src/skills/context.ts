import type { AirDocument, Claim, Operation } from "@anvil/air";
import type { Deficiency } from "../deficiency.js";
import type { FieldContext, SkillContext } from "./contract.js";

/** All surfaced input fields of an operation, as read-only field contexts. */
function fieldsOf(op: Operation): FieldContext[] {
  const out: FieldContext[] = [];
  for (const p of op.input.params) {
    const e = p.schema.enum;
    out.push({
      path: `input.params.${p.name}`,
      name: p.name,
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
    return ctx;
  }

  const opId =
    t.kind === "operation" || t.kind === "field" || t.kind === "enum" || t.kind === "error"
      ? t.operationId
      : undefined;
  if (!opId) return ctx;

  const op = air.operations.find((o) => o.id === opId);
  if (!op) return ctx;
  ctx.operation = op;
  if (op.capabilityId) ctx.capability = air.capabilities.find((c) => c.id === op.capabilityId);

  if (t.kind === "field" || t.kind === "enum") {
    const all = fieldsOf(op);
    ctx.field = all.find((f) => f.path === t.path);
    ctx.siblingFields = all.filter((f) => f.path !== t.path);
  } else if (t.kind === "error") {
    ctx.errorSpec = op.errors.find((e) => e.code === t.code);
  }
  return ctx;
}
