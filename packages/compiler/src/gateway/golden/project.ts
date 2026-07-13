/**
 * The golden-estate projection: everything a vendor adapter's mapping decides,
 * flattened to a stable, diffable shape. `scripts/gen-gateway-golden.mjs`
 * writes it to `expected/<vendor>.json`; `golden.test.ts` recomputes and
 * deep-equals — so any change to adapter mapping semantics (a scope that stops
 * landing, an opaque policy that silently vanishes, a risk class that shifts)
 * is a loud diff against a committed file, never a quiet drift.
 */

import { compileContract } from "../../contract/snapshot.js";
import type { AdapterContext, GatewayAdapter, GatewayConnection } from "../adapter.js";

interface GoldenConnection extends GatewayConnection {
  config: string;
  origin?: string;
}

export interface GoldenOperation {
  id: string;
  effect: string;
  action: string;
  risk: string;
  reversible: boolean;
  idempotency: string;
  confirmation: boolean;
  scopes: string[];
  state: string;
}

export interface GoldenApi {
  id: string;
  /** Present instead of operations when the import hit unresolved conflicts. */
  conflicted?: string[];
  operations?: GoldenOperation[];
  /** Opaque-policy findings — the honesty ledger; count AND identity pinned. */
  opaque?: string[];
  diagnostics?: number;
}

export interface GoldenEstate {
  vendor: string;
  apis: GoldenApi[];
}

const CONTEXT: AdapterContext = {};

/** Project one estate config through an adapter into the golden shape. */
export async function projectGoldenEstate(
  vendor: string,
  adapter: GatewayAdapter<GoldenConnection>,
  config: string,
): Promise<GoldenEstate> {
  const connection: GoldenConnection = {
    id: `${vendor}-golden`,
    config,
    origin: `${vendor}.yaml`,
  };
  const snapshot = await adapter.inventory(connection, CONTEXT);
  const apis: GoldenApi[] = [];
  for (const api of snapshot.apis) {
    const imported = await adapter.extractApi(connection, { id: api.id, name: api.name }, CONTEXT);
    const result = await compileContract(imported.source, [imported.overlay]);
    if (result.status === "conflicted") {
      apis.push({ id: api.id, conflicted: result.conflicts.map((c) => c.predicate).sort() });
      continue;
    }
    const air = result.contract.air;
    apis.push({
      id: api.id,
      operations: air.operations
        .map(
          (o): GoldenOperation => ({
            id: o.id,
            effect: o.effect.kind,
            action: o.effect.action,
            risk: o.effect.risk,
            reversible: o.effect.reversible,
            idempotency: o.idempotency.mode,
            confirmation: o.confirmation.required,
            scopes: [...o.auth.scopes].sort(),
            state: o.state,
          }),
        )
        .sort((a, b) => a.id.localeCompare(b.id)),
      opaque: imported.diagnostics
        .filter((d) => d.code.includes("opaque"))
        .map((d) => `${d.code}: ${d.coordinate?.pointer ?? d.message}`)
        .sort(),
      diagnostics: imported.diagnostics.length,
    });
  }
  apis.sort((a, b) => a.id.localeCompare(b.id));
  return { vendor, apis };
}
