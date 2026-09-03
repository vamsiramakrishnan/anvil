import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AirDocument, Operation } from "@anvil/air";
import { Operation as OperationSchema } from "@anvil/air";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectDriftContradictions, MIN_SAMPLES_FOR_ALARM, runDriftAlarm } from "./drift-alarm.js";
import type { SpooledRecord } from "./records.js";

/**
 * The drift alarm: pure fold (`detectDriftContradictions`) plus the
 * case-opening pass (`runDriftAlarm`). The load-bearing guarantee this file
 * proves: AIR is never mutated — only `.refinement/cases/**` ever changes.
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anvil-drift-alarm-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function naturalReadOp(overrides: Record<string, unknown> = {}): Operation {
  return OperationSchema.parse({
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

function airWith(...operations: Operation[]): AirDocument {
  return {
    service: { id: "ledger", version: "1.0.0", servers: [] },
    operations,
    capabilities: [],
    workflows: [],
    diagnostics: [],
  } as unknown as AirDocument;
}

function spooled(overrides: Partial<SpooledRecord> = {}): SpooledRecord {
  return {
    traceId: `t-${Math.random().toString(36).slice(2)}`,
    operationId: "ledger.invoice.get",
    effect: "read",
    outcome: "success",
    latencyMs: 10,
    retryCount: 0,
    idempotencyKeyPresent: false,
    requestBytes: 0,
    responseBytes: 100,
    policyDecisions: [],
    confirmationRequired: false,
    confirmed: false,
    ...overrides,
  };
}

describe("detectDriftContradictions — idempotency replay conflict", () => {
  it("finds a contradiction: a naturally-idempotent op's ledger replays a call that still conflicts", () => {
    const op = naturalReadOp();
    const air = airWith(op);
    const records = [
      spooled(),
      spooled(),
      spooled({ outcome: "error", errorCode: "conflict", ledger: "replay" }),
    ];
    const found = detectDriftContradictions(air, records);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      operationId: "ledger.invoice.get",
      kind: "idempotency_replay_conflict",
    });
    expect(found[0]?.records).toHaveLength(1);
  });

  it("does not alarm on an ordinary business conflict without replay evidence", () => {
    // A bare `errorCode === "conflict"` proves nothing about idempotent
    // replay by itself — an everyday business conflict (e.g. "this resource
    // already exists") returns the same error code and can itself be
    // perfectly idempotent to repeat. Without the ledger's own "replay"
    // marker on the record, this must not open a high-severity case.
    const op = naturalReadOp();
    const air = airWith(op);
    const records = [
      spooled(),
      spooled(),
      spooled({ outcome: "error", errorCode: "conflict" }), // no ledger evidence
    ];
    expect(detectDriftContradictions(air, records)).toHaveLength(0);
  });

  it("does not alarm below the minimum sample floor (an anecdote, not a pattern)", () => {
    const op = naturalReadOp();
    const air = airWith(op);
    const records = Array.from({ length: MIN_SAMPLES_FOR_ALARM - 1 }, () =>
      spooled({ outcome: "error", errorCode: "conflict", ledger: "replay" }),
    );
    expect(detectDriftContradictions(air, records)).toHaveLength(0);
  });

  it("does not alarm when idempotency.mode is not natural", () => {
    const op = naturalReadOp({
      idempotency: {
        mode: "required",
        mechanism: "header",
        key: "Idempotency-Key",
        keyDerivation: "client_supplied",
      },
    });
    const air = airWith(op);
    const records = [
      spooled(),
      spooled(),
      spooled({ outcome: "error", errorCode: "conflict", ledger: "replay" }),
    ];
    expect(detectDriftContradictions(air, records)).toHaveLength(0);
  });

  it("does not alarm when no recorded call ever conflicted", () => {
    const op = naturalReadOp();
    const air = airWith(op);
    const records = [spooled(), spooled(), spooled()];
    expect(detectDriftContradictions(air, records)).toHaveLength(0);
  });

  it("ignores records for operations this AIR does not carry", () => {
    const op = naturalReadOp();
    const air = airWith(op);
    const records = [
      spooled({
        operationId: "unknown.op",
        outcome: "error",
        errorCode: "conflict",
        ledger: "replay",
      }),
      spooled({
        operationId: "unknown.op",
        outcome: "error",
        errorCode: "conflict",
        ledger: "replay",
      }),
      spooled({
        operationId: "unknown.op",
        outcome: "error",
        errorCode: "conflict",
        ledger: "replay",
      }),
    ];
    expect(detectDriftContradictions(air, records)).toHaveLength(0);
  });
});

describe("detectDriftContradictions — undeclared error code", () => {
  it("finds a contradiction: a declared code never appears, an undeclared one does", () => {
    const op = naturalReadOp({ errors: [{ code: "not_found" }] });
    const air = airWith(op);
    const records = [
      spooled({ outcome: "error", errorCode: "rate_limited" }),
      spooled({ outcome: "error", errorCode: "rate_limited" }),
      spooled({ outcome: "error", errorCode: "rate_limited" }),
    ];
    const found = detectDriftContradictions(air, records);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "undeclared_error_code" });
  });

  it("does not alarm when the declared code appears at least once", () => {
    const op = naturalReadOp({ errors: [{ code: "not_found" }] });
    const air = airWith(op);
    const records = [
      spooled({ outcome: "error", errorCode: "not_found" }),
      spooled({ outcome: "error", errorCode: "rate_limited" }),
      spooled({ outcome: "error", errorCode: "rate_limited" }),
    ];
    expect(detectDriftContradictions(air, records)).toHaveLength(0);
  });
});

describe("runDriftAlarm — opens a case, proposing only", () => {
  it("opens a real case for an idempotency-replay contradiction, attaching the contradicting records as evidence", async () => {
    const op = naturalReadOp();
    const air = airWith(op);
    const records = [
      spooled(),
      spooled(),
      spooled({ outcome: "error", errorCode: "conflict", ledger: "replay" }),
    ];

    const result = await runDriftAlarm(air, records, {
      root: join(dir, ".refinement"),
      now: 1_700_000_000_000,
    });

    expect(result.contradictions).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
    expect(result.opened).toHaveLength(1);
    const opened = result.opened[0];
    if (!opened) throw new Error("unreachable");
    expect(existsSync(opened.dir)).toBe(true);
    expect(existsSync(join(opened.dir, "case.json"))).toBe(true);

    const caseDoc = JSON.parse(readFileSync(join(opened.dir, "case.json"), "utf8"));
    expect(caseDoc.task.deficiency).toBe("contested_safety_semantic");
    expect(caseDoc.skill.name).toBe("classify-idempotency");

    const evidence = JSON.parse(readFileSync(join(opened.dir, "output", "evidence.json"), "utf8"));
    expect(evidence.artifacts).toHaveLength(1);
    expect(evidence.artifacts[0].source).toBe("recorded_traffic");
  });

  it("reports an undeclared-error-code contradiction but does not open a case for it (no wired evidence-compatible skill)", async () => {
    const op = naturalReadOp({ errors: [{ code: "not_found" }] });
    const air = airWith(op);
    const records = [
      spooled({ outcome: "error", errorCode: "rate_limited" }),
      spooled({ outcome: "error", errorCode: "rate_limited" }),
      spooled({ outcome: "error", errorCode: "rate_limited" }),
    ];
    const result = await runDriftAlarm(air, records, { root: join(dir, ".refinement") });
    expect(result.contradictions).toHaveLength(1);
    expect(result.opened).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
  });

  it("never patches AIR — the compiled document is untouched by opening a case", async () => {
    const op = naturalReadOp();
    const air = airWith(op);
    const before = JSON.stringify(air);
    const records = [
      spooled(),
      spooled(),
      spooled({ outcome: "error", errorCode: "conflict", ledger: "replay" }),
    ];
    await runDriftAlarm(air, records, { root: join(dir, ".refinement") });
    expect(JSON.stringify(air)).toBe(before);
  });

  it("returns no contradictions and opens nothing for traffic that corroborates the compiled model", async () => {
    const op = naturalReadOp();
    const air = airWith(op);
    const records = [spooled(), spooled(), spooled()];
    const result = await runDriftAlarm(air, records, { root: join(dir, ".refinement") });
    expect(result.contradictions).toHaveLength(0);
    expect(result.opened).toHaveLength(0);
  });
});
