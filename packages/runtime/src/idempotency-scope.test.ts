import { type Operation, Operation as OperationSchema } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { execute } from "./executor.js";
import { type IdempotencyLedger, InMemoryLedger } from "./idempotency.js";
import { type HttpResponse, MockTransport } from "./transport.js";

function operation(): Operation {
  return OperationSchema.parse({
    id: "payments.refund.create",
    canonicalName: "create_refund",
    displayName: "Create refund",
    sourceRef: { kind: "openapi", path: "/refunds", method: "post" },
    effect: { kind: "mutation", resource: "refund", risk: "financial", reversible: false },
    input: {
      params: [],
      body: {
        contentType: "application/json",
        required: true,
        schema: {
          type: "object",
          required: ["amount"],
          properties: { amount: { type: "integer" } },
        },
        projection: "fields",
        fields: [{ name: "amount", required: true, schema: { type: "integer" } }],
      },
    },
    idempotency: {
      mode: "required",
      mechanism: "header",
      key: "Idempotency-Key",
      keyDerivation: "client_supplied",
    },
    retries: {
      mode: "safe",
      maxAttempts: 1,
      backoff: "fixed",
      retryOn: [],
    },
    confirmation: { required: true, risk: "financial" },
    auth: { type: "none", scopes: [] },
    cli: { command: "payments refunds create" },
    mcp: { toolName: "payments_create_refund" },
    skill: { intentExamples: [] },
    state: "approved",
  });
}

const success = (): HttpResponse => ({
  status: 200,
  headers: {},
  body: '{"id":"refund-1"}',
});

function durableMemoryLedger(): IdempotencyLedger {
  const ledger = new InMemoryLedger();
  return {
    durable: true,
    reserve: (key, fingerprint) => ledger.reserve(key, fingerprint),
    complete: (key, result) => ledger.complete(key, result),
    release: (key) => ledger.release(key),
  };
}

function identity(subject: string, token: string) {
  return {
    subjectToken: token,
    subjectTokenType: "jwt" as const,
    sub: subject,
    claims: {
      iss: "https://identity.example.com",
      sub: subject,
      tid: "tenant-1",
    },
  };
}

describe("idempotency replay scope", () => {
  it("replays across token rotation but conflicts the same raw key across principals", async () => {
    const ledger = new InMemoryLedger();
    const transport = new MockTransport(success);
    const base = {
      serviceId: "payments",
      baseUrl: "https://payments.example.com",
      allowedHosts: ["payments.example.com"],
      authProfile: "prod",
      env: "dev",
      ledger,
      transport,
    };
    const args = {
      input: { amount: 100 },
      confirm: true,
      idempotencyKey: "merchant-key-1",
    };

    const first = await execute(operation(), args, {
      ...base,
      inbound: identity("alice", "alice-token-v1"),
    });
    const rotated = await execute(operation(), args, {
      ...base,
      inbound: identity("alice", "alice-token-v2"),
    });
    const otherPrincipal = await execute(operation(), args, {
      ...base,
      inbound: identity("bob", "bob-token"),
    });

    expect(first.outcome).toBe("success");
    expect(rotated.outcome).toBe("success");
    if (rotated.outcome === "success") expect(rotated.record.ledger).toBe("replay");
    expect(otherPrincipal.outcome).toBe("error");
    if (otherPrincipal.outcome === "error") {
      expect(otherPrincipal.envelope.error.code).toBe("conflict");
      expect(otherPrincipal.record.ledger).toBe("conflict");
      expect(JSON.stringify(otherPrincipal)).not.toContain("refund-1");
    }
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]?.headers["Idempotency-Key"]).toBe("merchant-key-1");
  });

  it("treats CLI safety flags and modeled MCP carrier input as the same request", async () => {
    const ledger = durableMemoryLedger();
    const transport = new MockTransport(success);
    const context = {
      serviceId: "payments",
      baseUrl: "https://payments.example.com",
      allowedHosts: ["payments.example.com"],
      authProfile: "prod",
      env: "dev",
      ledger,
      transport,
      inbound: identity("alice", "token"),
    };

    const fromCli = await execute(
      operation(),
      { input: { amount: 100 }, confirm: true, idempotencyKey: "merchant-key-1" },
      context,
    );
    const fromMcp = await execute(
      operation(),
      {
        input: { amount: 100, confirm: true, idempotency_key: "merchant-key-1" },
        confirm: true,
      },
      context,
    );

    expect(fromCli.outcome).toBe("success");
    expect(fromMcp.outcome).toBe("success");
    if (fromMcp.outcome === "success") expect(fromMcp.record.ledger).toBe("replay");
    expect(transport.requests).toHaveLength(1);
  });

  it.each([
    ["service", { serviceId: "orders" }],
    ["environment", { env: "staging" }],
    ["upstream", { baseUrl: "https://other.example.com" }],
    ["auth profile", { authProfile: "partner" }],
  ])("isolates the same caller key when the %s scope changes", async (_label, changed) => {
    const ledger = durableMemoryLedger();
    const transport = new MockTransport(success);
    const base = {
      serviceId: "payments",
      baseUrl: "https://payments.example.com",
      allowedHosts: ["payments.example.com", "other.example.com"],
      authProfile: "prod",
      env: "dev",
      ledger,
      transport,
      inbound: identity("alice", "token"),
    };
    const args = {
      input: { amount: 100 },
      confirm: true,
      idempotencyKey: "merchant-key-1",
    };

    expect((await execute(operation(), args, base)).outcome).toBe("success");
    const second = await execute(operation(), args, { ...base, ...changed });

    expect(second.outcome).toBe("success");
    expect(transport.requests).toHaveLength(2);
  });

  it("fails closed instead of scoping a replay by bearer bytes alone", async () => {
    const result = await execute(
      operation(),
      { input: { amount: 100 }, confirm: true, idempotencyKey: "merchant-key-1" },
      {
        serviceId: "payments",
        baseUrl: "https://payments.example.com",
        allowedHosts: ["payments.example.com"],
        authProfile: "prod",
        env: "dev",
        ledger: new InMemoryLedger(),
        transport: new MockTransport(success),
        inbound: {
          subjectToken: "opaque-and-rotating",
          subjectTokenType: "access_token",
          claims: { iss: "https://identity.example.com" },
        },
      },
    );

    expect(result.outcome).toBe("error");
    if (result.outcome === "error") expect(result.envelope.error.code).toBe("auth_required");
  });

  it("fails closed without a stable service identity", async () => {
    const result = await execute(
      operation(),
      { input: { amount: 100 }, confirm: true, idempotencyKey: "merchant-key-1" },
      {
        serviceId: "",
        baseUrl: "https://payments.example.com",
        allowedHosts: ["payments.example.com"],
        authProfile: "prod",
        env: "dev",
        ledger: new InMemoryLedger(),
        transport: new MockTransport(success),
      },
    );

    expect(result.outcome).toBe("error");
    if (result.outcome === "error") {
      expect(result.envelope.error.code).toBe("validation_error");
      expect(result.envelope.error.message).toMatch(/serviceId/i);
    }
  });
});
