/**
 * The simulator's opt-in value validation (`SimulatorOptions.validateValues`,
 * `anvil simulate serve --validate-values`): a call must carry every required
 * input (`missingRequired`), and each value it carries must satisfy the schema
 * the operation declares for it. The schema is the one AIR records, the same
 * one the MCP server publishes and validates against. It is off by default
 * because vendor contracts often mark as required what the service does not
 * need, and the simulator must not be stricter than the service.
 */
import {
  agentPropKey,
  type JsonSchema,
  materializeSchemaBranches,
  type Operation,
} from "@anvil/air";
import { z } from "zod";
import { missingRequired } from "./provider.js";

const validators = new WeakMap<object, z.ZodType | null>();

/**
 * The validator for one declared schema, or `null` when the schema is not one
 * the converter can read (a truncated stub, say): an input the simulator
 * cannot judge is left to the provider rather than refused.
 */
function validatorFor(schema: JsonSchema): z.ZodType | null {
  const cached = validators.get(schema);
  if (cached !== undefined) return cached;
  let validator: z.ZodType | null;
  try {
    validator = z.fromJSONSchema(
      materializeSchemaBranches(schema) as Parameters<typeof z.fromJSONSchema>[0],
    );
  } catch {
    validator = null;
  }
  validators.set(schema, validator);
  return validator;
}

function mismatch(label: string, schema: JsonSchema | undefined, value: unknown) {
  if (!schema || value === undefined || value === null) return undefined;
  const result = validatorFor(schema)?.safeParse(value);
  if (!result || result.success) return undefined;
  const issue = result.error.issues[0];
  const at = issue && issue.path.length > 0 ? ` at '${issue.path.join(".")}'` : "";
  return `${label} does not match its declared schema${at}: ${issue?.message ?? "invalid"}.`;
}

/** A body schema whose page-size property has no ceiling, for the same reason. */
function withoutCeiling(schema: JsonSchema, pageSize: string | undefined): JsonSchema {
  const props = schema.properties as Record<string, JsonSchema> | undefined;
  const prop = pageSize === undefined ? undefined : props?.[pageSize];
  if (!pageSize || !prop || prop.maximum === undefined) return schema;
  const { maximum: _ceiling, ...uncapped } = prop;
  return { ...schema, properties: { ...props, [pageSize]: uncapped } };
}

/** The first reason the call's input is not one the operation accepts; `undefined` when valid. */
export function invalidRequest(op: Operation, input: Record<string, unknown>): string | undefined {
  const missing = missingRequired(op, input);
  if (missing) return missing;
  // A page size past the declared maximum is clamped, not refused: that is
  // the paging contract the simulator serves (`normalizeRequest`).
  const pageSize = op.pagination?.pageSizeParam;
  for (const p of op.input.params) {
    if (p.name === pageSize) continue;
    const bad = mismatch(`Parameter '${p.name}'`, p.schema, input[agentPropKey(p)]);
    if (bad) return bad;
  }
  const body = op.input.body;
  if (!body) return undefined;
  if (body.projection !== "fields") {
    return mismatch("Request body", withoutCeiling(body.schema, pageSize), input.body);
  }
  for (const f of body.fields) {
    if (f.name === pageSize) continue;
    const bad = mismatch(`Body field '${f.name}'`, f.schema, input[agentPropKey(f)]);
    if (bad) return bad;
  }
  return undefined;
}
