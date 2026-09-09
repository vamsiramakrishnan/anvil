import {
  type CaseResult,
  type Check,
  type Driver,
  type DriverSession,
  type Event,
  type JsonValue,
  Outcome,
  type Property,
  Scenario,
  type Step,
  type Trace,
} from "./model.js";

/** Remove orphaned dependents after a shrink, without changing retained step ids. */
export function retainDependencies(steps: readonly Step[]): Step[] {
  const present = new Set<string>();
  return steps.filter((step) => {
    if (present.has(step.id)) return false;
    const dependencies = [...step.requires, ...Object.values(step.bindings).map((b) => b.step)];
    if (dependencies.some((id) => !present.has(id))) return false;
    present.add(step.id);
    return true;
  });
}

function pointer(value: JsonValue, path: string): JsonValue {
  if (path === "") return value;
  if (!path.startsWith("/")) throw new Error("Invalid result pointer");
  for (const raw of path.slice(1).split("/")) {
    if (/~(?![01])/u.test(raw)) throw new Error("Invalid result pointer escape");
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, key))
      throw new Error("Result pointer is absent");
    value = (value as Record<string, JsonValue>)[key] as JsonValue;
  }
  return value;
}

export function resolveStep(step: Step, events: readonly Event[]): Step {
  const input = { ...step.input };
  for (const [key, binding] of Object.entries(step.bindings)) {
    if (["__proto__", "prototype", "constructor"].includes(key))
      throw new Error("Unsafe binding field");
    const prior = events.find((event) => event.step.id === binding.step);
    if (prior?.outcome.status !== "ok")
      throw new Error("Binding requires a successful prior result");
    input[key] = pointer(prior.outcome.value, binding.pointer);
  }
  return { ...step, input };
}

/** Abort is passed into drivers, which must terminate their own I/O and children. */
export async function bounded<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647)
    throw new Error("Invalid timeout");
  const controller = new AbortController();
  const relay = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener("abort", relay, { once: true });
  let onAbort: () => void = () => {};
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await Promise.race([
      controller.signal.aborted
        ? Promise.reject(new Error("Campaign aborted"))
        : work(controller.signal),
      new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error("Driver deadline or campaign budget exceeded"));
        controller.signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } catch (error) {
    controller.abort();
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", relay);
    controller.signal.removeEventListener("abort", onAbort);
  }
}

export async function runScenario(
  candidate: Scenario,
  drivers: readonly Driver[],
  properties: readonly Property[],
  options: { seed?: number; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<CaseResult> {
  const scenario = Scenario.parse(candidate);
  if (!drivers.length || new Set(drivers.map((d) => d.id)).size !== drivers.length)
    throw new Error("Supply distinct drivers");
  if (retainDependencies(scenario.steps).length !== scenario.steps.length)
    throw new Error("Scenario contains duplicate or unresolved step dependencies");
  const traces: Trace[] = [];
  const checks: Check[] = [];
  const timeout = options.timeoutMs ?? 10_000;
  for (const driver of drivers) {
    const trace: Trace = { driver: driver.id, events: [] };
    traces.push(trace);
    let session: DriverSession | undefined;
    try {
      session = await bounded(
        async (signal) => {
          const opened = await driver.open({ seed: options.seed ?? 0, signal });
          if (signal.aborted) {
            await opened.close();
            throw new Error("Driver opened after deadline");
          }
          return opened;
        },
        timeout,
        options.signal,
      );
      for (const step of scenario.steps) {
        if (options.signal?.aborted) throw new Error("Campaign aborted");
        const resolved = resolveStep(step, trace.events);
        const outcome = Outcome.parse(
          await bounded(
            (signal) => (session as DriverSession).invoke(resolved, signal),
            timeout,
            options.signal,
          ),
        );
        trace.events.push({ step, input: resolved.input, outcome });
        if (outcome.status === "unsupported" || outcome.status === "inconclusive") {
          checks.push({
            id: "driver.coverage",
            status: outcome.status,
            driver: driver.id,
            stepId: step.id,
            operation: step.operation,
            detail: outcome.errorCode ?? outcome.status,
          });
          break;
        }
      }
    } catch {
      // Driver exceptions can contain credentials or source payloads. Preserve
      // structured outcomes instead; infrastructure failure is never a pass.
      trace.error = "Driver setup, binding, invocation, or deadline failed";
      checks.push({
        id: "driver.execution",
        status: "inconclusive",
        driver: driver.id,
        detail: trace.error,
      });
    } finally {
      if (session) {
        try {
          await bounded(() => (session as DriverSession).close(), timeout);
        } catch {
          checks.push({
            id: "driver.cleanup",
            status: "inconclusive",
            driver: driver.id,
            detail: "Driver cleanup failed",
          });
        }
      }
    }
  }
  for (const property of properties) {
    try {
      checks.push(...property(scenario, traces));
    } catch {
      checks.push({
        id: "property.execution",
        status: "inconclusive",
        detail: "A property could not evaluate this case",
      });
    }
  }
  if (!checks.length)
    checks.push({
      id: "property.coverage",
      status: "inconclusive",
      detail: "No assertions evaluated",
    });
  return { scenario, traces, checks };
}

export function failureFingerprint(check: Check): string {
  // Step ids and payloads are deliberately absent: they must be shrinkable.
  return JSON.stringify([check.id, check.driver ?? "", check.operation ?? ""]);
}
