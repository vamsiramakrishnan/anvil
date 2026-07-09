import type { JsonSchema, Operation } from "@anvil/air";
import { operationInputSchema } from "@anvil/air";
import { z } from "zod";

/**
 * Convert an AIR operation's assembled input schema into a Zod raw shape for
 * `McpServer.registerTool`. The SDK re-emits this as the tool's published JSON
 * Schema, so the MCP `inputSchema` and `cli --schema` stay derived from one AIR.
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
    return z.enum(schema.enum.map(String) as [string, ...string[]]);
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
