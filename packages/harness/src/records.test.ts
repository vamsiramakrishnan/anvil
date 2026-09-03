import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AirDocument, Operation } from "@anvil/air";
import { Operation as OperationSchema } from "@anvil/air";
import { type ExecutionRecord, JsonlRecordSpool } from "@anvil/runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readRecordSpool, runRecords, summarizeTraffic, trafficLicenses } from "./records.js";

/**
 * The recorded-traffic lane, spool to proposal. The round trip matters most:
 * the spool the RUNTIME writes must be the spool this lane reads, or the
 * flywheel has a seam in the middle where the two halves can drift apart.
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anvil-records-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function record(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    traceId: "t-1",
    operationId: "ledger.invoice.get",
    effect: "read",
    outcome: "success",
    latencyMs: 12,
    retryCount: 0,
    idempotencyKeyPresent: false,
    requestBytes: 0,
    responseBytes: 128,
    policyDecisions: [],
    confirmationRequired: false,
    confirmed: false,
    principalId: "anonymous",
    ...overrides,
  };
}

function op(overrides: Record<string, unknown> = {}): Operation {
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

describe("the spool round trip", () => {
  it("reads back exactly what the runtime's spool wrote, with the at stamp", () => {
    const spool = new JsonlRecordSpool(dir);
    spool.onRecord(record());
    spool.onRecord(record({ outcome: "error", errorCode: "rate_limited" }));
    expect(spool.count).toBe(2);

    const { records, filesRead, malformedLines } = readRecordSpool(dir);
    expect(filesRead).toBe(1);
    expect(malformedLines).toBe(0);
    expect(records).toHaveLength(2);
    expect(records[0]?.operationId).toBe("ledger.invoice.get");
    expect(records[0]?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(records[1]?.errorCode).toBe("rate_limited");
  });

  it("counts a malformed line instead of dying on it — spools are written by live processes", () => {
    const spool = new JsonlRecordSpool(dir);
    spool.onRecord(record());
    const file = readdirSync(dir).find((f) => f.endsWith(".jsonl")) as string;
    writeFileSync(join(dir, file), `${readFileSync(join(dir, file), "utf8")}{"half": `, "utf8");

    const { records, malformedLines } = readRecordSpool(dir);
    expect(records).toHaveLength(1);
    expect(malformedLines).toBe(1);
  });
});

describe("aggregation", () => {
  it("summarizes outcomes, error codes, replays, and retried successes per operation", () => {
    const [summary] = summarizeTraffic([
      { ...record(), at: "2026-08-28T01:00:00Z" },
      { ...record(), at: "2026-08-28T02:00:00Z", outcome: "error", errorCode: "rate_limited" },
      { ...record(), outcome: "success", retryCount: 1 },
      { ...record(), outcome: "success", ledger: "replay" },
      { ...record(), outcome: "dry_run" },
    ] as never);
    expect(summary).toMatchObject({
      operationId: "ledger.invoice.get",
      calls: 5,
      successes: 3,
      errors: 1,
      dryRuns: 1,
      replays: 1,
      retriedSuccesses: 1,
      errorCodes: { rate_limited: 1 },
      firstAt: "2026-08-28T01:00:00Z",
      lastAt: "2026-08-28T02:00:00Z",
    });
  });
});

describe("what traffic licenses", () => {
  const gone = (calls: number) =>
    summarizeTraffic(
      Array.from({ length: calls }, () =>
        record({ outcome: "error", errorCode: "not_found" }),
      ) as never,
    )[0] as never;

  it("claims deprecation only when every one of enough calls answered not_found", () => {
    expect(trafficLicenses(gone(5))).toEqual({
      type: "deprecated",
      value: true,
      direction: "tighten",
    });
    // Four consistent answers are still an anecdote.
    expect(trafficLicenses(gone(4))).toBeUndefined();
  });

  it("claims nothing when any call succeeded or failed differently", () => {
    const mixed = summarizeTraffic([
      ...Array.from({ length: 5 }, () => record({ outcome: "error", errorCode: "not_found" })),
      record({ outcome: "success" }),
    ] as never)[0] as never;
    expect(trafficLicenses(mixed)).toBeUndefined();
    const otherErrors = summarizeTraffic(
      Array.from({ length: 5 }, (_, i) =>
        record({ outcome: "error", errorCode: i === 0 ? "rate_limited" : "not_found" }),
      ) as never,
    )[0] as never;
    expect(trafficLicenses(otherErrors)).toBeUndefined();
  });
});

describe("the lane end to end", () => {
  it("turns a spool into evidence, a proposal, and a truthful report", () => {
    const spool = new JsonlRecordSpool(dir);
    // Healthy traffic on the read; the retired op answers not_found five times.
    for (let i = 0; i < 3; i++) spool.onRecord(record());
    for (let i = 0; i < 5; i++) {
      spool.onRecord(
        record({
          operationId: "ledger.legacy.export",
          outcome: "error",
          errorCode: "not_found",
        }),
      );
    }
    spool.onRecord(record({ operationId: "ledger.renamed.away" }));

    const air = airWith(
      op(),
      op({
        id: "ledger.legacy.export",
        canonicalName: "export_legacy",
        cli: { command: "ledger legacy export" },
        mcp: { toolName: "ledger_export_legacy" },
      }),
      op({
        id: "ledger.unused.list",
        canonicalName: "list_unused",
        cli: { command: "ledger unused list" },
        mcp: { toolName: "ledger_list_unused" },
      }),
    );
    const report = runRecords({ air, dir });

    expect(report.ok).toBe(true);
    expect(report.recordsParsed).toBe(9);
    // The application said the legacy export is gone, five times, unanimously
    // — the one safety claim traffic earns, through the same reconciler every
    // other enrichment lane uses.
    expect(report.proposal?.operations["ledger.legacy.export"]?.state).toBe("deprecated");
    // Healthy traffic corroborates; it never patches.
    expect(report.proposal?.operations["ledger.invoice.get"]).toBeUndefined();
    // The surface nobody uses and the traffic AIR does not know are both facts.
    expect(report.unobserved).toEqual(["ledger.unused.list"]);
    expect(report.unknownOperationIds).toEqual(["ledger.renamed.away"]);
  });

  it("refuses to call an empty spool a success", () => {
    const report = runRecords({ air: airWith(op()), dir });
    expect(report.ok).toBe(false);
    expect(report.detail).toContain("No records parsed");
  });
});
