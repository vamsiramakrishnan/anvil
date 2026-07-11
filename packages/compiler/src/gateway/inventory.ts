/**
 * Inventory identity. A `GatewayInventorySnapshot`'s digest is content-derived
 * (key-sorted canonical JSON via `@anvil/air`'s hasher), independent of the
 * order APIs/environments/products happen to arrive in, and excludes the digest
 * field itself — so re-inventorying an unchanged estate yields the same digest.
 */
import { hashCanonical } from "@anvil/air";
import type { GatewayInventorySnapshot } from "./model.js";

export type InventoryDraft = Omit<GatewayInventorySnapshot, "digest">;

const byId = <T extends { id: string }>(items: readonly T[]): T[] =>
  [...items].sort((a, b) => a.id.localeCompare(b.id));

/** The content digest of an inventory draft (stable, order-independent). */
export function inventoryDigest(draft: InventoryDraft): string {
  return hashCanonical({
    schemaVersion: draft.schemaVersion,
    gateway: draft.gateway,
    environments: byId(draft.environments),
    apis: byId(draft.apis).map((api) => ({ ...api, routes: byId(api.routes) })),
    products: byId(draft.products),
    diagnostics: draft.diagnostics,
  });
}

/** Stamp an inventory draft with its content digest. */
export function finalizeInventory(draft: InventoryDraft): GatewayInventorySnapshot {
  return { ...draft, digest: inventoryDigest(draft) };
}
