import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finalizeLegacyCapabilityBindingRecord } from "@anvil/compiler/legacy";
import { type LegacyBridgeServer, StompServerDouble } from "@anvil/legacy-bridge";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runAnvilCli } from "./anvil-cli.js";
import { bufferIO } from "./io.js";

/**
 * `anvil legacy bridge serve`, driven the way a deployment would drive it: a
 * promoted binding and its report on disk, broker credentials in the
 * environment, a STOMP 1.2 server double on a loopback port standing in for
 * the broker, and a real HTTP client on the facade. Nothing leaves the
 * process.
 */

const CREDENTIALS = { login: "bridge-identity", passcode: "never-print-this-passcode" };
const REPLIES = "/queue/anvil.bridge.replies";

let work: string;
let promotedPath: string;
let reportPath: string;
let notImplementedPath: string;
const servers: LegacyBridgeServer[] = [];
const doubles: StompServerDouble[] = [];
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "anvil-legacy-bridge-serve-"));
  notImplementedPath = writeRequestReplyBinding(join(work, "binding.json"), 200);
  const planPath = join(work, "bridge-plan.json");
  const planned = await anvil("legacy", "bridge", "plan", notImplementedPath, "--out", planPath);
  expect(planned.code, planned.err).toBe(0);
  reportPath = join(work, "conformance.json");
  promotedPath = join(work, "binding.conformance-passed.json");
  const conformed = await anvil(
    "legacy",
    "bridge",
    "conformance",
    planPath,
    "--binding",
    notImplementedPath,
    "--out",
    reportPath,
    "--emit-binding",
    promotedPath,
  );
  expect(conformed.code, conformed.err).toBe(0);
  return () => rmSync(work, { recursive: true, force: true });
});

beforeEach(() => {
  for (const key of ["ANVIL_LEGACY_BROKER_LOGIN", "ANVIL_LEGACY_BROKER_PASSCODE"]) {
    savedEnv[key] = process.env[key];
  }
  process.env.ANVIL_LEGACY_BROKER_LOGIN = CREDENTIALS.login;
  process.env.ANVIL_LEGACY_BROKER_PASSCODE = CREDENTIALS.passcode;
});

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close();
  while (doubles.length > 0) await doubles.pop()?.close();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function anvil(...argv: string[]) {
  const io = bufferIO();
  let server: LegacyBridgeServer | undefined;
  const code = await runAnvilCli(argv, {
    io,
    onLegacyBridgeServer: (running) => {
      server = running;
      servers.push(running);
    },
  });
  return { code, out: io.stdout.join("\n"), err: io.stderr.join("\n"), server };
}

async function brokerDouble(
  handler: (body: string) => string = (body) => body,
  options: { requireCredentials?: boolean } = {},
): Promise<string> {
  const double = new StompServerDouble({
    handler,
    credentials: options.requireCredentials === false ? undefined : CREDENTIALS,
  });
  const { host, port } = await double.listen();
  doubles.push(double);
  return `stomp://${host}:${port}`;
}

function serveArgs(broker: string, ...extra: string[]): string[] {
  return [
    "legacy",
    "bridge",
    "serve",
    promotedPath,
    "--conformance",
    reportPath,
    "--broker",
    broker,
    "--reply-destination",
    REPLIES,
    ...extra,
  ];
}

function writeRequestReplyBinding(path: string, timeoutMs: number): string {
  const binding = finalizeLegacyCapabilityBindingRecord({
    schemaVersion: 1,
    inventoryId: `li_${"1".repeat(64)}`,
    inventoryContentHash: `sha256:${"2".repeat(64)}`,
    candidateId: `lc_${"3".repeat(64)}`,
    candidateHash: `sha256:${"4".repeat(64)}`,
    taskId: `lrt_${"5".repeat(64)}`,
    taskHash: `sha256:${"6".repeat(64)}`,
    proposalId: `lrp_${"7".repeat(64)}`,
    proposalHash: `sha256:${"8".repeat(64)}`,
    receiptId: `lrr_${"9".repeat(64)}`,
    receiptHash: `sha256:${"a".repeat(64)}`,
    operation: {
      name: "refunds.submit_refund",
      summary: "Submit a refund",
      description: "Submit one refund request.",
      effect: "create",
      exposure: "mcp_tool",
      inputSchema: { type: "object", properties: { refundId: { type: "string" } } },
      outputSchema: { type: "object", properties: { accepted: { type: "boolean" } } },
      errors: [],
    },
    transport: {
      kind: "message",
      protocol: "jms",
      target: "jms/RefundRequests",
      direction: "request_reply",
      payloadEncoding: "json",
      reply: { mode: "reply_to", correlationField: "JMSCorrelationID" },
    },
    semantics: {
      completion: "application_accepted",
      timeoutMs,
      authorization: { mode: "bridge_identity", scopes: [] },
      idempotency: { mode: "client_key", carrier: "refundId" },
      retry: { mode: "safe_transient", maxAttempts: 3 },
    },
    runtime: { placement: "deployment_local_bridge", status: "not_implemented" },
  });
  writeFileSync(path, `${JSON.stringify(binding)}\n`);
  return path;
}

