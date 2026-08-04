#!/usr/bin/env node
// Mutation gate. Deletes one safety control at a time and requires the declared
// tests to notice.
//
//   node tools/mutation/run.mjs                     all mutants
//   node tools/mutation/run.mjs --filter import-    ids containing a substring
//   node tools/mutation/run.mjs --list              print the roster, run nothing
//
// A mutant "dies" when its tests fail while it is applied. A mutant that
// survives means the control it deletes is either decorative or untested.
//
// Three things can make a mutation run report success without having tested
// anything, and each has an explicit check here rather than a hope:
//
//   1. The patch never applied. `find` must match exactly once — zero matches
//      (the source moved on) and two matches (ambiguous site) are both errors,
//      not silent skips. This is not hypothetical: a hand-run mutant in this
//      repo once looked like it survived because the shell had expanded `$1`
//      out of the search string, so the file was never edited.
//   2. The tests were already red. Every distinct test set is run once clean
//      first and must pass; against a red baseline every mutant "dies" for
//      free.
//   3. The tests never ran. A vitest invocation that collects zero tests is
//      failure, not a pass — a renamed or deleted test file would otherwise
//      read as a killed mutant.
//
// Working-tree safety: mutants are applied to real files, so the original
// bytes are restored in a `finally` and again on SIGINT/SIGTERM. Nothing is
// written unless the file is clean in git, so an interrupted run cannot eat
// uncommitted work.

import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const MUTANTS_PATH = join(HERE, "mutants.json");
const VITEST = join(ROOT, "node_modules", ".bin", "vitest");
// Generous against a contended CI runner (the slowest set here is ~30s), and
// tight enough that the one mutant that hangs rather than fails costs three
// minutes instead of the whole job. `--timeout <seconds>` overrides it.
const DEFAULT_TIMEOUT_MS = 180_000;

function parseArgs(argv) {
  const args = { filter: null, list: false, timeoutMs: DEFAULT_TIMEOUT_MS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--filter") args.filter = argv[++i];
    else if (a === "--list") args.list = true;
    else if (a === "--timeout") args.timeoutMs = Number(argv[++i]) * 1000;
    else throw new Error(`unknown flag: ${a}`);
  }
  return args;
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count++;
    from = at + needle.length;
  }
}

function gitIsClean(file) {
  const res = spawnSync("git", ["status", "--porcelain", "--", file], { cwd: ROOT, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git status failed for ${file}: ${res.stderr}`);
  return res.stdout.trim() === "";
}

// Runs vitest in its own process group and kills the group on timeout.
//
// A deleted control can hang rather than fail, and one here does: without the
// `isFile()` check, readFileSync on a FIFO blocks forever. Vitest's own
// testTimeout cannot save us — it is a timer on the event loop, and a blocking
// sync call never yields to it — so the worker sits in the read while the
// harness waits. Killing the direct child is not enough either: a fork-pool
// worker blocked in a syscall will not notice its IPC channel closing. Hence
// `detached` for a fresh process group and `kill(-pid)` to take the group with
// it. Spawning the vitest binary directly rather than through `npx` keeps that
// group small.
function runTests(testFiles, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(VITEST, ["run", "--root", ".", ...testFiles], {
      cwd: ROOT,
      env: { ...process.env, CI: "1" },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (d) => {
      output += d;
    });
    child.stderr.on("data", (d) => {
      output += d;
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      // Vitest's summary line is `Tests  21 passed (21)` or `Tests  1 failed |
      // 20 passed (21)`. A file that defines no matching test prints `Tests  no
      // tests` and exits 0; "No test files found" exits 1 with no summary at
      // all. Neither may be counted as a kill.
      const collected = /Tests\s+\d+\s+(passed|failed)/.test(output);
      resolve({ ok: !timedOut && code === 0, collected, timedOut, output });
    });
  });
}

function tail(output, lines = 25) {
  return output.trimEnd().split("\n").slice(-lines).join("\n");
}

const args = parseArgs(process.argv.slice(2));
const spec = JSON.parse(readFileSync(MUTANTS_PATH, "utf8"));
const all = spec.mutants;
const mutants = args.filter ? all.filter((m) => m.id.includes(args.filter)) : all;

if (mutants.length === 0) {
  console.error(args.filter ? `no mutants match --filter ${args.filter}` : "mutants.json declares no mutants");
  process.exit(1);
}

