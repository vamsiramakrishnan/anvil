import { LegacyBridgeConformanceReport } from "@anvil/compiler/legacy";
import {
  assertLegacyBindingServable,
  buildQueueWireBinding,
  isLoopbackHost,
  LegacyBridgeServeRefusal,
  type LegacyBridgeServer,
  LOOPBACK_HOST,
  StompClient,
  serveLegacyBridge,
} from "@anvil/legacy-bridge";
import type { Command } from "commander";
import type { z } from "zod";
import { emitRefusal } from "../../envelope.js";
import type { CommandContext } from "../context.js";
import { annotate } from "../meta.js";
import {
  errorCode as bridgeErrorCode,
  LegacyBridgeCommandError,
  readBinding,
  readJson,
} from "./bridge.js";

/**
 * `anvil legacy bridge serve` — host the facade for one conformance-passed
 * binding over one STOMP broker connection.
 *
 * The gate (`assertLegacyBindingServable`) and the loopback default live in
 * `@anvil/legacy-bridge`'s `serve.ts`; this command is the operator-facing
 * shell around them: read the promoted binding and the report that promoted
 * it, resolve broker credentials from the environment by name, connect the
 * real STOMP client, bind, print where it is, and keep serving until SIGTERM
 * or SIGINT.
 *
 * Credentials: `ANVIL_LEGACY_BROKER_LOGIN` / `ANVIL_LEGACY_BROKER_PASSCODE`
 * are read from the process environment and handed to the client. They are
 * never accepted on the command line, never accepted inside `--broker`, and
 * never written to stdout, stderr, or any report — a refusal that mentions
 * the broker names only its host and port.
 */

const SERVE_REPORT_TYPE = "anvil.legacy-bridge-serve";
const SERVE_ERROR_REPORT_TYPE = "anvil.legacy-bridge-serve-error";
const BROKER_LOGIN_ENV = "ANVIL_LEGACY_BROKER_LOGIN";
const BROKER_PASSCODE_ENV = "ANVIL_LEGACY_BROKER_PASSCODE";
const DEFAULT_STOMP_PORT = 61613;

interface BridgeServeOptions {
  conformance: string;
  broker: string;
  replyDestination?: string;
  vhost?: string;
  port?: number;
  host?: string;
  json?: boolean;
}

/** Commander's option parser: a port number, or NaN so the refusal names it. */
function parsePort(value: string): number {
  return /^\d{1,5}$/.test(value) ? Number(value) : Number.NaN;
}

export function registerLegacyBridgeServe(bridge: Command, ctx: CommandContext): void {
  annotate(
    bridge
      .command("serve")
      .summary("Host the conformance-passed facade on 127.0.0.1 over one STOMP broker connection.")
      .description(
        "Serves POST /invoke and GET /readyz for exactly one reviewed binding. Refuses unless the binding's runtime status is conformance_passed and --conformance is the exact, fully-passed report that promoted it — a binding edited by hand to claim the status cannot start. Connects one STOMP 1.2 client to --broker with credentials read from ANVIL_LEGACY_BROKER_LOGIN and ANVIL_LEGACY_BROKER_PASSCODE (never from a flag or the URL, never printed). Binds 127.0.0.1 unless --host names another address, which is served with a warning: the facade is unauthenticated HTTP meant to sit beside the runtime as its protocol facade. One transport shape only: a message binding whose reply mode is reply_to or fixed_destination. Serving proves nothing about live readiness that conformance did not — the broker, destination, and identity are still the unverified live facts the bridge plan lists. Stops on SIGTERM or SIGINT.",
      )
      .argument(
        "<binding>",
        "promoted LegacyCapabilityBinding JSON from `anvil legacy bridge conformance --emit-binding`",
      )
      .requiredOption("--conformance <file>", "the conformance report that promoted the binding")
      .requiredOption(
        "--broker <url>",
        "STOMP broker as stomp://host[:port] (default port 61613); credentials come from the environment, never from this URL",
      )
      .option(
        "--reply-destination <destination>",
        "reply destination this bridge subscribes to (required unless the binding pins one)",
      )
      .option("--vhost <name>", "STOMP virtual host (default: the broker host)")
      .option("--port <n>", "port on the bind address (default: a free port)", parsePort)
      .option(
        "--host <address>",
        "bind address (default: 127.0.0.1); a non-loopback address is served only when given here, with a warning",
      )
      .option("--json", "print one { url, port } document, then keep serving")
      .action(async (binding: string, options: BridgeServeOptions) => {
        ctx.code = await runBridgeServe(binding, options, ctx);
      }),
    { mutates: true },
  );
}

