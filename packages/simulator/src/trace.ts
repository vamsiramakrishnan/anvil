/**
 * The call trace: one JSON line per invocation, so a grader can read back what
 * an agent asked for, what the provider was asked and answered, and what the
 * agent was finally served. No clock is recorded; entries are ordered by `seq`
 * and are a pure function of the call sequence, like everything else here.
 */
import { appendFileSync } from "node:fs";
import type { ProviderRequest, ProviderResponse } from "./provider.js";
import type { SimResult } from "./runtime.js";

export const TRACE_SCHEMA = "anvil.simulator.trace/v1";

export interface TraceEntry {
  schema: typeof TRACE_SCHEMA;
  /** 1-based call index within the simulator run. */
  seq: number;
  requestId: string;
  transport: "in_process" | "http";
  tool: string | null;
  operationId: string | null;
  /** The request as the agent sent it: tool input and context, or the HTTP request. */
  request: unknown;
  /** What the provider was asked; `null` when a surface gate answered first. */
  normalized: ProviderRequest | null;
  /** What the provider answered, or `{ transportError }` when it could not answer. */
  provider: ProviderResponse | { transportError: string } | null;
  /** The simulator's result before any wire encoding. */
  result: SimResult;
  /** The final HTTP status (for in-process calls, the status the same result would carry). */
  status: number;
  /** The final HTTP body, in HTTP mode. */
  response?: unknown;
}

/** Where trace entries go. */
export interface TraceSink {
  write(entry: TraceEntry): void;
}

/** Appends each entry as one line to a file. Writes are synchronous so a crash loses nothing. */
export class JsonlTrace implements TraceSink {
  constructor(readonly path: string) {}

  write(entry: TraceEntry): void {
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, "utf8");
  }
}
