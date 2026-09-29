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
  /** The response headers a provider set, in HTTP mode, when it set any. */
  headers?: Record<string, string>;
  /** What Anvil dropped from the provider's answer, and why; absent when nothing was. */
  warnings?: string[];
  /**
   * `true` when the simulator checked the call's values against their declared
   * schemas (`--validate-values`); absent when it checked required presence only.
   */
  validateValues?: true;
}

/** Where trace entries go. */
export interface TraceSink {
  write(entry: TraceEntry): void;
}

/**
 * Appends each entry as one line to a file. Writes are synchronous so a crash
 * loses nothing.
 *
 * The file is opened for append when the sink is constructed, so a path that
 * cannot be written (a missing parent directory, a read-only file) fails when
 * the simulator is set up rather than on the first call it serves.
 */
export class JsonlTrace implements TraceSink {
  constructor(readonly path: string) {
    try {
      appendFileSync(path, "", "utf8");
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      throw new Error(`Cannot write the call trace to '${path}': ${why}`);
    }
  }

  write(entry: TraceEntry): void {
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, "utf8");
  }
}

/**
 * Write one entry, never letting a trace failure change the call it records.
 * The call has already happened (a provider may have committed a mutation), so
 * turning it into an error would tell the agent something false. The failure
 * goes to `report` (stderr by default) and is returned, one line, for a caller
 * that can also surface it on the response.
 */
export function writeTrace(
  sink: TraceSink | undefined,
  entry: TraceEntry,
  report: (message: string) => void = (message) => process.stderr.write(`${message}\n`),
): string | undefined {
  if (!sink) return undefined;
  try {
    sink.write(entry);
    return undefined;
  } catch (err) {
    const why = (err instanceof Error ? err.message : String(err)).replace(/[\r\n]+/g, " ");
    const message = `anvil simulator: trace write failed for ${entry.requestId}: ${why}`;
    report(message);
    return message;
  }
}
