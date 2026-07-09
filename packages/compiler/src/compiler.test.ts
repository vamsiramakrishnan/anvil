import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classifyConfirmation, classifyEffect } from "./classify.js";
import { approveOperations, compile } from "./compile.js";

const read = (rel: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../../examples/payments/${rel}`, import.meta.url)),
    "utf8",
  );

const spec = read("openapi.yaml");
const manifest = read("anvil.yaml");

describe("classifier", () => {
  it("classifies reads as retry-safe and non-confirming", () => {
    const { effect, idempotency } = classifyEffect("get", "getCustomer /customers/{id}");
    expect(effect.kind).toBe("read");
    expect(idempotency.mode).toBe("natural");
    expect(classifyConfirmation(effect, idempotency).required).toBe(false);
  });

  it("classifies POST refund as a non-idempotent financial mutation", () => {
    const { effect, idempotency } = classifyEffect("post", "createRefund /payments/{id}/refunds");
    expect(effect.kind).toBe("mutation");
    expect(effect.risk).toBe("financial");
    expect(effect.reversible).toBe(false);
    expect(idempotency.mode).toBe("none");
    expect(classifyConfirmation(effect, idempotency).required).toBe(true);
  });

  it("classifies DELETE as destructive", () => {
    const { effect } = classifyEffect("delete", "deleteThing /things/{id}");
    expect(effect.risk).toBe("destructive");
    expect(effect.reversible).toBe(false);
  });
});

describe("compile pipeline (spec only)", () => {
  it("produces AIR with aligned CLI/MCP/skill bindings", async () => {
    const air = await compile({ spec, serviceId: "payments" });
    expect(air.service.id).toBe("payments");
    expect(air.operations.length).toBeGreaterThanOrEqual(4);
    const refund = air.operations.find((o) => o.canonicalName === "create_refund");
    expect(refund).toBeDefined();
    expect(refund?.cli.command).toBe("payments refunds create");
    expect(refund?.mcp.toolName).toBe("payments_create_refund");
    expect(refund?.input.schema?.type).toBe("object");
  });

  it("escalates non-idempotent mutations to review_required without a manifest", async () => {
    const air = await compile({ spec, serviceId: "payments" });
    const refund = air.operations.find((o) => o.canonicalName === "create_refund");
    expect(refund?.state).toBe("review_required");
    expect(refund?.confirmation.required).toBe(true);
    // No retries on an unproven mutation.
    expect(refund?.retries.mode).toBe("none");
    expect(air.diagnostics.some((d) => d.code === "unproven_idempotency")).toBe(true);
  });
});

describe("compile pipeline (with manifest enrichment)", () => {
  it("makes the refund idempotent, retry-safe, and approved", async () => {
    const air = await compile({ spec, manifest, serviceId: "payments" });
    const refund = air.operations.find((o) => o.canonicalName === "create_refund");
    expect(refund?.idempotency.mode).toBe("required");
    expect(refund?.idempotency.key).toBe("Idempotency-Key");
    expect(refund?.idempotency.keyDerivation).toBe("request_fingerprint");
    expect(refund?.retries.mode).toBe("safe");
    expect(refund?.retries.maxAttempts).toBe(3);
    expect(refund?.retries.retryOn).toContain("http_429");
    expect(refund?.confirmation.required).toBe(true);
    expect(refund?.state).toBe("approved");
    expect(refund?.evidence.confidence).toBeGreaterThanOrEqual(0.95);
  });

  it("resolves oauth2 auth with scopes", async () => {
    const air = await compile({ spec, manifest, serviceId: "payments" });
    const refund = air.operations.find((o) => o.canonicalName === "create_refund");
    expect(refund?.auth.type).toBe("oauth2_client_credentials");
    expect(refund?.auth.scopes).toContain("payments.read");
  });

  it("supports explicit approval of additional operations", async () => {
    const air = await compile({ spec, serviceId: "payments" });
    const before = air.operations.find((o) => o.canonicalName === "get_customer");
    expect(before?.state).toBe("generated");
    approveOperations(air, [before?.id ?? ""]);
    expect(air.operations.find((o) => o.canonicalName === "get_customer")?.state).toBe("approved");
  });
});
