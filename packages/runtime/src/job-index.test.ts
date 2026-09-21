import { Operation as OperationSchema } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { execute } from "./executor.js";
import { InMemoryLedger } from "./idempotency.js";
import { jobSecondaryKey } from "./job-index.js";
import { MockTransport } from "./transport.js";

const submit = OperationSchema.parse({
  id: "reports.export.create",
  canonicalName: "create_export",
  displayName: "Create export",
  sourceRef: { kind: "openapi", path: "/exports", method: "post" },
  effect: { kind: "mutation", resource: "export", risk: "none", reversible: true },
  input: {
    params: [],
    body: {
      contentType: "application/json",
      required: true,
      schema: { type: "object", properties: { name: { type: "string" } } },
      projection: "fields",
      fields: [{ name: "name", required: false, schema: { type: "string" } }],
    },
  },
  idempotency: {
    mode: "required",
    mechanism: "header",
    key: "Idempotency-Key",
    keyDerivation: "request_fingerprint",
  },
  retries: { mode: "safe", maxAttempts: 1, backoff: "none", retryOn: [] },
  confirmation: { required: false },
  auth: { type: "none", scopes: [] },
  cli: { command: "reports exports create" },
  mcp: { toolName: "reports_create_export" },
  skill: { intentExamples: [] },
  state: "approved",
  asyncContract: { jobIdField: "job.id", terminalStates: ["done"], pendingStates: ["running"] },
});

describe("job-handle index — written by execute() on every surface", () => {
  it("extracts the declared job id field, dotted paths and numbers included", () => {
    expect(jobSecondaryKey(submit, { job: { id: "job_42" } })).toBe("job_42");
    expect(jobSecondaryKey(submit, { job: { id: 42 } })).toBe("42");
    expect(jobSecondaryKey(submit, { job: {} })).toBeUndefined();
    expect(jobSecondaryKey(submit, { job: { id: "" } })).toBeUndefined();
    expect(jobSecondaryKey({ ...submit, asyncContract: undefined }, { job: { id: "x" } })).toBe(
      undefined,
    );
    // Only own properties: a prototype-shaped path never becomes a key.
    expect(jobSecondaryKey(submit, { job: Object.create({ id: "inherited" }) })).toBeUndefined();
  });

  it("lets a later reader find the submit call's idempotency key by job id", async () => {
    const ledger = new InMemoryLedger();
    const result = await execute(
      submit,
      { input: { name: "q3" }, idempotencyKey: "submit-1" },
      {
        serviceId: "reports",
        baseUrl: "https://reports.example.com",
        allowedHosts: ["reports.example.com"],
        env: "dev",
        transport: new MockTransport(() => ({
          status: 202,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ job: { id: "job_42", state: "running" } }),
        })),
        credentials: { resolve: async () => null },
        ledger,
      },
    );
    expect(result.outcome).toBe("success");
    const found = await ledger.findBySecondaryKey?.("job_42");
    // The index maps the upstream job id to the submit call's ledger key,
    // which is a principal-scoped fingerprint, never the caller's raw key.
    expect(found).toMatch(/^[0-9a-f]{64}$/);
    expect(found).not.toContain("submit-1");
    // ...and that key is the one a replay of the same submit resolves to.
    const replay = await execute(
      submit,
      { input: { name: "q3" }, idempotencyKey: "submit-1" },
      {
        serviceId: "reports",
        baseUrl: "https://reports.example.com",
        allowedHosts: ["reports.example.com"],
        env: "dev",
        transport: new MockTransport(() => ({ status: 500, headers: {}, body: "must not run" })),
        credentials: { resolve: async () => null },
        ledger,
      },
    );
    expect(replay.record.ledger).toBe("replay");
    expect(await ledger.findBySecondaryKey?.("job_42")).toBe(found);
  });
});
