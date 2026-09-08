import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  type CaseResult,
  type Driver,
  type DriverSession,
  type Event,
  Outcome,
  type Property,
  type Replay,
  Step,
} from "./model.js";
import { type ProcessSpec, processEnvironment, stopProcess } from "./process.js";
import { bounded, failureFingerprint } from "./runner.js";

export interface SkillTask {
  task: string;
  skill: string;
  references?: Record<string, string>;
  catalog: Array<{ operation: string; description: string; inputSchema?: unknown }>;
}
export interface AgentAdapter {
  id: string;
  /** Caller records model/harness versions here. No credentials. */
  metadata: Record<string, string>;
  execute(
    task: SkillTask,
    invoke: (operation: string, input: Record<string, unknown>) => Promise<Outcome>,
    signal: AbortSignal,
  ): Promise<void>;
}

const AgentMessage = z.discriminatedUnion("method", [
  z.object({
    id: z.string().min(1).max(100),
    method: z.literal("invoke"),
    operation: z.string(),
    input: z.record(z.string(), z.json()),
  }),
  z.object({ method: z.literal("complete") }),
]);

/**
 * Portable harness bridge: host sends one task JSON line; agent emits invoke
 * lines and consumes the host's outcome lines, then emits complete. stdout is
 * protocol-only. No self-reported effects or success verdict is trusted.
 */
export function processAgent(
  spec: ProcessSpec,
  metadata: Record<string, string> = {},
): AgentAdapter {
  return {
    id: "process-agent",
    metadata,
    async execute(task, invoke, signal) {
      if (signal.aborted) throw new Error("Agent aborted");
      await new Promise<void>((resolve, reject) => {
        const child = spawn(spec.command, spec.args ?? [], {
          cwd: spec.cwd,
          env: processEnvironment(spec.env),
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
        });
        let buffer = "";
        let total = 0;
        let complete = false;
        let failed = false;
        const ids = new Set<string>();
        let queue = Promise.resolve();
        const fail = () => {
          failed = true;
          stopProcess(child);
        };
        signal.addEventListener("abort", fail, { once: true });
        child.stdin.on("error", fail);
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          total += Buffer.byteLength(chunk);
          if (total > 1024 * 1024) {
            fail();
            return;
          }
          buffer += chunk;
          let newline = buffer.indexOf("\n");
          while (newline >= 0) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            queue = queue
              .then(async () => {
                if (failed || signal.aborted || complete)
                  throw new Error("Invalid agent lifecycle");
                const message = AgentMessage.parse(JSON.parse(line));
                if (message.method === "complete") {
                  complete = true;
                  child.stdin.end();
                  return;
                }
                if (ids.has(message.id)) throw new Error("Duplicate agent request id");
                ids.add(message.id);
                const outcome = await invoke(message.operation, message.input);
                if (!failed && !signal.aborted)
                  child.stdin.write(`${JSON.stringify({ id: message.id, outcome })}\n`);
              })
              .catch(fail);
            newline = buffer.indexOf("\n");
          }
        });
        child.stderr.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > 1024 * 1024) fail();
        });
        child.on("error", () => {
          signal.removeEventListener("abort", fail);
          reject(new Error("Agent process could not start"));
        });
        child.on("close", (code) => {
          void queue.then(() => {
            signal.removeEventListener("abort", fail);
            if (failed || signal.aborted || code !== 0 || !complete || buffer.trim())
              reject(new Error("Agent process did not complete its protocol"));
            else resolve();
          });
        });
        child.stdin.write(`${JSON.stringify({ protocol: "anvil-fuzz-agent/v1", ...task })}\n`);
      });
    },
  };
}

export interface SkillRun extends CaseResult {
  mode: "skill-driven";
  agent: { id: string; metadata: Record<string, string> };
  skillDigest: string;
  taskDigest: string;
  status: SkillRun["checks"][number]["status"];
  replay?: Replay;
}

