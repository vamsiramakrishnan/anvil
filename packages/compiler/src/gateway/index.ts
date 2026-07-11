/**
 * @anvil/compiler/gateway — the gateway-neutral foundation.
 *
 * The common vocabulary every gateway estate normalizes into. An adapter emits
 * `GatewayApiImport { source, overlay }` and nothing else; the compiler pipeline
 * (`compileContract`) consumes it exactly like any other source + overlays. No
 * vendor-specific type escapes this package. See ADR-0013.
 */
export * from "./adapter.js";
export * from "./archive/index.js";
export * from "./capability-matrix.js";
export * from "./conformance.js";
export * from "./fixture.js";
export * from "./inventory.js";
export * from "./model.js";
export * from "./overlay.js";
