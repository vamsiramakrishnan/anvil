import { type AirDocument, agentPropKey } from "@anvil/air";
import { type Deficiency, makeDeficiency } from "../deficiency.js";
import { surfacedFields } from "../fields.js";

const WEAK_FIELD_NAMES = new Set([
  "arg",
  "data",
  "field",
  "obj",
  "object",
  "param",
  "str",
  "tmp",
  "val",
  "value",
]);
const UNIT_BEARING_NAMES = /(?:^|_)(timeout|duration|interval|ttl|delay|period|age)(?:_|$)/i;
const UNIT_IN_NAME = /(?:^|_)(ms|milliseconds?|seconds?|minutes?|hours?|days?)(?:_|$)/i;
const UNIT_SIGNAL =
  /\b(ms|millisecond|milliseconds|second|seconds|minute|minutes|hour|hours|day|days)\b/i;

/** Conservative field-name findings that never reinterpret the wire coordinate. */
export function detectFieldNames(air: AirDocument): Deficiency[] {
  const out: Deficiency[] = [];
  for (const operation of air.operations) {
    for (const field of surfacedFields(operation)) {
      const publicName = field.agentName ?? field.name;
      const normalized = agentPropKey({ name: field.name, agentName: field.agentName });
      if (WEAK_FIELD_NAMES.has(normalized) || (/^[a-z]$/.test(normalized) && normalized !== "q")) {
        out.push(
          makeDeficiency(
            "weak_field_name",
            { kind: "field", operationId: operation.id, path: field.path },
            `Field '${publicName}' has no clear agent-facing name.`,
            { wireName: field.name, existingAgentName: field.agentName ?? null },
          ),
        );
      }
      const numeric = field.schema.type === "integer" || field.schema.type === "number";
      if (
        numeric &&
        UNIT_BEARING_NAMES.test(normalized) &&
        !UNIT_IN_NAME.test(normalized) &&
        !UNIT_SIGNAL.test(field.description ?? "")
      ) {
        out.push(
          makeDeficiency(
            "unit_ambiguous_field",
            { kind: "field", operationId: operation.id, path: field.path },
            `Numeric field '${publicName}' does not state its unit in its name or description.`,
            {
              wireName: field.name,
              existingAgentName: field.agentName ?? null,
              schemaType: field.schema.type,
            },
          ),
        );
      }
    }
  }
  return out;
}
