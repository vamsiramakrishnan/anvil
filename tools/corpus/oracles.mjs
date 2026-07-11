// Invariant + differential oracles for the corpus harness.
//
// Each oracle returns { name, ok, detail } and never throws for a *finding* —
// an oracle that throws is a harness bug, not a compiler bug. See README.md
// for what each oracle checks and why.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, "..", "..");
export const ANVIL = join(ROOT, "packages", "cli", "dist", "bin-anvil.js");

/** Quick-mode tolerance: fail when compile takes > 2x the baseline. */
export const TIME_TOLERANCE = 2.0;
/** Quick-mode tolerance: fail when air.json grows > 1.5x the baseline. */
export const SIZE_TOLERANCE = 1.5;
/** Sweep-mode hard cap per compile (ms). */
export const SWEEP_COMPILE_CAP_MS = 90_000;
/** Sweep-mode size-blowup: air.json > max(5 MB, 10x input spec bytes). */
export const BLOWUP_FLOOR_BYTES = 5 * 1024 * 1024;
export const BLOWUP_RATIO = 10;

let airModule;
async function air() {
  airModule ??= await import(
    pathToFileURL(join(ROOT, "packages", "air", "dist", "index.js")).href
  );
  return airModule;
}

/**
 * Run a node child (usually the anvil CLI) with a wall-clock cap.
 * Returns { status, stdout, stderr, ms, timedOut }.
 */
export function runNode(args, { timeoutMs = 600_000, cwd = ROOT } = {}) {
  const t0 = performance.now();
  const res = spawnSync(process.execPath, args, {
    cwd,
    timeout: timeoutMs,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    killSignal: "SIGKILL",
  });
  const ms = Math.round(performance.now() - t0);
  const timedOut = res.error?.code === "ETIMEDOUT";
  return {
    status: res.status,
    signal: res.signal,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    error: res.error,
    ms,
    timedOut,
  };
}

/** Heuristic: did the CLI die with an uncaught exception (a crash) rather than
 * a structured diagnostic failure? Diagnostic failures print `ERROR  <code>`
 * rows; crashes print a Node stack trace. */
export function looksLikeCrash(out) {
  const text = `${out.stdout}\n${out.stderr}`;
  if (out.signal && !out.timedOut) return true; // killed by a non-timeout signal
  if (/^\s*ERROR\s{2,}\S/m.test(text)) return false; // structured diagnostic row
  return /^\s+at .+:\d+:\d+\)?$/m.test(text) || /UnhandledPromiseRejection|ERR_ASSERTION|RangeError|TypeError/.test(text);
}

/** Oracle: the compile completed and produced an air.json. */
export function compileCompletes(compileResult, bundleDir) {
  const airPath = join(bundleDir, "air.json");
  const ok = compileResult.status === 0 && existsSync(airPath);
  return {
    name: "compile-completes",
    ok,
    detail: ok
      ? `exit 0 in ${compileResult.ms}ms`
      : compileResult.timedOut
        ? `timed out after ${compileResult.ms}ms`
        : `exit ${compileResult.status ?? compileResult.signal}: ${firstLines(compileResult)}`,
  };
}

/** Oracle (quick): compile wall-clock within TIME_TOLERANCE of the baseline. */
export function timeBudget(compileMs, baselineMs) {
  if (baselineMs == null) {
    return { name: "time-budget", ok: true, detail: `no baseline; recorded ${compileMs}ms` };
  }
  const limit = Math.ceil(baselineMs * TIME_TOLERANCE);
  const ok = compileMs <= limit;
  return {
    name: "time-budget",
    ok,
    detail: `${compileMs}ms vs baseline ${baselineMs}ms (limit ${limit}ms)`,
  };
}

/** Oracle (quick): air.json bytes within SIZE_TOLERANCE of the baseline. */
export function sizeBudget(airBytes, baselineBytes) {
  if (baselineBytes == null) {
    return { name: "size-budget", ok: true, detail: `no baseline; recorded ${airBytes}B` };
  }
  const limit = Math.ceil(baselineBytes * SIZE_TOLERANCE);
  const ok = airBytes <= limit;
  return {
    name: "size-budget",
    ok,
    detail: `${airBytes}B vs baseline ${baselineBytes}B (limit ${limit}B)`,
  };
}

/** Oracle (sweep): flag pathological air.json sizes on raw, untrimmed specs. */
export function sizeBlowup(airBytes, specBytes) {
  const limit = Math.max(BLOWUP_FLOOR_BYTES, specBytes * BLOWUP_RATIO);
  const ok = airBytes <= limit;
  return {
    name: "size-blowup",
    ok,
    detail: `air.json ${airBytes}B from spec ${specBytes}B (limit ${limit}B)`,
  };
}

