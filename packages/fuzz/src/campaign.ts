import { type Arbitrary, asyncProperty, check } from "fast-check";
import {
  type CampaignReport,
  type CaseResult,
  type Driver,
  type Property,
  Replay,
  type Scenario,
} from "./model.js";
import { failureFingerprint, runScenario } from "./runner.js";

export interface CampaignOptions {
  arbitrary: Arbitrary<Scenario>;
  drivers: readonly Driver[];
  properties: readonly Property[];
  seed?: number;
  runs?: number;
  timeoutMs?: number;
  budgetMs?: number;
  identity?: Record<string, string>;
}

/** fast-check owns generation and shrinking; the kernel owns fixtures and evidence. */
export async function runCampaign(options: CampaignOptions): Promise<CampaignReport> {
  const seed = options.seed ?? 42;
  const runs = options.runs ?? 25;
  const budgetMs = options.budgetMs ?? 120_000;
  if (
    !Number.isInteger(seed) ||
    seed < -2147483648 ||
    seed > 2147483647 ||
    !Number.isInteger(runs) ||
    runs < 1 ||
    runs > 10_000 ||
    !Number.isFinite(budgetMs) ||
    budgetMs < 1 ||
    budgetMs > 2_147_483_647
  )
    throw new Error("Invalid campaign budget or seed");
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  const report: CampaignReport = {
    schemaVersion: 1,
    status: "passed",
    seed,
    runs: 0,
    shrinks: 0,
    elapsedMs: 0,
    drivers: options.drivers.map((d) => d.id),
    identity: options.identity ?? {},
    coverage: {
      scenarios: 0,
      operations: [],
      checks: { passed: 0, failed: 0, unsupported: 0, inconclusive: 0 },
    },
  };
  const operations = new Set<string>();
  let fingerprint: string | undefined;
  let minimum: CaseResult | undefined;
  try {
    const details = await check(
      asyncProperty(options.arbitrary, async (scenario) => {
        if (controller.signal.aborted) return true;
        const result = await runScenario(scenario, options.drivers, options.properties, {
          seed,
          timeoutMs: options.timeoutMs,
          signal: controller.signal,
        });
        report.coverage.scenarios++;
        for (const trace of result.traces)
          for (const event of trace.events) operations.add(event.step.operation);
        for (const item of result.checks) report.coverage.checks[item.status]++;
        const failure = result.checks.find(
          (item) =>
            item.status === "failed" && (!fingerprint || failureFingerprint(item) === fingerprint),
        );
        if (failure) {
          fingerprint ??= failureFingerprint(failure);
          minimum = result;
          return false;
        }
        if (result.checks.some((item) => item.status !== "passed") && !minimum)
          report.diagnostic = result;
        return true;
      }),
      { seed, numRuns: runs, interruptAfterTimeLimit: budgetMs, markInterruptAsFailure: true },
    );
    report.runs = details.numRuns;
    report.shrinks = details.numShrinks;
    if (minimum && fingerprint) {
      report.status = "failed";
      report.diagnostic = minimum;
      report.replay = {
        schemaVersion: 1,
        scenario: minimum.scenario,
        seed,
        drivers: report.drivers,
        identity: report.identity,
        fingerprint,
        path: details.counterexamplePath ?? undefined,
      };
    } else if (
      details.interrupted ||
      details.failed ||
      controller.signal.aborted ||
      report.coverage.checks.inconclusive ||
      report.coverage.checks.unsupported
    ) {
      report.status =
        report.coverage.checks.unsupported &&
        !report.coverage.checks.passed &&
        !report.coverage.checks.inconclusive
          ? "unsupported"
          : "inconclusive";
    }
  } finally {
    clearTimeout(timer);
  }
  report.elapsedMs = Date.now() - started;
  report.coverage.operations = [...operations].sort();
  return report;
}

/** Replay exact minimized calls, without resampling or asking a model to repeat itself. */
export async function replayCampaign(
  replayInput: Replay,
  options: Omit<CampaignOptions, "arbitrary" | "seed" | "runs"> & {
    allowIdentityChanges?: string[];
  },
): Promise<CampaignReport> {
  const replay = Replay.parse(replayInput);
  if (
    JSON.stringify([...replay.drivers].sort()) !==
    JSON.stringify(options.drivers.map((d) => d.id).sort())
  )
    throw new Error("Replay driver set differs from the recorded campaign");
  const identityChanges: NonNullable<CampaignReport["identityChanges"]> = {};
  for (const [key, value] of Object.entries(replay.identity)) {
    const current = options.identity?.[key];
    if (current === value) continue;
    if (current === undefined || !options.allowIdentityChanges?.includes(key))
      throw new Error(`Replay identity mismatch: ${key}`);
    identityChanges[key] = { recorded: value, current };
  }
  const started = Date.now();
  const controller = new AbortController();
  const budgetMs = options.budgetMs ?? 120_000;
  if (!Number.isFinite(budgetMs) || budgetMs < 1 || budgetMs > 2_147_483_647)
    throw new Error("Invalid replay budget");
  const timer = setTimeout(() => controller.abort(), budgetMs);
  let result: CaseResult;
  try {
    result = await runScenario(replay.scenario, options.drivers, options.properties, {
      seed: replay.seed,
      timeoutMs: options.timeoutMs,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const counts = { passed: 0, failed: 0, unsupported: 0, inconclusive: 0 };
  for (const item of result.checks) counts[item.status]++;
  return {
    schemaVersion: 1,
    status: counts.failed
      ? "failed"
      : counts.inconclusive || counts.unsupported
        ? "inconclusive"
        : "passed",
    seed: replay.seed,
    runs: 1,
    shrinks: 0,
    elapsedMs: Date.now() - started,
    drivers: replay.drivers,
    identity: options.identity ?? {},
    ...(Object.keys(identityChanges).length ? { identityChanges } : {}),
    coverage: {
      scenarios: 1,
      operations: [...new Set(replay.scenario.steps.map((s) => s.operation))].sort(),
      checks: counts,
    },
    diagnostic: result,
    replay,
  };
}
