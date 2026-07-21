/**
 * @anvil/air — the Anvil Intermediate Representation.
 *
 * AIR is the single canonical source of truth. Every source format (OpenAPI,
 * Swagger, WSDL, protobuf, GraphQL) compiles *into* AIR; every artifact (CLI,
 * MCP server, skill package, docs, tests) compiles *from* AIR. If a semantic is
 * not expressible here, it cannot reach an agent — which is the point.
 */
export * from "./enums.js";
export * from "./hash.js";
export * from "./jsonschema.js";
export * from "./mcp.js";
export * from "./naming.js";
export * from "./resolve.js";
export * from "./schema.js";
export * from "./serialize.js";