/**
 * Oracle: round-trip law. airFromYaml(airToYaml(doc)) must parse and its
 * contractHash must equal the original document's.
 */
export async function roundTrip(bundleDir) {
  const name = "round-trip";
  try {
    const A = await air();
    const doc = A.airFromJson(readFileSync(join(bundleDir, "air.json"), "utf8"));
    const h1 = A.contractHash(doc);
    const doc2 = A.airFromYaml(A.airToYaml(doc));
    const h2 = A.contractHash(doc2);
    const ok = h1 === h2;
    return { name, ok, detail: ok ? `contractHash stable (${h1.slice(0, 12)})` : `contractHash drifted: ${h1} -> ${h2}` };
  } catch (err) {
    return { name, ok: false, detail: `round-trip threw: ${err.message}` };
  }
}

/**
 * Oracle: determinism law. Two compiles of the same locked source must yield
 * byte-identical air.json. No normalization is currently applied — as of the
 * baseline commit the compiler is byte-deterministic (verified across all 18
 * quick-mode systems). If a volatile field is ever introduced, normalize it
 * here and document it in the README.
 */
export function determinism(bundleDirA, bundleDirB) {
  const name = "determinism";
  try {
    const a = readFileSync(join(bundleDirA, "air.json"));
    const b = readFileSync(join(bundleDirB, "air.json"));
    const ok = a.equals(b);
    return {
      name,
      ok,
      detail: ok
        ? `byte-identical (${a.length}B)`
        : `air.json differs between identical compiles (${a.length}B vs ${b.length}B)`,
    };
  } catch (err) {
    return { name, ok: false, detail: `comparison failed: ${err.message}` };
  }
}

/** Oracle: `anvil lint <bundle>` exits 0. */
export function lintPasses(bundleDir, { timeoutMs = 120_000 } = {}) {
  const res = runNode([ANVIL, "lint", bundleDir], { timeoutMs });
  const ok = res.status === 0;
  return {
    name: "lint",
    ok,
    detail: ok ? `exit 0 in ${res.ms}ms` : `exit ${res.status ?? res.signal}: ${firstLines(res)}`,
  };
}

/**
 * Differential naming oracle (quick mode): assert operationId -> mcp.toolName
 * and effect kind/risk against a checked-in fixture (expected/<system>.json).
 * Fixture shape: { "operations": { "<operationId>": { "toolName": "...",
 * "effect": "read|mutation", "risk": "none|low|medium|high|destructive"? } } }
 * `risk` is optional — omit to assert kind only.
 */
export function namingDifferential(bundleDir, fixturePath) {
  const name = "naming-differential";
  if (!existsSync(fixturePath)) {
    return { name, ok: true, detail: "no fixture for this system" };
  }
  try {
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
    const doc = JSON.parse(readFileSync(join(bundleDir, "air.json"), "utf8"));
    const byOpId = new Map(doc.operations.map((op) => [op.sourceRef?.operationId, op]));
    const failures = [];
    for (const [opId, want] of Object.entries(fixture.operations)) {
      const op = byOpId.get(opId);
      if (!op) {
        failures.push(`${opId}: operation missing from air.json`);
        continue;
      }
      if (op.mcp?.toolName !== want.toolName) {
        failures.push(`${opId}: toolName ${op.mcp?.toolName} != ${want.toolName}`);
      }
      if (op.effect?.kind !== want.effect) {
        failures.push(`${opId}: effect.kind ${op.effect?.kind} != ${want.effect}`);
      }
      if (want.risk !== undefined && op.effect?.risk !== want.risk) {
        failures.push(`${opId}: effect.risk ${op.effect?.risk} != ${want.risk}`);
      }
    }
    const ok = failures.length === 0;
    return {
      name,
      ok,
      detail: ok
        ? `${Object.keys(fixture.operations).length} expectations hold`
        : failures.join("; "),
    };
  } catch (err) {
    return { name, ok: false, detail: `fixture check threw: ${err.message}` };
  }
}

/** Parse "Compiled N operations" out of the CLI's compile output. */
export function parseOpCount(out) {
  const m = `${out.stdout}\n${out.stderr}`.match(/Compiled (\d+) operations/);
  return m ? Number(m[1]) : null;
}

/** Parse the locked source id out of `anvil source add` output. */
export function parseSourceId(out) {
  const m = `${out.stdout}\n${out.stderr}`.match(/src-[0-9a-f]+/);
  return m ? m[0] : null;
}

function firstLines(res, n = 3) {
  return `${res.stdout}\n${res.stderr}`
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-n)
    .join(" | ")
    .slice(0, 400);
}
