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
  const counts = new Map<string, number>();
  for (const api of draft.apis) counts.set(api.id, (counts.get(api.id) ?? 0) + 1);
  const duplicates = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id)
    .sort();
  const normalized: InventoryDraft =
    duplicates.length === 0
      ? draft
      : {
          ...draft,
          diagnostics: [
            ...draft.diagnostics,
            {
              level: "error",
              code: "gateway/duplicate_api_id",
              message: `Gateway inventory contains ambiguous duplicate API id(s): ${duplicates.join(", ")}. Use a vendor export with unique ids or include revision/environment in the adapter identity.`,
            },
          ],
        };
  return { ...normalized, digest: inventoryDigest(normalized) };
}
