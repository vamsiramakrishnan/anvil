/**
 * The gateway adapter contract. A vendor adapter reads a gateway (offline export
 * or read-only management API) and normalizes it into the common vocabulary. It
 * never compiles, never returns AIR, and — in these increments — never mutates
 * the gateway (publication is a separate, later `GatewayPublisher`).
 *
 * The core is impure at its edges (it talks to a gateway), so all ambient
 * dependencies are injected via `AdapterContext`; the fixture adapter takes none
 * and is fully deterministic.
 */
import type {
  GatewayAdapterCapabilities,
  GatewayApiImport,
  GatewayApiRef,
  GatewayDriftResult,
  GatewayInventorySnapshot,
  GatewayKind,
  GatewayProbeResult,
} from "./model.js";

/** A read-only connection to a gateway. Credentials are resolved per call and never persisted. */
export interface GatewayConnection {
  id: string;
  /** Base URL for a live connection; absent for an offline export. */
  baseUrl?: string;
  /** Named credential profile to resolve at call time (never the secret itself). */
  profile?: string;
}

/** Injected, composition-boundary dependencies. Absent members mean "pure/offline". */
export interface AdapterContext {
  /** Injectable clock; content identity never depends on it. */
  clock?: () => Date;
  /** Cancellation for live calls. */
  signal?: AbortSignal;
  /** Bound on concurrent live requests, honoured by live adapters. */
  concurrency?: number;
}

/**
 * A gateway adapter. `probe`/`inventory`/`extractApi` are required; `detectDrift`
 * is optional and gated by `capabilities.drift`. `TConnection` lets a vendor
 * adapter demand a richer connection without leaking that type past its package.
 */
export interface GatewayAdapter<TConnection extends GatewayConnection = GatewayConnection> {
  readonly kind: GatewayKind;
  readonly capabilities: GatewayAdapterCapabilities;
  probe(connection: TConnection, context: AdapterContext): Promise<GatewayProbeResult>;
  inventory(connection: TConnection, context: AdapterContext): Promise<GatewayInventorySnapshot>;
  extractApi(
    connection: TConnection,
    api: GatewayApiRef,
    context: AdapterContext,
  ): Promise<GatewayApiImport>;
  detectDrift?(
    previous: GatewayInventorySnapshot,
    connection: TConnection,
    context: AdapterContext,
  ): Promise<GatewayDriftResult>;
}
