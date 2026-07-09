/**
 * @anvil/harness — the harness loop. Anvil is an MCP *client* here: it connects
 * to the MCP servers that GitHub, GitLab, Confluence, Notion, and Postman
 * already publish, gathers evidence for each operation, and proposes a manifest
 * patch. Enrichment is propose-only and approval-gated; loosening safety
 * requires high-reliability evidence.
 */

export * from "./agent.js";
export * from "./enrich.js";
export * from "./evidence.js";
export * from "./mcp-source.js";
export * from "./reconcile.js";
export * from "./sources.js";