if (args.list) {
  for (const m of mutants) console.log(`${m.id}\n    ${m.control}\n    ${m.file}\n`);
  process.exit(0);
}

// --- Guard the working tree before touching anything. --------------------
const dirty = [...new Set(mutants.map((m) => m.file))].filter((f) => !gitIsClean(f));
if (dirty.length > 0) {
  console.error("Refusing to mutate files with uncommitted changes:");
  for (const f of dirty) console.error(`  ${f}`);
  console.error("\nCommit or stash first — an interrupted run restores the on-disk bytes, not your edits.");
  process.exit(2);
}

let inFlight = null; // { path, original }
function restore() {
  if (!inFlight) return;
  writeFileSync(inFlight.path, inFlight.original);
  inFlight = null;
}
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    restore();
    process.exit(130);
  });
}

// --- Baseline: every distinct test set must be green unmutated. -----------
const testSets = new Map();
for (const m of mutants) testSets.set(m.tests.join(" "), m.tests);

console.log(`Baseline: ${testSets.size} test set(s) must pass unmutated.`);
const redBaselines = [];
for (const [key, files] of testSets) {
  const res = await runTests(files, args.timeoutMs);
  if (res.ok && res.collected) {
    console.log(`  ok    ${key}`);
  } else {
    const why = res.timedOut ? " (timed out)" : res.collected ? "" : " (collected no tests)";
    console.log(`  RED   ${key}${why}`);
    redBaselines.push({ key, output: res.output });
  }
}
if (redBaselines.length > 0) {
  console.error("\nBaseline is not green. Every mutant would die for free against it.");
  for (const b of redBaselines) console.error(`\n--- ${b.key} ---\n${tail(b.output)}`);
  process.exit(2);
}

// --- Apply, run, restore. ------------------------------------------------
const survivors = [];
const misapplied = [];
let killed = 0;

console.log(`\nMutants: ${mutants.length}`);
for (const m of mutants) {
  const path = join(ROOT, m.file);
  const original = readFileSync(path, "utf8");
  const matches = countOccurrences(original, m.find);
  if (matches !== 1) {
    console.log(`  ERROR ${m.id} — \`find\` matched ${matches} times (expected exactly 1)`);
    misapplied.push({ id: m.id, matches });
    continue;
  }

  inFlight = { path, original };
  let res;
  try {
    writeFileSync(path, original.replace(m.find, m.replace));
    res = await runTests(m.tests, args.timeoutMs);
  } finally {
    restore();
  }

  if (res.timedOut) {
    // The baseline for this set completed, so the hang is the mutation's doing.
    // A control whose removal wedges the process is noticed about as loudly as
    // a control can be.
    killed++;
    console.log(`  killed ${m.id} (hung — deleting this control blocks forever)`);
  } else if (!res.collected) {
    console.log(`  ERROR ${m.id} — the declared tests collected nothing`);
    misapplied.push({ id: m.id, reason: "no tests collected" });
  } else if (res.ok) {
    console.log(`  LIVED ${m.id}`);
    survivors.push(m);
  } else {
    killed++;
    console.log(`  killed ${m.id}`);
  }
}

// --- Verdict. ------------------------------------------------------------
console.log(
  `\n${killed}/${mutants.length} killed, ${survivors.length} survived, ${misapplied.length} could not be applied.`,
);

if (misapplied.length > 0) {
  console.error("\nCould not be applied. A mutant that does not apply proves nothing:");
  for (const m of misapplied) {
    console.error(`  ${m.id}: ${m.reason ?? `find matched ${m.matches} times`}`);
  }
  console.error("Update tools/mutation/mutants.json to match the source, or remove the entry.");
}

if (survivors.length > 0) {
  console.error("\nSurvived. Nothing failed when these controls were deleted:");
  for (const m of survivors) {
    console.error(`\n  ${m.id}`);
    console.error(`    control: ${m.control}`);
    console.error(`    file:    ${relative(ROOT, join(ROOT, m.file))}`);
    console.error(`    tests:   ${m.tests.join(", ")}`);
  }
  console.error("\nEither the control is load-bearing and needs a test, or it is dead and should go.");
}

process.exit(survivors.length + misapplied.length > 0 ? 1 : 0);
