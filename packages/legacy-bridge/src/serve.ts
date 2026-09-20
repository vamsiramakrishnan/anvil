/**
 * Host the facade for one reviewed, conformance-passed binding.
 *
 * `createLegacyBridgeFacade` (facade.ts) returns a request listener and
 * deliberately knows nothing about which binding is allowed to be served,
 * on which interface, or by whom. This module is where those decisions are
 * enforced, once, for every host — the CLI's `anvil legacy bridge serve`
 * and any embedding process alike:
 *
 * 1. **Only a `conformance_passed` binding is ever served.** Not
 *    `not_implemented`, and not a binding somebody hand-edited to say
 *    `conformance_passed`: the caller must also supply the conformance
 *    report, and its content hash must be the one the binding's
 *    `runtime.conformanceReportHash` names, it must have fully passed, and it
 *    must have been earned by *this* reviewed capability — the report is
 *    addressed to the pre-promotion binding, so that address is recomputed
 *    from the supplied binding and compared. Editing a JSON file cannot
 *    satisfy that.
 * 2. **Loopback only, unless the caller explicitly says otherwise.** The
 *    facade speaks plain HTTP with no authentication of its own — it is the
 *    runtime's protocol facade, meant to sit beside the runtime on the same
 *    host — so binding it to a routable interface is a decision, never a
 *    default.
 *
 * What this module does not do: connect to a broker (the caller supplies a
 * connected `QueueBrokerClient`), resolve credentials, or claim readiness
 * beyond what `/readyz` already states.
 */
import { createServer, type Server } from "node:http";
import {
  finalizeLegacyCapabilityBindingRecord,
  type LegacyBridgeConformanceReport,
  type LegacyCapabilityBinding,
  legacyBridgeConformancePassed,
} from "@anvil/compiler/legacy";
import type { QueueBrokerClient } from "./broker.js";
import { createLegacyBridgeFacade, type LegacyBridgeTelemetryRecord } from "./facade.js";
import { buildQueueWireBinding } from "./wire-binding.js";

export type LegacyBridgeServeRefusalReason =
  | "not_conformant"
  | "report_mismatch"
  | "report_failed"
  | "report_lineage_mismatch"
  | "host_refused";

/** A structured reason the bridge refused to start; never a transport
 *  failure, which surfaces as whatever `listen` or the client threw. */
export class LegacyBridgeServeRefusal extends Error {
  constructor(
    readonly reason: LegacyBridgeServeRefusalReason,
    message: string,
  ) {
    super(message);
    this.name = "LegacyBridgeServeRefusal";
  }
}

export const LOOPBACK_HOST = "127.0.0.1";

/** `127.0.0.0/8`, `::1`, and the `localhost` name — the interfaces a bridge
 *  binds without an explicit operator decision. */
export function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  if (bare === "localhost" || bare === "::1" || bare === "::ffff:127.0.0.1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
}

/**
 * The gate: throw unless `binding` is `conformance_passed` and `report` is
 * the exact, fully-passed report that earned it for this reviewed capability.
 */
export function assertLegacyBindingServable(
  binding: LegacyCapabilityBinding,
  report: LegacyBridgeConformanceReport,
): void {
  if (binding.runtime.status !== "conformance_passed") {
    throw new LegacyBridgeServeRefusal(
      "not_conformant",
      `binding '${binding.bindingId}' has runtime status '${binding.runtime.status}', not ` +
        "'conformance_passed' — run `anvil legacy bridge conformance` and serve the promoted binding.",
    );
  }
  if (binding.runtime.conformanceReportHash !== report.contentHash) {
    throw new LegacyBridgeServeRefusal(
      "report_mismatch",
      `binding '${binding.bindingId}' was promoted by conformance report ` +
        `'${binding.runtime.conformanceReportHash}', but the supplied report is '${report.contentHash}'.`,
    );
  }
  if (!legacyBridgeConformancePassed(report)) {
    // Unreachable for a report a promoted binding names (promotion requires a
    // full pass), but the gate does not rely on that: the check is cheap and
    // the property is load-bearing.
    throw new LegacyBridgeServeRefusal(
      "report_failed",
      `conformance report '${report.reportId}' did not fully pass.`,
    );
  }
  // The report is addressed to the binding *before* promotion: same reviewed
  // facts and lineage, runtime `not_implemented`. Recompute that address from
  // the binding in hand and require the report to name it — a promoted
  // binding whose reviewed facts were altered afterwards cannot pass this.
  const { bindingId: _bindingId, contentHash: _contentHash, ...core } = binding;
  const preserved = finalizeLegacyCapabilityBindingRecord({
    ...core,
    runtime: { placement: "deployment_local_bridge", status: "not_implemented" },
  });
  if (
    report.bindingId !== preserved.bindingId ||
    report.bindingContentHash !== preserved.contentHash
  ) {
    throw new LegacyBridgeServeRefusal(
      "report_lineage_mismatch",
      `conformance report '${report.reportId}' was earned by binding '${report.bindingId}', ` +
        `not by the reviewed capability behind '${binding.bindingId}'.`,
    );
  }
}

export interface LegacyBridgeServeOptions {
  binding: LegacyCapabilityBinding;
  conformanceReport: LegacyBridgeConformanceReport;
  /** An already-connected broker client. Its lifetime belongs to the caller. */
  client: QueueBrokerClient;
  /** Interface to bind. Defaults to `127.0.0.1`; anything that is not
   *  loopback is refused unless `allowNonLoopbackHost` is set. */
  host?: string;
  /** Port to bind; `0` (the default) picks a free one. */
  port?: number;
  allowNonLoopbackHost?: boolean;
  onTelemetry?: (record: LegacyBridgeTelemetryRecord) => void;
}

export interface LegacyBridgeServer {
  url: string;
  host: string;
  port: number;
  operation: string;
  bindingId: string;
  close(): Promise<void>;
}

/** Gate, bind, and serve. Resolves once the socket is listening. */
export async function serveLegacyBridge(
  options: LegacyBridgeServeOptions,
): Promise<LegacyBridgeServer> {
  assertLegacyBindingServable(options.binding, options.conformanceReport);
  const host = options.host ?? LOOPBACK_HOST;
  if (!isLoopbackHost(host) && options.allowNonLoopbackHost !== true) {
    throw new LegacyBridgeServeRefusal(
      "host_refused",
      `refusing to bind '${host}': the bridge serves unauthenticated HTTP and binds loopback ` +
        "unless a non-loopback host is explicitly allowed.",
    );
  }
  const wireBinding = buildQueueWireBinding(options.binding);
  const listener = createLegacyBridgeFacade({
    binding: options.binding,
    wireBinding,
    client: options.client,
    onTelemetry: options.onTelemetry,
  });
  const server: Server = createServer(listener);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("the bridge server has no TCP address");
  }
  const urlHost = address.family === "IPv6" ? `[${address.address}]` : address.address;
  return {
    url: `http://${urlHost}:${address.port}`,
    host: address.address,
    port: address.port,
    operation: options.binding.operation.name,
    bindingId: options.binding.bindingId,
    // Stop accepting, let in-flight exchanges finish (each is bounded by the
    // reviewed timeout), and drop only idle keep-alive connections so the
    // close can actually complete.
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections();
      }),
  };
}
