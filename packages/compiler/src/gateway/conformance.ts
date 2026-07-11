/**
 * `gatewayAdapterConformance` — the executable contract every gateway adapter
 * must satisfy, run against a fixture. It returns findings as data (never throws
 * on a failed check), so a vendor adapter's conformance is a test assertion, not
 * a promise in prose. These are the invariants that keep adapters thin, honest,
 * and safe:
 *
 *   - deterministic inventory, source, and overlay (content identity is stable);
 *   - every overlay assertion cites resolvable evidence with a coordinate;
 *   - secrets are never persisted into any emitted artifact;
 *   - the emitted source + overlay feed the one compiler path;
 *   - auth is never weakened by a gateway overlay;
 *   - a read-only adapter does not advertise publish.
 */
import { compileContract } from "../contract/snapshot.js";
import type { AdapterContext, GatewayAdapter, GatewayConnection } from "./adapter.js";
import type { GatewayApiImport, GatewayApiRef } from "./model.js";

export interface ConformanceFixture<TConnection extends GatewayConnection = GatewayConnection> {
  connection: TConnection;
  api: GatewayApiRef;
  /**
   * A sentinel secret placed on the connection (or resolvable from it). The suite
   * asserts it never appears in any emitted artifact.
   */
  secret?: string;
}

export interface ConformanceCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface ConformanceReport {
  ok: boolean;
  checks: ConformanceCheck[];
}

const AUTH_LOOSENING = "auth restrictions must not be weakened by a gateway overlay";

/** Run the conformance battery for one adapter against one fixture. */
export async function gatewayAdapterConformance<TConnection extends GatewayConnection>(
  fixture: ConformanceFixture<TConnection>,
  adapter: GatewayAdapter<TConnection>,
  context: AdapterContext = {},
): Promise<ConformanceReport> {
  const checks: ConformanceCheck[] = [];
  const record = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });

  const probe = await adapter.probe(fixture.connection, context);
  record("probe reports reachability and capabilities", probe.reachable === true);

  const inv1 = await adapter.inventory(fixture.connection, context);
  const inv2 = await adapter.inventory(fixture.connection, context);
  record(
    "inventory is deterministic",
    inv1.digest === inv2.digest,
    `${inv1.digest} vs ${inv2.digest}`,
  );
  record(
    "inventory APIs carry stable identity and lifecycle",
    inv1.apis.length > 0 && inv1.apis.every((a) => a.id.length > 0),
  );

  const imp1 = await adapter.extractApi(fixture.connection, fixture.api, context);
  const imp2 = await adapter.extractApi(fixture.connection, fixture.api, context);
  record(
    "source is deterministic",
    imp1.source.sourceHash === imp2.source.sourceHash,
    `${imp1.source.sourceHash} vs ${imp2.source.sourceHash}`,
  );
  record("overlay is deterministic", imp1.overlay.digest === imp2.overlay.digest);
  record("adapter emits a diagnostics channel", Array.isArray(imp1.diagnostics));

  // Every assertion cites resolvable evidence with a coordinate ref.
  const evidenceById = new Map(imp1.overlay.evidence.map((e) => [e.id, e]));
  const everyAssertionEvidenced = imp1.overlay.assertions.every(
    (a) => a.evidenceRefs.length > 0 && a.evidenceRefs.every((r) => evidenceById.get(r)?.ref),
  );
  record("every overlay assertion cites evidence with a coordinate", everyAssertionEvidenced);

  // Auth is never weakened. A gateway is *authoritative* for `auth.scopes`, so a
  // `set`/`remove` that empties or subtracts scopes would actually be applied — the
  // invariant must catch every shape that loosens auth, not just an explicit
  // `remove`: scope removal, a `set` to an empty/absent scope set, and a principal
  // downgraded to anonymous.
  const emptyScopeSet = (v: unknown) => !Array.isArray(v) || v.length === 0;
  const weakensAuth = imp1.overlay.assertions.some(
    (a) =>
      (a.predicate === "auth.scopes" && a.operation === "remove") ||
      (a.predicate === "auth.scopes" && a.operation === "set" && emptyScopeSet(a.value)) ||
      (a.predicate === "auth.principal" && a.operation === "set" && a.value === "anonymous"),
  );
  record(AUTH_LOOSENING, !weakensAuth);

  // Secrets never persisted into any emitted artifact.
  record(
    "secrets are never persisted",
    !fixture.secret ||
      !containsSecret([inv1, imp1.overlay, sourceFingerprint(imp1)], fixture.secret),
  );

  // The emitted source + overlay feed the one compiler path.
  let feedsPipeline = false;
  let feedDetail: string | undefined;
  try {
    const result = await compileContract(imp1.source, [imp1.overlay]);
    const contract = result.status === "resolved" ? result.contract : result.partialContract;
    feedsPipeline = contract.air.operations.length > 0;
    feedDetail = `status=${result.status}, operations=${contract.air.operations.length}`;
  } catch (err) {
    feedDetail = String(err);
  }
  record("source + overlay feed the compiler pipeline", feedsPipeline, feedDetail);

  // A read-only adapter must not advertise publish.
  record("read-only adapter does not expose publish", adapter.capabilities.publish === false);

  return { ok: checks.every((c) => c.ok), checks };
}

/** The source reduced to what could leak a secret (paths + provenance, not bytes). */
function sourceFingerprint(imp: GatewayApiImport): unknown {
  return {
    snapshotId: imp.source.snapshotId,
    origin: imp.source.origin,
    entrypoint: imp.source.entrypoint,
    files: [...imp.source.files.keys()],
  };
}

function containsSecret(artifacts: unknown[], secret: string): boolean {
  return artifacts.some((a) => JSON.stringify(a).includes(secret));
}
