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
  ledger?: "reserved" | "replay" | "in_progress" | "none";
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
}

export const noopObserver: Observer = { onRecord() {} };
