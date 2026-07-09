/**
 * @anvil/mcp-runtime — the thin MCP serving path. It turns an AIR document into
 * a live, compliant MCP server (one tool per approved operation, risk in tool
 * metadata) and advertises precomputed skill/CLI resources. This is deployable
 * on its own: the build-time artifact foundry (`@anvil/generators`) never runs
 * here, so a generated Cloud Run service depends on this, not on the generators.
 */

export * from "./server.js";
export * from "./zodshape.js";
