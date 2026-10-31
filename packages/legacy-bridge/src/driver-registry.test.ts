import { hashCanonical } from "@anvil/air";
import { describe, expect, it, vi } from "vitest";
import {
  type DriverBinding,
  postgresProcedureDriver,
  QualifiedDriverRegistry,
} from "./driver-registry.js";

const binding: DriverBinding = {
  id: "record",
  driver: "postgres-procedure",
  version: "1",
  target: "billing.record_refund",
  parameters: ["amount", "reference"],
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["amount", "reference"],
    properties: {
      amount: { type: "integer", minimum: 0 },
      reference: { type: "string", minLength: 1 },
    },
  },
  outputSchema: {
    type: "object",
    required: ["receipt"],
    properties: { receipt: { type: "string" } },
  },
  scopes: ["billing:write"],
  approved: true,
  timeoutMs: 1000,
};
const proof = (b: DriverBinding) => ({
  bindingDigest: hashCanonical(b),
  reportDigest: hashCanonical("owned-conformance"),
  passed: true,
});
const authorize = async () => true;
describe("qualified driver registry", () => {
  it("calls a fixed stored procedure with bound values, preserving parameter order", async () => {
    const query = vi.fn(async () => ({ receipt: "r1" }));
    const registry = new QualifiedDriverRegistry();
    registry.register(binding, postgresProcedureDriver({ query }), proof(binding));
    expect(
      await registry.execute(
        "record",
        { reference: "'); DROP TABLE users; --", amount: 42 },
        { authorize },
      ),
    ).toEqual({ outcome: "completed", value: { receipt: "r1" } });
    expect(query.mock.calls[0]).toEqual([
      'CALL "billing"."record_refund"($1, $2)',
      [42, "'); DROP TABLE users; --"],
      expect.any(AbortSignal),
    ]);
  });
  it("refuses unreviewed, mismatched or drifted bindings before invoking", async () => {
    const query = vi.fn(async () => ({})),
      registry = new QualifiedDriverRegistry(),
      driver = postgresProcedureDriver({ query });
    expect(() =>
      registry.register({ ...binding, approved: false }, driver, proof(binding)),
    ).toThrow();
    expect(() =>
      registry.register({ ...binding, target: "billing.other" }, driver, proof(binding)),
    ).toThrow();
    registry.register(binding, driver, proof(binding));
    await expect(
      registry.execute("record", { amount: 1, reference: "x", sql: "unsafe" }, { authorize }),
    ).rejects.toThrow();
    await expect(
      registry.execute("record", { amount: 1, reference: "x" }, { authorize: async () => false }),
    ).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
  it("reports unknown commitment and never retries a failed procedure", async () => {
    const query = vi.fn(async () => {
      throw new Error("connection lost after commit");
    });
    const registry = new QualifiedDriverRegistry();
    registry.register(binding, postgresProcedureDriver({ query }), proof(binding));
    expect(await registry.execute("record", { amount: 1, reference: "x" }, { authorize })).toEqual({
      outcome: "unknown",
      retryable: false,
    });
    expect(query).toHaveBeenCalledTimes(1);
  });
  it("stops waiting at cancellation without claiming the procedure rolled back", async () => {
    const controller = new AbortController();
    const query = vi.fn(async () => {
      controller.abort();
      return new Promise<never>(() => {});
    });
    const registry = new QualifiedDriverRegistry();
    registry.register(binding, postgresProcedureDriver({ query }), proof(binding));
    expect(
      await registry.execute(
        "record",
        { amount: 1, reference: "x" },
        { authorize, signal: controller.signal },
      ),
    ).toEqual({ outcome: "unknown", retryable: false });
  });
});
