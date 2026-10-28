// The MCP SDK reaches this only for a schema that is not zod 4 (zod-json-schema-compat.js).
// Anvil has no zod 3, so this never runs; fail loudly if it ever does.
export function zodToJsonSchema() {
  throw new Error("zod-to-json-schema stand-in: zod 3 schemas are not supported; use zod 4.");
}
export default zodToJsonSchema;
