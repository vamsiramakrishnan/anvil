/**
 * @anvil/compiler/adopt — BYO MCP adoption.
 *
 * An existing MCP server is a first-class source: capture its surface into an
 * immutable `McpSurfaceSnapshot`, bridge it into AIR, and flow it through the one
 * capability/signature/pack pipeline — in explicit adopt/facade/replace modes.
 * See ADR-0016.
 */
export * from "./adopt.js";
export * from "./air.js";
export * from "./fake.js";
export * from "./model.js";
export * from "./snapshot.js";
