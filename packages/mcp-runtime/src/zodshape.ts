import type { JsonSchema, Operation } from "@anvil/air";
import { operationInputSchema } from "@anvil/air";
import { z } from "zod";

/**
 * Convert an AIR operation's assembled input schema into a Zod raw shape for
 * `McpServer.registerTool`. The SDK re-emits this as the tool's published JSON
 * Schema, so the MCP `inputSchema` and `cli --schema` stay derived from one AIR.
 *
 * This is a *serving-time* concern (it validates tool inputs on the hot path),
 * so it lives in the MCP runtime — not in the build-time generators.
 */
export function operationZodShape(op: Operation): z.ZodRawShape {
  const schema = op.input.schema ?? operationInputSchema(op);
  const properties = (schema.properties as Record<string, JsonSchema>) ?? {};
  const required = new Set((schema.required as string[]) ?? []);
  const shape: Record<string, z.ZodType> = {};
  for (const [key, prop] of Object.entries(properties)) {
    let t = jsonSchemaToZod(prop);
    if (typeof prop.description === "string") t = t.describe(prop.description);
    shape[key] = required.has(key) ? t : t.optional();
  }
  return shape as z.ZodRawShape;
}

function jsonSchemaToZod(schema: JsonSchema): z.ZodType {
  if (schema.const !== undefined) return z.literal(schema.const as z.core.util.Literal);
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    // A JSON Schema enum is a set of literal VALUES, not names — a numeric
    // enum member must be accepted as the number the wire carries, never its
    // stringified spelling (which would reject every synthesized example).
    const values = schema.enum;
    if (values.every((v) => typeof v === "string")) {
      return z.enum(values as [string, ...string[]]);
    }
    const literals: z.ZodType[] = values.map((v) => z.literal(v as z.core.util.Literal));
    return literals.length === 1
      ? (literals[0] as z.ZodType)
      : z.union(literals as [z.ZodType, z.ZodType, ...z.ZodType[]]);
  }
  switch (schema.type) {
    case "string":
      return z.string();
    case "integer":
      return z.number().int();
    case "number":
      return z.number();
    case "boolean":
      return z.boolean();
    case "array": {
      const items = (schema.items as JsonSchema | undefined) ?? {};
      return z.array(jsonSchemaToZod(items));
    }
    case "object":
      return z.record(z.string(), z.unknown());
    default:
      return z.unknown();
  }
}
