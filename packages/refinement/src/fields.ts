import type { BodyField, Operation, Param } from "@anvil/air";

/** A flat view over an operation's surfaced input fields. */
export interface FieldRef {
  path: string;
  name: string;
  agentName?: string;
  schema: Record<string, unknown>;
  required: boolean;
  description?: string;
  enumValues?: unknown[];
  hasExample: boolean;
}

function enumOf(schema: Record<string, unknown> | undefined): unknown[] | undefined {
  const values = schema?.enum;
  return Array.isArray(values) && values.length > 0 ? values : undefined;
}

/** One definition shared by detection and evaluation, including refinement-written examples. */
export function hasFieldExample(schema: Record<string, unknown>, example?: unknown): boolean {
  return (
    example !== undefined ||
    schema.example !== undefined ||
    schema.default !== undefined ||
    (Array.isArray(schema.examples) && schema.examples.length > 0)
  );
}

/** Parameters and projected body fields that an agent can address directly. */
export function surfacedFields(operation: Operation): FieldRef[] {
  const fields: FieldRef[] = operation.input.params.map((param: Param) => ({
    path: `input.params.${param.name}`,
    name: param.name,
    agentName: param.agentName,
    schema: param.schema,
    required: param.required,
    description: param.description,
    enumValues: enumOf(param.schema),
    hasExample: hasFieldExample(param.schema, param.example),
  }));
  if (operation.input.body?.projection !== "fields") return fields;
  for (const field of operation.input.body.fields as BodyField[]) {
    fields.push({
      path: `input.body.${field.name}`,
      name: field.name,
      agentName: field.agentName,
      schema: field.schema,
      required: field.required,
      description: field.description,
      enumValues: enumOf(field.schema),
      hasExample: hasFieldExample(field.schema),
    });
  }
  return fields;
}
