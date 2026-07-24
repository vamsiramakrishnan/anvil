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

/**
 * The reserved, `anvil_`-namespaced tool argument for **dry-run** — the one
 * safety control that the operation input schema does NOT already carry.
 * `confirm` and `idempotency_key` are synthesized into the input schema by
 * `operationInputSchema` (and the executor reads them straight out of the input),
 * so a caller — a direct MCP client, or the CLI routed through MCP — already
 * supplies those as ordinary input fields. Dry-run is different: the executor
 * only honors it as an out-of-band flag, never from input, so it needs a reserved
 * arg to travel the MCP hop. It MUST be in the published schema or the SDK's zod
 * validation strips it before the handler sees it. The `anvil_` prefix makes a
 * clash with a real operation parameter effectively impossible.
 */
export const MCP_RESERVED = {
  dryRun: "anvil_dry_run",
} as const;

export function reservedSafetyShape(_op: Operation): z.ZodRawShape {
  return {
    [MCP_RESERVED.dryRun]: z
      .boolean()
      .optional()
      .describe("Preview the wire request without executing it (no upstream call)."),
  } as z.ZodRawShape;
}

function jsonSchemaToZod(schema: JsonSchema): z.ZodType {
  // Zod's JSON-Schema converter preserves intersections, nested object rules,
  // formats, patterns, and additionalProperties. A hand-written type switch
  // would silently discard source constraints on an idempotency carrier.
  return z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
}
