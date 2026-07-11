/**
 * A readable projection of what a gateway adapter can and cannot do. Estate
 * assessment and certification render this so partial support is never invisible:
 * a `false` or `"partial"` is surfaced as a row, not swallowed.
 */
import type { GatewayAdapter, GatewayConnection } from "./adapter.js";
import type { GatewayAdapterCapabilities } from "./model.js";

export interface CapabilityRow {
  dimension: keyof GatewayAdapterCapabilities;
  support: "yes" | "no" | "partial" | "full" | "none";
}

/** Turn an adapter's declared capabilities into a stable, sorted matrix. */
export function capabilityMatrix<T extends GatewayConnection>(
  adapter: GatewayAdapter<T>,
): CapabilityRow[] {
  const caps = adapter.capabilities;
  return (Object.keys(caps) as (keyof GatewayAdapterCapabilities)[])
    .sort((a, b) => a.localeCompare(b))
    .map((dimension) => {
      const value = caps[dimension];
      const support =
        typeof value === "boolean"
          ? value
            ? "yes"
            : "no"
          : (value as "none" | "partial" | "full");
      return { dimension, support };
    });
}

/** Dimensions the adapter does not fully support — the honest "gaps" list. */
export function capabilityGaps<T extends GatewayConnection>(
  adapter: GatewayAdapter<T>,
): (keyof GatewayAdapterCapabilities)[] {
  return capabilityMatrix(adapter)
    .filter((row) => row.support === "no" || row.support === "partial" || row.support === "none")
    .map((row) => row.dimension);
}
