import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { InProcessBrokerDouble } from "./broker-double.js";
import { createLegacyBridgeFacade, type LegacyBridgeTelemetryRecord } from "./facade.js";
import { fixtureLegacyCapabilityBinding } from "./test-fixtures.js";
import { buildQueueWireBinding, LegacyBridgeShapeError } from "./wire-binding.js";

let closeServer: (() => Promise<void>) | undefined;

afterEach(async () => {
  await closeServer?.();
  closeServer = undefined;
});

async function boot(
  double: InProcessBrokerDouble,
  telemetry: LegacyBridgeTelemetryRecord[] = [],
): Promise<string> {
  const binding = fixtureLegacyCapabilityBinding();
  const wireBinding = buildQueueWireBinding(binding);
  const listener = createLegacyBridgeFacade({
    binding,
    wireBinding,
    client: double,
    onTelemetry: (record) => telemetry.push(record),
  });
  const server = createServer(listener);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closeServer = () => new Promise<void>((resolve) => server.close(() => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return `http://127.0.0.1:${address.port}`;
}

describe("createLegacyBridgeFacade", () => {
  it("refuses to construct against an incoherent wire binding", () => {
    const binding = fixtureLegacyCapabilityBinding();
    const wireBinding = buildQueueWireBinding(binding);
    const mismatched = { ...wireBinding, legacyBindingContentHash: `sha256:${"0".repeat(64)}` };
    expect(() =>
      createLegacyBridgeFacade({
        binding,
        wireBinding: mismatched,
        client: new InProcessBrokerDouble(() => ""),
      }),
    ).toThrow(LegacyBridgeShapeError);
  });

  it("proxies one HTTP call to exactly one broker exchange and returns the reply", async () => {
    const double = new InProcessBrokerDouble((body) => body);
    const baseUrl = await boot(double);
    const res = await fetch(`${baseUrl}/invoke`, { method: "POST", body: '{"refundId":"r-1"}' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"refundId":"r-1"}');
    expect(double.sendAttempts).toBe(1);
  });

  it("answers /readyz without touching the broker", async () => {
    const double = new InProcessBrokerDouble(() => "unused");
    const baseUrl = await boot(double);
    const res = await fetch(`${baseUrl}/readyz`);
    expect(res.status).toBe(200);
    expect(double.sendAttempts).toBe(0);
  });

  it("refuses an unknown route with 404 and the wrong method with 405", async () => {
    const double = new InProcessBrokerDouble(() => "unused");
    const baseUrl = await boot(double);
    const missing = await fetch(`${baseUrl}/nope`);
    expect(missing.status).toBe(404);
    const wrongMethod = await fetch(`${baseUrl}/invoke`, { method: "GET" });
    expect(wrongMethod.status).toBe(405);
  });

  it("maps a broker timeout to a structured, non-retryable 504", async () => {
    const binding = fixtureLegacyCapabilityBinding({ timeoutMs: 100 });
    const wireBinding = buildQueueWireBinding(binding);
    const double = new InProcessBrokerDouble(() => "unused", {
      silentDestinations: new Set([wireBinding.requestDestination]),
    });
    const listener = createLegacyBridgeFacade({ binding, wireBinding, client: double });
    const server = createServer(listener);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closeServer = () => new Promise<void>((resolve) => server.close(() => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const res = await fetch(`http://127.0.0.1:${address.port}/invoke`, {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(504);
    const parsed = (await res.json()) as { code: string; retryable: boolean };
    expect(parsed.code).toBe("upstream_timeout");
    expect(parsed.retryable).toBe(false);
  });

  it("maps a broker transport failure to a stable 502 without leaking the raw exception", async () => {
    const binding = fixtureLegacyCapabilityBinding();
    const wireBinding = buildQueueWireBinding(binding);
    const double = new InProcessBrokerDouble(() => "unused", {
      refusedDestinations: new Set([wireBinding.requestDestination]),
    });
    const baseUrl = await boot2(binding, wireBinding, double);
    const res = await fetch(`${baseUrl}/invoke`, { method: "POST", body: "{}" });
    expect(res.status).toBe(502);
    const parsed = (await res.json()) as { code: string; message: string };
    expect(parsed.code).toBe("upstream_unavailable");
    expect(parsed.message).not.toContain("QueueBrokerTransportError");
  });

  it("emits telemetry with no request payload content", async () => {
    const telemetry: LegacyBridgeTelemetryRecord[] = [];
    const double = new InProcessBrokerDouble((body) => body);
    const baseUrl = await boot(double, telemetry);
    await fetch(`${baseUrl}/invoke`, { method: "POST", body: '{"secretField":"do-not-leak"}' });
    expect(telemetry).toHaveLength(1);
    expect(JSON.stringify(telemetry[0])).not.toContain("do-not-leak");
    expect(telemetry[0]?.outcome).toBe("success");
  });

  async function boot2(
    binding: ReturnType<typeof fixtureLegacyCapabilityBinding>,
    wireBinding: ReturnType<typeof buildQueueWireBinding>,
    double: InProcessBrokerDouble,
  ): Promise<string> {
    const listener = createLegacyBridgeFacade({ binding, wireBinding, client: double });
    const server = createServer(listener);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closeServer = () => new Promise<void>((resolve) => server.close(() => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    return `http://127.0.0.1:${address.port}`;
  }
});