async function runBridgeServe(
  bindingPath: string,
  options: BridgeServeOptions,
  ctx: CommandContext,
): Promise<number> {
  const io = ctx.io;
  const refuse = (error: unknown): number =>
    emitRefusal(io, options.json, {
      reportType: SERVE_ERROR_REPORT_TYPE,
      code: errorCode(error),
      message: error instanceof Error ? error.message : String(error),
      details: { binding: bindingPath, conformance: options.conformance },
    });

  let client: StompClient | undefined;
  try {
    const binding = readBinding(bindingPath);
    const report = readConformanceReport(options.conformance);
    // Gate first, before any socket is opened: a binding that may not be
    // served never causes a broker connection.
    assertLegacyBindingServable(binding, report);

    const broker = parseBrokerUrl(options.broker);
    if (options.port !== undefined && !(Number.isInteger(options.port) && options.port <= 65535)) {
      throw new LegacyBridgeCommandError(
        "legacy/bridge_serve_invalid_port",
        "--port must be an integer between 0 and 65535.",
      );
    }
    const host = options.host ?? LOOPBACK_HOST;
    if (!isLoopbackHost(host)) {
      io.err(
        `warning: --host ${host} is not a loopback address; the bridge serves unauthenticated HTTP ` +
          "and is meant to sit beside the runtime on the same host. Serving it there is your decision.",
      );
    }
    const replyDestination =
      options.replyDestination ?? buildQueueWireBinding(binding).reply.destination;
    if (!replyDestination) {
      throw new LegacyBridgeCommandError(
        "legacy/bridge_serve_reply_destination_missing",
        "The binding pins no reply destination; pass --reply-destination <destination>.",
      );
    }

    client = new StompClient({
      host: broker.host,
      port: broker.port,
      vhost: options.vhost ?? broker.host,
      login: process.env[BROKER_LOGIN_ENV] || undefined,
      passcode: process.env[BROKER_PASSCODE_ENV] || undefined,
      replyDestination,
    });
    try {
      await client.connect();
    } catch (error) {
      throw new LegacyBridgeCommandError(
        "legacy/bridge_serve_broker_unreachable",
        `Could not connect to the broker at stomp://${broker.host}:${broker.port}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    let server: LegacyBridgeServer;
    try {
      server = await serveLegacyBridge({
        binding,
        conformanceReport: report,
        client,
        host,
        port: options.port ?? 0,
        allowNonLoopbackHost: options.host !== undefined,
        onTelemetry: (record) =>
          io.err(JSON.stringify({ reportType: "anvil.legacy-bridge-exchange", ...record })),
      });
    } catch (error) {
      if (error instanceof LegacyBridgeServeRefusal) throw error;
      throw new LegacyBridgeCommandError(
        "legacy/bridge_serve_listen_failed",
        `The bridge could not listen on ${host}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const stompClient = client;
    const stop = (): void => {
      void handle.close();
    };
    const handle: LegacyBridgeServer = {
      ...server,
      close: async () => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        await server.close();
        stompClient.close();
      },
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);

    if (options.json) {
      io.out(
        JSON.stringify(
          {
            schemaVersion: 1,
            reportType: SERVE_REPORT_TYPE,
            url: server.url,
            port: server.port,
            host: server.host,
            operation: server.operation,
            bindingId: server.bindingId,
            broker: `stomp://${broker.host}:${broker.port}`,
          },
          null,
          2,
        ),
      );
    } else {
      io.out(`anvil legacy bridge: serving ${server.operation} (${server.bindingId})`);
      io.out(`  POST ${server.url}/invoke  GET ${server.url}/readyz  (SIGTERM or Ctrl+C to stop)`);
      io.out(`  broker: stomp://${broker.host}:${broker.port}`);
    }
    ctx.deps.onLegacyBridgeServer?.(handle);
    return 0;
  } catch (error) {
    client?.close();
    return refuse(error);
  }
}

function readConformanceReport(path: string): z.infer<typeof LegacyBridgeConformanceReport> {
  const value = readJson(path);
  if (value && typeof value === "object" && "conformance" in value) {
    const report = (value as { conformance?: unknown }).conformance;
    if (!report) {
      throw new LegacyBridgeCommandError(
        "legacy/bridge_serve_conformance_missing",
        "The report does not contain a conformance report.",
      );
    }
    return LegacyBridgeConformanceReport.parse(report);
  }
  return LegacyBridgeConformanceReport.parse(value);
}

/** `stomp://host[:port]`, nothing else: no credentials, no path, no query. The
 *  refusal message never echoes the value, which may carry a passcode. */
function parseBrokerUrl(value: string): { host: string; port: number } {
  const invalid = (why: string): LegacyBridgeCommandError =>
    new LegacyBridgeCommandError("legacy/bridge_serve_invalid_broker", `--broker ${why}.`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid("must be a URL of the form stomp://host[:port]");
  }
  if (url.protocol !== "stomp:") throw invalid("must use the stomp:// scheme");
  if (url.username || url.password) {
    throw invalid(
      `must not carry credentials; set ${BROKER_LOGIN_ENV} and ${BROKER_PASSCODE_ENV} instead`,
    );
  }
  if (!url.hostname) throw invalid("must name a broker host");
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
    throw invalid("must not carry a path, query, or fragment");
  }
  const port = url.port ? Number(url.port) : DEFAULT_STOMP_PORT;
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  return { host, port };
}

function errorCode(error: unknown): string {
  if (error instanceof LegacyBridgeServeRefusal) {
    switch (error.reason) {
      case "not_conformant":
        return "legacy/bridge_serve_not_conformant";
      case "report_mismatch":
        return "legacy/bridge_serve_report_mismatch";
      case "report_failed":
        return "legacy/bridge_serve_report_failed";
      case "report_lineage_mismatch":
        return "legacy/bridge_serve_report_lineage_mismatch";
      case "host_refused":
        return "legacy/bridge_serve_host_refused";
    }
  }
  const code = bridgeErrorCode(error);
  if (code === "legacy/bridge_plan_failed") return "legacy/bridge_serve_failed";
  return code;
}