describe("anvil legacy bridge serve", () => {
  it("documents the loopback default and the environment credential names", async () => {
    const help = await anvil("legacy", "bridge", "serve", "--help");
    expect(help.code).toBe(0);
    for (const text of [
      "<binding>",
      "--conformance <file>",
      "--broker <url>",
      "--port <n>",
      "--host <address>",
      "--json",
      "127.0.0.1",
      "ANVIL_LEGACY_BROKER_LOGIN",
      "ANVIL_LEGACY_BROKER_PASSCODE",
    ]) {
      expect(help.out).toContain(text);
    }
  });

  it("serves the promoted binding on 127.0.0.1, prints { url, port } under --json, and answers a real HTTP client", async () => {
    const broker = await brokerDouble((body) => `{"accepted":true,"echo":${body}}`);
    const result = await anvil(...serveArgs(broker, "--json"));
    expect(result.code, result.err).toBe(0);
    const document = JSON.parse(result.out) as {
      reportType: string;
      url: string;
      port: number;
      host: string;
      operation: string;
      broker: string;
    };
    expect(document.reportType).toBe("anvil.legacy-bridge-serve");
    expect(document.host).toBe("127.0.0.1");
    expect(document.port).toBeGreaterThan(0);
    expect(document.url).toBe(`http://127.0.0.1:${document.port}`);
    expect(document.operation).toBe("refunds.submit_refund");
    expect(document.broker).toBe(broker);
    expect(result.server?.url).toBe(document.url);

    const ready = await fetch(`${document.url}/readyz`);
    expect(ready.status).toBe(200);
    const invoked = await fetch(`${document.url}/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "refund-r-1" },
      body: '{"refundId":"r-1"}',
    });
    expect(invoked.status).toBe(200);
    expect(await invoked.text()).toBe('{"accepted":true,"echo":{"refundId":"r-1"}}');

    const double = doubles[0];
    expect(double?.requestDestinations).toEqual(["jms/RefundRequests"]);
    expect(double?.sendHeaders[0]).toMatchObject({
      "reply-to": REPLIES,
      "correlation-id": "refund-r-1",
      JMSCorrelationID: "refund-r-1",
    });
  });

  it("uses the environment credentials to connect and never prints them", async () => {
    const broker = await brokerDouble();
    const result = await anvil(...serveArgs(broker));
    expect(result.code, result.err).toBe(0);
    expect(doubles[0]?.openSessions).toBe(1);
    for (const text of [result.out, result.err]) {
      expect(text).not.toContain(CREDENTIALS.passcode);
      expect(text).not.toContain(CREDENTIALS.login);
    }
    expect(result.out).toContain("/invoke");
    expect(result.out).toContain("127.0.0.1");
  });

  it("refuses to start when the broker rejects the credentials, without echoing them", async () => {
    process.env.ANVIL_LEGACY_BROKER_PASSCODE = "wrong-passcode-value";
    const broker = await brokerDouble();
    const result = await anvil(...serveArgs(broker, "--json"));
    expect(result.code).toBe(1);
    expect(result.server).toBeUndefined();
    const envelope = JSON.parse(result.out) as { code: string; message: string };
    expect(envelope.code).toBe("legacy/bridge_serve_broker_unreachable");
    expect(result.out).not.toContain("wrong-passcode-value");
    expect(result.out).not.toContain(CREDENTIALS.passcode);
  });

  it("refuses a binding whose runtime status is not conformance_passed before touching the broker", async () => {
    const broker = await brokerDouble();
    const result = await anvil(
      "legacy",
      "bridge",
      "serve",
      notImplementedPath,
      "--conformance",
      reportPath,
      "--broker",
      broker,
      "--reply-destination",
      REPLIES,
      "--json",
    );
    expect(result.code).toBe(1);
    expect(result.server).toBeUndefined();
    expect(JSON.parse(result.out).code).toBe("legacy/bridge_serve_not_conformant");
    expect(doubles[0]?.connectAttempts).toBe(0);
  });

  it("refuses a conformance report other than the one that promoted the binding", async () => {
    const otherBinding = writeRequestReplyBinding(join(work, "other-binding.json"), 250);
    const otherPlan = join(work, "other-plan.json");
    expect((await anvil("legacy", "bridge", "plan", otherBinding, "--out", otherPlan)).code).toBe(
      0,
    );
    const otherReport = join(work, "other-conformance.json");
    const conformed = await anvil(
      "legacy",
      "bridge",
      "conformance",
      otherPlan,
      "--binding",
      otherBinding,
      "--out",
      otherReport,
    );
    expect(conformed.code, conformed.err).toBe(0);

    const broker = await brokerDouble();
    const result = await anvil(
      "legacy",
      "bridge",
      "serve",
      promotedPath,
      "--conformance",
      otherReport,
      "--broker",
      broker,
      "--reply-destination",
      REPLIES,
      "--json",
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out).code).toBe("legacy/bridge_serve_report_mismatch");
    expect(doubles[0]?.connectAttempts).toBe(0);
  });

  it("refuses credentials inside --broker and never echoes the URL", async () => {
    const result = await anvil(
      ...serveArgs("stomp://user:leaked-passcode@127.0.0.1:61613", "--json"),
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out).code).toBe("legacy/bridge_serve_invalid_broker");
    expect(result.out).not.toContain("leaked-passcode");
  });

  it.each([
    ["a non-stomp scheme", "amqp://127.0.0.1:5672"],
    ["a path", "stomp://127.0.0.1:61613/vhost"],
    ["not a URL", "127.0.0.1:61613"],
  ])("refuses --broker with %s", async (_label, broker) => {
    const result = await anvil(...serveArgs(broker, "--json"));
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out).code).toBe("legacy/bridge_serve_invalid_broker");
  });

  it("refuses to start when nothing listens at the broker", async () => {
    const probe = new StompServerDouble({ handler: (body) => body });
    const { port } = await probe.listen();
    await probe.close();
    const result = await anvil(...serveArgs(`stomp://127.0.0.1:${port}`, "--json"));
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out).code).toBe("legacy/bridge_serve_broker_unreachable");
  });

  it("refuses an invalid --port", async () => {
    const broker = await brokerDouble();
    const result = await anvil(...serveArgs(broker, "--port", "70000", "--json"));
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out).code).toBe("legacy/bridge_serve_invalid_port");
  });

  it("requires --reply-destination when the binding pins none", async () => {
    const broker = await brokerDouble();
    const result = await anvil(
      "legacy",
      "bridge",
      "serve",
      promotedPath,
      "--conformance",
      reportPath,
      "--broker",
      broker,
      "--json",
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out).code).toBe("legacy/bridge_serve_reply_destination_missing");
  });

  it("serves a non-loopback --host only with a warning on stderr", async () => {
    const broker = await brokerDouble();
    const result = await anvil(...serveArgs(broker, "--host", "0.0.0.0", "--json"));
    expect(result.code, result.err).toBe(0);
    expect(result.err).toContain("warning");
    expect(result.err).toContain("not a loopback address");
    expect(JSON.parse(result.out).host).toBe("0.0.0.0");
  });

  it("registers SIGTERM/SIGINT handlers while serving and removes them on close", async () => {
    const broker = await brokerDouble();
    const termBefore = process.listenerCount("SIGTERM");
    const intBefore = process.listenerCount("SIGINT");
    const result = await anvil(...serveArgs(broker));
    expect(result.code, result.err).toBe(0);
    expect(process.listenerCount("SIGTERM")).toBe(termBefore + 1);
    expect(process.listenerCount("SIGINT")).toBe(intBefore + 1);

    const server = servers.pop();
    if (!server) throw new Error("no server handle");
    await server.close();
    expect(process.listenerCount("SIGTERM")).toBe(termBefore);
    expect(process.listenerCount("SIGINT")).toBe(intBefore);
    // Closing also releases the broker session, not just the HTTP listener.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(doubles[0]?.openSessions).toBe(0);
    await expect(fetch(`${server.url}/readyz`)).rejects.toThrow();
  });
});
