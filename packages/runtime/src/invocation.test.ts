import { readFileSync } from "node:fs";
import { AirDocument } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "./config.js";
import { type ExecuteContext, execute } from "./executor.js";
import { loadRuntimeExtensions, runtimeExtensionApi } from "./extensions.js";
import { InMemoryLedger } from "./idempotency.js";
import { prepareInvocation } from "./invocation.js";
import { MockTransport } from "./transport.js";

const op = () =>
  AirDocument.parse(
    JSON.parse(
      readFileSync(
        new URL("../../../examples/business/sources/orders.json", import.meta.url),
        "utf8",
      ),
    ),
  ).operations[0]!;
const input = { opaque_order_ref: "raw" };
const context = (transport: MockTransport): ExecuteContext => ({
  serviceId: "orders",
  baseUrl: "https://orders.example",
  allowedHosts: ["orders.example"],
  env: "dev",
  transport,
});

describe("semantic invocation policy", () => {
  it("loads and chains deployed extension transformations in order", async () => {
    const extensions = await loadRuntimeExtensions(
      ["first", "second"],
      runtimeExtensionApi(loadRuntimeConfig({ ANVIL_ENV: "dev" })),
      {
        importModule: async (name) => ({
          default: {
            name,
            policy: {
              transformInvocation: (plan: { arguments: Record<string, unknown> }) => ({
                arguments: {
                  ...plan.arguments,
                  opaque_order_ref: `${plan.arguments.opaque_order_ref}-${name}`,
                },
                headers: { [`X-${name}`]: "yes" },
              }),
            },
          },
        }),
      },
    );
    const transport = new MockTransport(() => ({ status: 200, headers: {}, body: "{}" }));
    expect(
      (await execute(op(), { input }, { ...context(transport), policy: extensions.policy }))
        .outcome,
    ).toBe("success");
    expect(transport.requests[0]?.url).toContain("raw-first-second");
    expect(transport.requests[0]?.headers).toMatchObject({ "x-first": "yes", "x-second": "yes" });
  });
  it("binds transformed headers to the replay fingerprint without changing ledger ownership", async () => {
    const operation = op();
    operation.effect.kind = "mutation";
    operation.idempotency = {
      mode: "required",
      mechanism: "header",
      key: "Idempotency-Key",
      keyDerivation: "client_supplied",
    };
    operation.confirmation.required = true;
    const transport = new MockTransport(() => ({ status: 200, headers: {}, body: "{}" }));
    let tenant = "a";
    const ctx = {
      ...context(transport),
      ledger: new InMemoryLedger(),
      policy: {
        transformInvocation: () => ({ arguments: input, headers: { "X-Tenant": tenant } }),
      },
    };
    expect(
      (await execute(operation, { input, confirm: true, idempotencyKey: "same-intent" }, ctx))
        .outcome,
    ).toBe("success");
    tenant = "b";
    expect(
      (await execute(operation, { input, confirm: true, idempotencyKey: "same-intent" }, ctx))
        .outcome,
    ).toBe("error");
    expect(transport.requests).toHaveLength(1);
  });
  it("dispatches the transformed arguments and headers after freezing the plan", async () => {
    const transport = new MockTransport(() => ({ status: 200, headers: {}, body: "{}" }));
    const result = await execute(
      op(),
      { input },
      {
        ...context(transport),
        policy: {
          transformInvocation(plan) {
            expect(Object.isFrozen(plan.arguments)).toBe(true);
            expect(plan.contractDigest).toHaveLength(64);
            return {
              arguments: { opaque_order_ref: "sanitized" },
              headers: { "X-Policy": "reviewed" },
            };
          },
        },
      },
    );
    expect(result.outcome).toBe("success");
    expect(transport.requests[0]?.url).toBe("https://orders.example/internal/orders/sanitized");
    expect(transport.requests[0]?.headers["X-Policy"]).toBe("reviewed");
    expect(input.opaque_order_ref).toBe("raw");
  });
  it.each([
    "Authorization",
    "Mcp-Session-Id",
    "Content-Length",
    "Cookie",
    "Host",
  ])("rejects a protocol or credential header %s without dispatch", async (header) => {
    const transport = new MockTransport(() => ({ status: 200, headers: {}, body: "{}" }));
    const result = await execute(
      op(),
      { input },
      {
        ...context(transport),
        policy: { transformInvocation: () => ({ arguments: input, headers: { [header]: "bad" } }) },
      },
    );
    expect(result.outcome).toBe("error");
    expect(transport.requests).toHaveLength(0);
  });
  it("validates transformed values and prevents added confirmation", async () => {
    const options = { operation: op(), input, target: {}, principal: "p", traceId: "t" };
    for (const arguments_ of [{ opaque_order_ref: 42 }, { ...input, confirm: true }])
      await expect(
        prepareInvocation({ ...options, transform: () => ({ arguments: arguments_ }) }),
      ).rejects.toThrow();
  });
  it("refuses collisions with resolver-owned custom credentials", async () => {
    const operation = op();
    operation.auth.type = "jwt_bearer";
    const transport = new MockTransport(() => ({ status: 200, headers: {}, body: "{}" }));
    await execute(
      operation,
      { input },
      {
        ...context(transport),
        credentials: { resolve: async () => ({ headers: { "X-Vendor-Auth": "secret" } }) },
        policy: {
          transformInvocation: () => ({
            arguments: input,
            headers: { "x-vendor-auth": "override" },
          }),
        },
      },
    );
    expect(transport.requests).toHaveLength(0);
  });
});
