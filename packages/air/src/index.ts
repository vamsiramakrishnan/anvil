/**
 * @anvil/air — the Anvil Intermediate Representation.
 *
 * AIR is the single canonical source of truth. Every source format (OpenAPI,
 * Swagger, WSDL, protobuf, GraphQL) compiles *into* AIR; every artifact (CLI,
 * MCP server, skill package, docs, tests) compiles *from* AIR. If a semantic is
 * not expressible here, it cannot reach an agent — which is the point.
 */

export * from "./agent-projection.js";
export * from "./async-contract.js";
export * from "./auth-mechanics.js";
export * from "./disclosure.js";
export * from "./enums.js";
export * from "./error-spec.js";
export * from "./eval-vocabulary.js";
export * from "./hash.js";
export * from "./idempotency-carrier.js";
export * from "./jsonschema.js";
export * from "./ladder.js";
export * from "./mcp.js";
export * from "./naming.js";
export * from "./resolve.js";
export * from "./schema.js";
export * from "./serialize.js";
export * from "./wire.js";
export * from "./workflow-surface.js";
