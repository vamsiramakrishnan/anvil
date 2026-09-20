/**
 * The seam between the conformance runner and whichever broker double it
 * drives. Two doubles exist: `InProcessBrokerDouble` (stands in at the
 * `QueueBrokerClient` interface — no socket at all) and `StompServerDouble`
 * behind a real `StompClient` (stands in one layer lower — a loopback socket
 * speaking STOMP 1.2). The runner is written once against this harness and
 * proves the same required cases and the same three safety invariants against
 * either, which is what makes "the real client behaves like the seam-level
 * fake" a checked claim rather than an assumption.
 *
 * Neither is a real broker. `LegacyBridgeConformanceReport.brokerDouble`
 * records which one a report was earned against.
 */
import type { QueueRequestReplyWireBinding } from "@anvil/air";
import type { LegacyBridgeBrokerDouble } from "@anvil/compiler/legacy";
import type { QueueBrokerClient } from "./broker.js";
import { InProcessBrokerDouble, type LegacyBrokerHandler } from "./broker-double.js";
import { StompClient } from "./stomp-client.js";
import { StompServerDouble } from "./stomp-server-double.js";

/** The call accounting both doubles expose, so a scenario can assert how
 *  many times something happened rather than only that it eventually did. */
export interface BrokerDoubleAccounting {
  readonly sendAttempts: number;
  readonly handlerInvocations: number;
  readonly requestDestinations: readonly string[];
}

export interface ConformanceBrokerOptions {
  silentDestinations?: ReadonlySet<string>;
  refusedDestinations?: ReadonlySet<string>;
}

export interface ConformanceBrokerSession {
  client: QueueBrokerClient;
  accounting: BrokerDoubleAccounting;
  close(): Promise<void>;
}

export interface ConformanceBrokerHarness {
  readonly kind: LegacyBridgeBrokerDouble;
  /** Open one fresh double per scenario — state never leaks between cases. */
  open(
    handler: LegacyBrokerHandler,
    options: ConformanceBrokerOptions,
    wireBinding: QueueRequestReplyWireBinding,
  ): Promise<ConformanceBrokerSession>;
}

/** The default: no socket, no port, nothing outside the calling process. */
export const inProcessBrokerHarness: ConformanceBrokerHarness = {
  kind: "in_process_double",
  async open(handler, options) {
    const double = new InProcessBrokerDouble(handler, options);
    return { client: double, accounting: double, close: async () => {} };
  },
};

/** The reply destination the real client subscribes to when the reviewed
 *  binding names none (`reply_to` mode without a captured reply target). A
 *  fixture value for the double only — a deployment names its own. */
export const CONFORMANCE_REPLY_DESTINATION = "/queue/anvil-legacy-bridge.replies";

export interface StompServerBrokerHarnessOptions {
  credentials?: { login: string; passcode: string };
  heartbeatMs?: number;
}

/** `StompClient` over `StompServerDouble`, on a loopback port that lives
 *  exactly as long as one scenario. */
export function stompServerBrokerHarness(
  harnessOptions: StompServerBrokerHarnessOptions = {},
): ConformanceBrokerHarness {
  return {
    kind: "stomp_server_double",
    async open(handler, options, wireBinding) {
      const double = new StompServerDouble({
        handler,
        silentDestinations: options.silentDestinations,
        refusedDestinations: options.refusedDestinations,
        credentials: harnessOptions.credentials,
        heartbeatMs: harnessOptions.heartbeatMs,
      });
      const { host, port } = await double.listen();
      const client = new StompClient({
        host,
        port,
        vhost: host,
        login: harnessOptions.credentials?.login,
        passcode: harnessOptions.credentials?.passcode,
        replyDestination: wireBinding.reply.destination ?? CONFORMANCE_REPLY_DESTINATION,
      });
      try {
        await client.connect();
      } catch (error) {
        await double.close();
        throw error;
      }
      return {
        client,
        accounting: double,
        close: async () => {
          client.close();
          await double.close();
        },
      };
    },
  };
}