/** The host observes every invocation; a completion message does not assert success. */
export async function runSkillTask(options: {
  task: SkillTask;
  agent: AgentAdapter;
  driver: Driver;
  properties: readonly Property[];
  seed?: number;
  maxCalls?: number;
  timeoutMs?: number;
  identity?: Record<string, string>;
}): Promise<SkillRun> {
  const events: Event[] = [];
  const trace = { driver: options.driver.id, events };
  const checks: SkillRun["checks"] = [];
  const maxCalls = options.maxCalls ?? 20;
  if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 100)
    throw new Error("Invalid agent call budget");
  const allowed = new Set(options.task.catalog.map((op) => op.operation));
  const skillDigest = createHash("sha256")
    .update(
      JSON.stringify({ skill: options.task.skill, references: options.task.references ?? {} }),
    )
    .digest("hex");
  let session: DriverSession | undefined;
  let activeCall = false;
  try {
    await bounded(async (signal) => {
      session = await options.driver.open({ seed: options.seed ?? 42, signal });
      if (signal.aborted) {
        await session.close();
        return;
      }
      await options.agent.execute(
        options.task,
        async (operation, input) => {
          if (signal.aborted || activeCall || events.length >= maxCalls)
            throw new Error("Agent call budget exceeded or concurrent invocation");
          if (!allowed.has(operation)) throw new Error("Agent requested an undeclared operation");
          const step = Step.parse({ id: `agent-${events.length}`, operation, input });
          activeCall = true;
          try {
            const outcome = Outcome.parse(await (session as DriverSession).invoke(step, signal));
            if (signal.aborted) throw new Error("Agent invocation aborted");
            events.push({ step, input: step.input, outcome });
            return outcome;
          } finally {
            activeCall = false;
          }
        },
        signal,
      );
      if (activeCall) throw new Error("Agent completed with an outstanding invocation");
    }, options.timeoutMs ?? 60_000);
  } catch {
    checks.push({
      id: "agent.execution",
      status: "inconclusive",
      driver: options.driver.id,
      detail: "Agent failed, exceeded its budget, or violated the tool protocol",
    });
  } finally {
    if (session) {
      try {
        await bounded(() => (session as DriverSession).close(), 10_000);
      } catch {
        checks.push({
          id: "driver.cleanup",
          status: "inconclusive",
          detail: "Agent fixture cleanup failed",
        });
      }
    }
  }
  const scenario = { id: "skill-trajectory", steps: events.map((event) => event.step) };
  if (!events.length)
    checks.push({
      id: "agent.coverage",
      status: "inconclusive",
      detail: "Agent produced no observable tool calls",
    });
  for (const event of events)
    if (event.outcome.status === "unsupported" || event.outcome.status === "inconclusive")
      checks.push({
        id: "driver.coverage",
        status: event.outcome.status,
        driver: trace.driver,
        stepId: event.step.id,
        detail: event.outcome.errorCode ?? event.outcome.status,
      });
  for (const property of options.properties) {
    try {
      checks.push(...property(scenario, [trace]));
    } catch {
      checks.push({
        id: "property.execution",
        status: "inconclusive",
        detail: "Agent trajectory could not be evaluated",
      });
    }
  }
  if (!checks.length)
    checks.push({
      id: "property.coverage",
      status: "inconclusive",
      detail: "No assertions evaluated",
    });
  const failure = checks.find((item) => item.status === "failed");
  return {
    mode: "skill-driven",
    scenario,
    traces: [trace],
    checks,
    agent: { id: options.agent.id, metadata: options.agent.metadata },
    skillDigest,
    taskDigest: createHash("sha256").update(JSON.stringify(options.task)).digest("hex"),
    status: failure
      ? "failed"
      : checks.some((c) => c.status !== "passed")
        ? "inconclusive"
        : "passed",
    ...(failure && events.length
      ? {
          replay: {
            schemaVersion: 1 as const,
            scenario,
            seed: options.seed ?? 42,
            drivers: [trace.driver],
            identity: options.identity ?? {},
            fingerprint: failureFingerprint(failure),
          },
        }
      : {}),
  };
}
