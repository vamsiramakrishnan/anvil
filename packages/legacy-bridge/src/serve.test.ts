import {
  finalizeLegacyBridgeConformanceReport,
  finalizeLegacyCapabilityBindingRecord,
  type LegacyBridgeConformanceReport,
  type LegacyCapabilityBinding,
  planLegacyBridge,
} from "@anvil/compiler/legacy";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { InProcessBrokerDouble } from "./broker-double.js";
import { runLegacyBridgeConformance } from "./conformance.js";
import {
  assertLegacyBindingServable,
  isLoopbackHost,
  LegacyBridgeServeRefusal,
  type LegacyBridgeServer,
  serveLegacyBridge,
} from "./serve.js";
import { StompClient } from "./stomp-client.js";
import { StompServerDouble } from "./stomp-server-double.js";
import { fixtureLegacyCapabilityBinding } from "./test-fixtures.js";

let promoted: LegacyCapabilityBinding;
let report: LegacyBridgeConformanceReport;
const cleanups: Array<() => Promise<void> | void> = [];

beforeAll(async () => {
  const binding = fixtureLegacyCapabilityBinding();
  const result = await runLegacyBridgeConformance(binding, planLegacyBridge(binding));
  if (!result.promotedBinding) throw new Error("fixture conformance did not pass");
  promoted = result.promotedBinding;
  report = result.report;
});

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function refusal(fn: () => unknown): LegacyBridgeServeRefusal {
  try {
    fn();
  } catch (error) {
    if (error instanceof LegacyBridgeServeRefusal) return error;
    throw error;
  }
  throw new Error("expected a LegacyBridgeServeRefusal");
}

describe("assertLegacyBindingServable", () => {
  it("accepts a promoted binding with the exact report that promoted it", () => {
    expect(() => assertLegacyBindingServable(promoted, report)).not.toThrow();
  });

  it("refuses a not_implemented binding", () => {
    const error = refusal(() =>
      assertLegacyBindingServable(fixtureLegacyCapabilityBinding(), report),
    );
    expect(error.reason).toBe("not_conformant");
  });

  it("refuses a hand-edited conformance_passed status whose report hash names a different report", () => {
    const { bindingId: _b, contentHash: _c, ...core } = fixtureLegacyCapabilityBinding();
    const forged = finalizeLegacyCapabilityBindingRecord({
      ...core,
      runtime: {
        placement: "deployment_local_bridge",
        status: "conformance_passed",
        conformanceReportHash: `sha256:${"f".repeat(64)}`,
      },
    });
    expect(refusal(() => assertLegacyBindingServable(forged, report)).reason).toBe(
      "report_mismatch",
    );
  });

  it("refuses a report that did not fully pass even when its hash is what the binding names", () => {
    const failing = finalizeLegacyBridgeConformanceReport({
      schemaVersion: 1,
      planId: report.planId,
      bindingId: report.bindingId,
      bindingContentHash: report.bindingContentHash,
      brokerDouble: report.brokerDouble,
      checks: [{ id: "legacy-bridge/timeout", status: "fail", detail: "hung" }],
    });
    const { bindingId: _b, contentHash: _c, ...core } = promoted;
    const bindingNamingFailure = finalizeLegacyCapabilityBindingRecord({
      ...core,
      runtime: {
        placement: "deployment_local_bridge",
        status: "conformance_passed",
        conformanceReportHash: failing.contentHash,
      },
    });
    expect(refusal(() => assertLegacyBindingServable(bindingNamingFailure, failing)).reason).toBe(
      "report_failed",
    );
  });

  it("refuses a promoted binding whose reviewed facts changed after the report was earned", () => {
    const { bindingId: _b, contentHash: _c, ...core } = promoted;
    const tampered = finalizeLegacyCapabilityBindingRecord({
      ...core,
      transport: { ...core.transport, target: "jms/SomethingElse" },
    });
    expect(refusal(() => assertLegacyBindingServable(tampered, report)).reason).toBe(
      "report_lineage_mismatch",
    );
  });
});

describe("isLoopbackHost", () => {
  it.each([
    "127.0.0.1",
    "127.1.2.3",
    "::1",
    "[::1]",
    "localhost",
    "LOCALHOST",
  ])("treats %s as loopback", (host) => expect(isLoopbackHost(host)).toBe(true));
  it.each([
    "0.0.0.0",
    "::",
    "10.0.0.5",
    "192.168.1.1",
    "example.internal",
    "127.0.0.1.evil",
  ])("does not treat %s as loopback", (host) => expect(isLoopbackHost(host)).toBe(false));
});

describe("serveLegacyBridge", () => {
  async function serve(
    overrides: Partial<Parameters<typeof serveLegacyBridge>[0]> = {},
  ): Promise<LegacyBridgeServer> {
    const server = await serveLegacyBridge({
      binding: promoted,
      conformanceReport: report,
      client: new InProcessBrokerDouble((body) => body),
      ...overrides,
    });
    cleanups.push(() => server.close());
    return server;
  }

  it("binds 127.0.0.1 on a free port by default and serves /readyz and /invoke", async () => {
    const server = await serve();
    expect(server.host).toBe("127.0.0.1");
    expect(server.port).toBeGreaterThan(0);
    expect(server.url).toBe(`http://127.0.0.1:${server.port}`);
    expect(server.operation).toBe(promoted.operation.name);
    expect(server.bindingId).toBe(promoted.bindingId);

    const ready = await fetch(`${server.url}/readyz`);
    expect(ready.status).toBe(200);
    const invoked = await fetch(`${server.url}/invoke`, { method: "POST", body: '{"a":1}' });
    expect(invoked.status).toBe(200);
    expect(await invoked.text()).toBe('{"a":1}');
  });

  it("refuses a non-loopback host unless explicitly allowed", async () => {
    await expect(serve({ host: "0.0.0.0" })).rejects.toMatchObject({ reason: "host_refused" });
  });

  it("refuses to bind at all for a not_implemented binding — nothing listens", async () => {
    await expect(serve({ binding: fixtureLegacyCapabilityBinding() })).rejects.toMatchObject({
      reason: "not_conformant",
    });
  });

  it("serves the real STOMP client end to end over the server double", async () => {
    const double = new StompServerDouble({ handler: (body) => `{"echo":${body}}` });
    const { host, port } = await double.listen();
    cleanups.push(() => double.close());
    const client = new StompClient({
      host,
      port,
      vhost: host,
      replyDestination: "/queue/serve-test.replies",
    });
    await client.connect();
    cleanups.push(() => client.close());

    const server = await serve({ client });
    const res = await fetch(`${server.url}/invoke`, {
      method: "POST",
      headers: { "idempotency-key": "serve-key-1" },
      body: '{"refundId":"r-9"}',
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"echo":{"refundId":"r-9"}}');
    expect(double.requestDestinations).toEqual([promoted.transport.target]);
    expect(double.sendHeaders[0]?.["correlation-id"]).toBe("serve-key-1");
  });

  it("close() stops the listener so the port no longer answers", async () => {
    const server = await serve();
    cleanups.pop();
    await server.close();
    await expect(fetch(`${server.url}/readyz`)).rejects.toThrow();
  });
});
