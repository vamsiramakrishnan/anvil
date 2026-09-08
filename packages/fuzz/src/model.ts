import { z } from "zod";

const Json = z.json();
export type JsonValue = z.infer<typeof Json>;
const Identifier = z.string().min(1).max(200);
export const Step = z.object({
  id: Identifier,
  operation: Identifier,
  input: z.record(z.string(), Json).default({}),
  /** Dependencies preserve stateful prerequisites during generation and shrinking. */
  requires: z.array(Identifier).max(100).default([]),
  /** Bind an input field to a prior successful result, using an RFC 6901 pointer. */
  bindings: z
    .record(z.string(), z.object({ step: Identifier, pointer: z.string().max(1000) }))
    .default({}),
  /** Interpreted by the fixture adapter; the core has no transport semantics. */
  fault: z.record(z.string(), Json).optional(),
  tags: z.array(z.string().max(200)).max(30).default([]),
});
export type Step = z.infer<typeof Step>;
export const Scenario = z.object({
  id: Identifier,
  steps: z.array(Step).min(1).max(100),
});
export type Scenario = z.infer<typeof Scenario>;
export const Outcome = z.object({
  status: z.enum(["ok", "error", "unsupported", "inconclusive"]),
  value: Json.default(null),
  errorCode: z.string().optional(),
  /** Independent fixture state and wire observations, never supplied by an agent. */
  effects: Json.optional(),
  wire: Json.optional(),
});
export type Outcome = z.infer<typeof Outcome>;
export interface Event {
  step: Step;
  input: Record<string, JsonValue>;
  outcome: Outcome;
}
export interface Trace {
  driver: string;
  events: Event[];
  error?: string;
}
export interface Check {
  id: string;
  status: "passed" | "failed" | "unsupported" | "inconclusive";
  driver?: string;
  stepId?: string;
  operation?: string;
  detail: string;
}
export interface DriverSession {
  invoke(step: Step, signal: AbortSignal): Promise<Outcome>;
  close(): Promise<void>;
}
export interface Driver {
  id: string;
  /** Must create a fresh, isolated equivalent fixture for EVERY invocation. */
  open(context: { seed: number; signal: AbortSignal }): Promise<DriverSession>;
}
export type Property = (scenario: Scenario, traces: readonly Trace[]) => Check[];
export interface CaseResult {
  scenario: Scenario;
  traces: Trace[];
  checks: Check[];
}
export const Replay = z.object({
  schemaVersion: z.literal(1),
  scenario: Scenario,
  seed: z.number().int(),
  drivers: z.array(Identifier).min(1),
  /** Producer-owned hashes bind the case to the tested source, fixture and adapter. */
  identity: z.record(z.string(), z.string()).default({}),
  fingerprint: z.string(),
  path: z.string().optional(),
});
export type Replay = z.infer<typeof Replay>;
export interface CampaignReport {
  schemaVersion: 1;
  status: Check["status"];
  seed: number;
  runs: number;
  shrinks: number;
  elapsedMs: number;
  drivers: string[];
  identity: Record<string, string>;
  /** Explicitly acknowledged revision changes during a repair replay. */
  identityChanges?: Record<string, { recorded: string; current: string }>;
  coverage: { scenarios: number; operations: string[]; checks: Record<Check["status"], number> };
  /** The minimized failing case, or the latest non-passing diagnostic case. */
  diagnostic?: CaseResult;
  replay?: Replay;
}
