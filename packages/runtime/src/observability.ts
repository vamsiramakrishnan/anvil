import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ErrorCode } from "@anvil/air";

/**
 * The execution record (spec §15). Every call emits one. It is OpenTelemetry-
 * shaped (a span with attributes) but transport-neutral so it can be exported
 * to Cloud Trace/Logging, OTLP, or captured in tests. Never contains secrets.
 */
export interface ExecutionRecord {
  traceId: string;
  operationId: string;
  effect: "read" | "mutation";
  upstreamEndpoint?: string;
  outcome: "success" | "error" | "dry_run";
  latencyMs: number;
  retryCount: number;
  idempotencyKeyPresent: boolean;
  authProfile?: string;
  errorCode?: ErrorCode;
  requestBytes: number;
  responseBytes: number;
  /** Decisions made by policy hooks, in order (e.g. "pre_execute:allow"). */
  policyDecisions: string[];
  confirmationRequired: boolean;
  confirmed: boolean;
  ledger?: "reserved" | "replay" | "in_progress" | "conflict" | "none";
}

/** Sink for execution records. Wire this to OTel/Cloud Trace in production. */
export interface Observer {
  onRecord(record: ExecutionRecord): void;
}

/** Collects records in memory — used by tests and `/metrics`. */
export class InMemoryObserver implements Observer {
  readonly records: ExecutionRecord[] = [];
  onRecord(record: ExecutionRecord): void {
    this.records.push(record);
  }
  /** Same property the spool exposes, so /metrics reads one shape. */
  get count(): number {
    return this.records.length;
  }
}

export const noopObserver: Observer = { onRecord() {} };

/**
 * Spools every execution record to newline-delimited JSON on disk, one file
 * per process, so `anvil observe --from-records` can fold real traffic back
 * into evidence. Records are the flywheel's raw material: they carry outcomes,
 * error codes, retry and ledger behaviour — and no secrets, no payloads, by
 * `ExecutionRecord`'s own contract — so a deployed bundle that spools becomes
 * a sensor for the model it was compiled from.
 *
 * Each line is stamped with the wall-clock time at write, which the record
 * itself deliberately does not carry. Write failures are swallowed after the
 * first: an observability sink must never take down the serving path, and a
 * spool that starts failing mid-flight (disk full, volume gone) degrades to
 * exactly what not configuring it would have been.
 */
export class JsonlRecordSpool implements Observer {
  private readonly file: string;
  private broken = false;
  /** Records written so far — the serving path's /metrics reads this. */
  count = 0;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, `records-${process.pid}-${Date.now()}.jsonl`);
  }

  onRecord(record: ExecutionRecord): void {
    if (this.broken) return;
    try {
      appendFileSync(this.file, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
      this.count++;
    } catch {
      this.broken = true;
    }
  }
}
