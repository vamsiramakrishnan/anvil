/**
 * @anvil/compiler/gateway/kong — the Kong declarative-config adapter (the first
 * real vendor adapter). Emits only `GatewayInventorySnapshot` +
 * `GatewayApiImport { source, overlay }`; no Kong type escapes. See ADR-0021.
 */
export * from "./adapter.js";
export * from "./model.js";
export * from "./parse.js";
export * from "./plugins.js";
export * from "./spec.js";
