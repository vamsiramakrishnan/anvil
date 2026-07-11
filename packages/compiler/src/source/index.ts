/**
 * Layer 0 — the source snapshot subsystem. One module per concern:
 * model (shapes + path rules), hash (content identity), detect (decode +
 * structured parse + format claims), import (source graph discovery),
 * store (immutable atomic persistence), service (the composed entry point).
 */
export * from "./detect.js";
export * from "./hash.js";
export * from "./import.js";
export * from "./model.js";
export * from "./service.js";
export * from "./store.js";
