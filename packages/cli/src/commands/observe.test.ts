import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { airToJson, loadAirDocument, Operation } from "@anvil/air";
import { type ExecutionRecord, JsonlRecordSpool } from "@anvil/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { runAnvilCli } from "../anvil-cli.js";
import { bufferIO } from "../io.js";

/**
 * `anvil observe --alarm` end to end through the real CLI entrypoint: a
 * bundle whose `air.json` claims an operation is naturally idempotent, a
 * record spool where it returned a conflict on replay, and the alarm should
 * open a real case for it — never touching the bundle's own `air.json`.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function anvil(...argv: string[]) {
  const io = bufferIO();
  const code = await runAnvilCli(argv, { io });
  return { code, io };
}

function op(overrides: Record<string, unknown> = {}): Operation {
  return Operation.parse({
    id: "ledger.invoice.get",
    canonicalName: "get_invoice",
    displayName: "Get an invoice",
    sourceRef: { kind: "openapi", path: "/invoices/{id}", method: "get" },
    effect: { kind: "read", resource: "invoice", risk: "none", reversible: true },
    input: { params: [] },
    idempotency: { mode: "natural", keyDerivation: "none" },
    retries: { mode: "safe", maxAttempts: 2, backoff: "exponential_jitter", retryOn: ["http_503"] },
    confirmation: { required: false },
    auth: { type: "none", scopes: [] },
    cli: { command: "ledger invoice get" },
    mcp: { toolName: "ledger_get_invoice" },
    skill: { intentExamples: [] },
    state: "approved",
    errors: [],
    ...overrides,
  });
}

function record(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    traceId: `t-${Math.random().toString(36).slice(2)}`,
    operationId: "ledger.invoice.get",
    effect: "read",
    outcome: "success",
    latencyMs: 8,
    retryCount: 0,
    idempotencyKeyPresent: false,
    requestBytes: 0,
    responseBytes: 64,
    policyDecisions: [],
    confirmationRequired: false,
    confirmed: false,
    principalId: "anonymous",
    ...overrides,
  };
}

function workspace(): { root: string; bundle: string; spool: string } {
  const root = mkdtempSync(join(tmpdir(), "anvil-observe-alarm-"));
  roots.push(root);
  const bundle = join(root, "bundle");
  mkdirSync(bundle, { recursive: true });
  writeFileSync(
    join(bundle, "air.json"),
    airToJson(
      loadAirDocument({
        service: { id: "ledger", version: "1.0.0", source: { kind: "openapi" } },
        operations: [op()],
      }),
    ),
    "utf8",
  );
  const spool = join(root, "spool");
  const jsonlSpool = new JsonlRecordSpool(spool);
  jsonlSpool.onRecord(record());
  jsonlSpool.onRecord(record());
  jsonlSpool.onRecord(record({ outcome: "error", errorCode: "conflict", ledger: "replay" }));
  return { root, bundle, spool };
}

describe("anvil observe --alarm", () => {
  it("refuses --alarm without --from-records", async () => {
    const { bundle } = workspace();
    const { code, io } = await anvil("observe", bundle, "--alarm", "--json");
    expect(code).toBe(1);
    expect(io.text()).toMatch(/from-records/);
  });

  it("opens a case for a live contradiction, never touching the bundle's own air.json", async () => {
    const { bundle, spool, root } = workspace();
    const before = readFileSync(join(bundle, "air.json"), "utf8");
    const caseRoot = join(root, "cases");
    const { code, io } = await anvil(
      "observe",
      bundle,
      "--from-records",
      spool,
      "--alarm",
      "--case-root",
      caseRoot,
    );
    expect(code, io.text()).toBe(0);
    expect(io.text()).toMatch(/Drift alarm: 1 contradiction/);
    expect(io.text()).toMatch(/OPENED/);
    expect(existsSync(caseRoot)).toBe(true);
    const after = readFileSync(join(bundle, "air.json"), "utf8");
    expect(after).toBe(before);
  });

  it("reports no contradictions when traffic corroborates the compiled model", async () => {
    const root = mkdtempSync(join(tmpdir(), "anvil-observe-alarm-clean-"));
    roots.push(root);
    const bundle = join(root, "bundle");
    mkdirSync(bundle, { recursive: true });
    writeFileSync(
      join(bundle, "air.json"),
      airToJson(
        loadAirDocument({
          service: { id: "ledger", version: "1.0.0", source: { kind: "openapi" } },
          operations: [op()],
        }),
      ),
      "utf8",
    );
    const spool = join(root, "spool");
    const jsonlSpool = new JsonlRecordSpool(spool);
    jsonlSpool.onRecord(record());
    jsonlSpool.onRecord(record());
    jsonlSpool.onRecord(record());

    const { code, io } = await anvil(
      "observe",
      bundle,
      "--from-records",
      spool,
      "--alarm",
      "--case-root",
      join(root, "cases"),
    );
    expect(code, io.text()).toBe(0);
    expect(io.text()).toMatch(/no contradictions/);
  });
});
