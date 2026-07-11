/**
 * @anvil/simulator — a contract-faithful, deterministic simulator for Anvil
 * capabilities.
 *
 * A simulator is a *projection* of the same capability contract the MCP server
 * is: its `SurfaceSignature` equals the generated MCP's, so a downstream agent
 * can swap the simulator and production bindings without changing its business
 * contract. See ADR-0017.
 */
import type { SurfaceSignature } from "@anvil/compiler";

export * from "./define.js";
export * from "./model.js";
export { Rng } from "./rng.js";
export * from "./runtime.js";

/**
 * The hard invariant, as an assertion: a simulator surface and a production/MCP
 * surface must be signature-identical. Returns whether they match plus the two
 * digests for a diagnostic.
 */
export function surfaceParity(
  simulator: SurfaceSignature,
  production: SurfaceSignature,
): { matches: boolean; simulator: string; production: string } {
  return {
    matches: simulator.digest === production.digest,
    simulator: simulator.digest,
    production: production.digest,
  };
}
