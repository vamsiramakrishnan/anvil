#!/usr/bin/env node
// Corpus-differential CI harness. Two modes:
//
//   node tools/corpus/run.mjs quick
//     Compile all systems from docs/backtesting/reproduce/systems.tsv, apply
//     every oracle, compare against tools/corpus/baseline.json. Exits non-zero
//     on any regression. Flags: --systems a,b  --work <dir>  --update-baseline
//
//   node tools/corpus/run.mjs sweep --limit N --seed S
//     Deterministic seeded sample of N specs from apis.guru, compiled raw (no
//     trim, no manifest), invariant oracles only. Informational: exits
//     non-zero only on `crash`. Flags: --work <dir>
//
// See README.md for the oracle rationale and the outcome taxonomy.

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ANVIL,
  ROOT,
  SWEEP_COMPILE_CAP_MS,
  compileCompletes,
  determinism,
  lintPasses,
  looksLikeCrash,
  namingDifferential,
  parseOpCount,
  parseSourceId,
  roundTrip,
  runNode,
  selftestPasses,
  sizeBlowup,
  sizeBudget,
  timeBudget,
} from "./oracles.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPRODUCE_DIR = join(ROOT, "docs", "backtesting", "reproduce");
const REPRODUCE_SH = join(REPRODUCE_DIR, "reproduce.sh");
const BASELINE_PATH = join(HERE, "baseline.json");
const ESTATES_TSV = join(HERE, "estates.tsv");
const ESTATES_BASELINE_PATH = join(HERE, "estates-baseline.json");
const EXPECTED_DIR = join(HERE, "expected");
const REPORT_DIR = join(HERE, "report");
const APIS_GURU_LIST = "https://api.apis.guru/v2/list.json";
const QUICK_COMPILE_CAP_MS = 300_000; // generous ceiling; the real gate is 2x baseline

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const args = { mode, limit: 25, seed: 42, systems: null, work: null, updateBaseline: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--limit") args.limit = Number(rest[++i]);
    else if (a === "--seed") args.seed = Number(rest[++i]);
    else if (a === "--systems") args.systems = rest[++i].split(",");
    else if (a === "--work") args.work = rest[++i];
    else if (a === "--update-baseline") args.updateBaseline = true;
    else throw new Error(`unknown flag: ${a}`);
  }
  return args;
}

function readSystemsTsv() {
  const rows = readFileSync(join(REPRODUCE_DIR, "systems.tsv"), "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"));
  return rows.map((l) => {
    const [name, format, url, curated, trimmer] = l.split("\t");
    return { name, format, url, curated, trimmer };
  });
}

function preparedPath(work, sys) {
  if (sys.format === "graphql") return join(work, `${sys.name}.graphql`);
  if (sys.format === "protobuf") return join(work, `${sys.name}.proto`);
  return join(work, `${sys.name}.spec.json`);
}

/** curl (respects the proxy env, unlike bare fetch) with a byte destination. */
function curlTo(url, dest, { maxTimeSec = 120 } = {}) {
  const t0 = performance.now();
  const res = spawnSync(
    "curl",
    ["-fsSL", "--max-time", String(maxTimeSec), url, "-o", dest],
    { encoding: "utf8" },
  );
  return { ok: res.status === 0, ms: Math.round(performance.now() - t0), stderr: res.stderr ?? "" };
}

// --- deterministic seeded sampling (mulberry32) -----------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededSample(items, n, seed) {
  const rand = mulberry32(seed);
  const arr = [...items]; // caller passes a stable-sorted list
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, n);
}

// --- reporting ---------------------------------------------------------------

function initReport() {
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(join(REPORT_DIR, "report.jsonl"), "");
}

function reportLine(record) {
  appendFileSync(join(REPORT_DIR, "report.jsonl"), `${JSON.stringify(record)}\n`);
}

function writeSummary(lines) {
  writeFileSync(join(REPORT_DIR, "summary.md"), `${lines.join("\n")}\n`);
}

function fmtOracles(oracles) {
  return oracles.map((o) => `${o.ok ? "PASS" : "FAIL"} ${o.name}`).join(", ");
}

// --- shared compile step ------------------------------------------------------

/**
 * source-add + compile (twice, for the determinism oracle) a prepared spec.
 * Returns { classification, sourceId, compileMs, airBytes, opCount, bundleDir,
 *           oracles: [...], compileOut }
 */
async function compileAndCheck({ specPath, service, root, outBase, manifest, capMs, extraArgs = [] }) {
  const oracles = [];
  const addOut = runNode([ANVIL, "source", "add", specPath, "--root", root], {
    timeoutMs: capMs,
  });
  if (addOut.status !== 0) {
    if (looksLikeCrash(addOut)) {
      return { classification: "crash", stage: "source-add", oracles, out: addOut };
    }
    return { classification: "source-invalid", stage: "source-add", oracles, out: addOut };
  }
  const sourceId = parseSourceId(addOut);
  if (!sourceId) {
    return { classification: "crash", stage: "source-add", oracles, out: addOut, note: "no source id in output" };
  }

  const compileArgs = (out) => [
    ANVIL,
    "compile",
    "--source",
    sourceId,
    "--root",
    root,
    ...(manifest ? ["--manifest", manifest] : []),
    "--service",
    service,
    "--out",
    out,
    ...extraArgs,
  ];

  const bundleDir = `${outBase}-a`;
  const compileOut = runNode(compileArgs(bundleDir), { timeoutMs: capMs });
  if (compileOut.timedOut) {
    return { classification: "timeout", stage: "compile", oracles, out: compileOut, sourceId };
  }
  if (compileOut.status !== 0 || !existsSync(join(bundleDir, "air.json"))) {
    const classification = looksLikeCrash(compileOut) ? "crash" : "compile-error";
    return { classification, stage: "compile", oracles, out: compileOut, sourceId };
  }
  oracles.push(compileCompletes(compileOut, bundleDir));

  // Second compile of the same locked source: the determinism oracle.
  const bundleDirB = `${outBase}-b`;
  const compileOutB = runNode(compileArgs(bundleDirB), { timeoutMs: capMs });
  if (compileOutB.status === 0 && existsSync(join(bundleDirB, "air.json"))) {
    oracles.push(determinism(bundleDir, bundleDirB));
  } else {
    oracles.push({
      name: "determinism",
      ok: false,
      detail: `second compile of ${sourceId} failed (exit ${compileOutB.status ?? compileOutB.signal})`,
    });
  }

  oracles.push(await roundTrip(bundleDir));
  oracles.push(lintPasses(bundleDir));

  const airBytes = statSync(join(bundleDir, "air.json")).size;
  const opCount = parseOpCount(compileOut);
  return {
    classification: "ok",
    sourceId,
    compileMs: compileOut.ms,
    airBytes,
    opCount,
    bundleDir,
    oracles,
    out: compileOut,
  };
}

// --- quick mode ---------------------------------------------------------------

async function quick(args) {
  const systems = readSystemsTsv().filter((s) => !args.systems || args.systems.includes(s.name));
  if (systems.length === 0) throw new Error("no systems matched");
  const baseline = existsSync(BASELINE_PATH)
    ? JSON.parse(readFileSync(BASELINE_PATH, "utf8"))
    : { systems: {} };
  const work = args.work ?? mkdtempSync(join(tmpdir(), "anvil-corpus-quick-"));
  mkdirSync(work, { recursive: true });
  initReport();
  process.stderr.write(`work dir: ${work}\n`);

  const results = [];
  for (const sys of systems) {
    process.stderr.write(`\n=== quick: ${sys.name} ===\n`);
    const record = { mode: "quick", system: sys.name, format: sys.format, at: new Date().toISOString() };

    // Stage 1: fetch + trim via the existing recipe (PREPARE_ONLY keeps the
    // network out of the compile measurement).
    const t0 = performance.now();
    const prep = spawnSync("bash", [REPRODUCE_SH, sys.name], {
      encoding: "utf8",
      env: { ...process.env, WORK: work, PREPARE_ONLY: "1" },
      timeout: 600_000,
    });
    record.fetchMs = Math.round(performance.now() - t0);
    if (prep.status !== 0) {
      record.status = "fetch-failed";
      record.detail = (prep.stderr || prep.stdout || "").split("\n").filter(Boolean).slice(-3).join(" | ");
      results.push(record);
      reportLine(record);
      process.stderr.write(`fetch/trim FAILED: ${record.detail}\n`);
      continue;
    }

    // Stage 2: compile (timed separately) + all oracles.
    const manifest = join(REPRODUCE_DIR, "manifests", `${sys.name}.anvil.yaml`);
    const res = await compileAndCheck({
      specPath: preparedPath(work, sys),
      service: sys.name,
      root: join(work, "roots", sys.name),
      outBase: join(work, "generated", sys.name),
      manifest: existsSync(manifest) ? manifest : null,
      capMs: QUICK_COMPILE_CAP_MS,
    });

    record.classification = res.classification;
    if (res.classification !== "ok") {
      record.status = "fail";
      record.stage = res.stage;
      record.detail = (res.out?.stderr || res.out?.stdout || "")
        .split("\n").filter(Boolean).slice(-4).join(" | ").slice(0, 500);
      results.push(record);
      reportLine(record);
      process.stderr.write(`${res.classification} at ${res.stage}: ${record.detail}\n`);
      continue;
    }

    record.compileMs = res.compileMs;
    record.airBytes = res.airBytes;
    record.opCount = res.opCount;

    const base = baseline.systems?.[sys.name];
    const oracles = [
      ...res.oracles,
      timeBudget(res.compileMs, base?.compileMs),
      sizeBudget(res.airBytes, base?.airBytes),
      namingDifferential(res.bundleDir, join(EXPECTED_DIR, `${sys.name}.json`)),
      // Loopback: the bundle's own mock + MCP server prove wire fidelity and
      // the safety gates for every operation the reproduce manifest approves.
      selftestPasses(res.bundleDir),
    ];
    // Op-count differential: a *decrease* against baseline means operations
    // were silently dropped — gate on it. An increase is vendor drift: warn.
    if (base?.opCount != null && res.opCount != null) {
      if (res.opCount < base.opCount) {
        oracles.push({ name: "op-count", ok: false, detail: `dropped: ${res.opCount} < baseline ${base.opCount}` });
      } else if (res.opCount > base.opCount) {
        record.warn = `op count grew ${base.opCount} -> ${res.opCount} (vendor drift; refresh baseline when intentional)`;
        oracles.push({ name: "op-count", ok: true, detail: record.warn });
      } else {
        oracles.push({ name: "op-count", ok: true, detail: `${res.opCount} ops (matches baseline)` });
      }
    }

    record.oracles = oracles;
    record.status = oracles.every((o) => o.ok) ? "green" : "regression";
    results.push(record);
    reportLine(record);
    process.stderr.write(
      `${record.status.toUpperCase()} compile=${res.compileMs}ms air=${res.airBytes}B ops=${res.opCount} [${fmtOracles(oracles)}]\n`,
    );
    for (const o of oracles.filter((o) => !o.ok)) process.stderr.write(`  FAIL ${o.name}: ${o.detail}\n`);
  }

  // Baseline update (intentional, explicit).
  if (args.updateBaseline) {
    const systemsOut = {};
    for (const r of results.filter((r) => r.status === "green" || r.status === "regression")) {
      systemsOut[r.system] = { compileMs: r.compileMs, airBytes: r.airBytes, opCount: r.opCount };
    }
    const next = {
      updatedAt: new Date().toISOString(),
      note: "Per-system quick-mode metrics. Regenerate with: node tools/corpus/run.mjs quick --update-baseline",
      systems: { ...baseline.systems, ...systemsOut },
    };
    writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
    process.stderr.write(`\nbaseline.json updated (${Object.keys(systemsOut).length} systems)\n`);
  }

  // Summary.
  const lines = [
    "# Corpus quick run",
    "",
    `- when: ${new Date().toISOString()}`,
    `- systems: ${results.length}, green: ${results.filter((r) => r.status === "green").length}`,
    "",
    "| system | status | compile ms | air.json B | ops | failing oracles |",
    "|---|---|---:|---:|---:|---|",
    ...results.map((r) => {
      const failing = (r.oracles ?? []).filter((o) => !o.ok).map((o) => `${o.name}: ${o.detail}`).join("; ") || (r.detail ?? "");
      return `| ${r.system} | ${r.status} | ${r.compileMs ?? "-"} | ${r.airBytes ?? "-"} | ${r.opCount ?? "-"} | ${failing} |`;
    }),
  ];
  const warns = results.filter((r) => r.warn);
  if (warns.length) {
    lines.push("", "## Warnings", "", ...warns.map((r) => `- ${r.system}: ${r.warn}`));
  }
  writeSummary(lines);
  process.stderr.write(`\nreport: ${join(REPORT_DIR, "report.jsonl")}\nsummary: ${join(REPORT_DIR, "summary.md")}\n`);

  const red = results.filter((r) => r.status !== "green");
  if (red.length > 0) {
    process.stderr.write(`\nQUICK: ${red.length} system(s) red: ${red.map((r) => r.system).join(", ")}\n`);
    process.exitCode = 1;
  } else {
    process.stderr.write(`\nQUICK: all ${results.length} systems green\n`);
  }
}

// --- sweep mode -----------------------------------------------------------------

async function sweep(args) {
  const work = args.work ?? mkdtempSync(join(tmpdir(), "anvil-corpus-sweep-"));
  mkdirSync(work, { recursive: true });
  initReport();
  process.stderr.write(`work dir: ${work}\n`);

  process.stderr.write(`fetching ${APIS_GURU_LIST}\n`);
  const listPath = join(work, "apis-guru-list.json");
  const fetched = curlTo(APIS_GURU_LIST, listPath, { maxTimeSec: 120 });
  if (!fetched.ok) throw new Error(`could not fetch apis.guru list: ${fetched.stderr}`);
  const list = JSON.parse(readFileSync(listPath, "utf8"));

  // Stable universe: sorted API names; each contributes its preferred version.
  const universe = Object.keys(list).sort();
  const picked = seededSample(universe, args.limit, args.seed);
  process.stderr.write(`universe=${universe.length} sample=${picked.length} seed=${args.seed}\n`);

  const results = [];
  for (const name of picked) {
    const entry = list[name];
    const version = entry.versions[entry.preferred] ?? Object.values(entry.versions)[0];
    const url = version.swaggerUrl ?? version.swaggerYamlUrl;
    const slug = name.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase().slice(0, 80);
    const service = `svc-${createHash("sha256").update(name).digest("hex").slice(0, 8)}`;
    const record = { mode: "sweep", api: name, url, at: new Date().toISOString() };
    process.stderr.write(`\n=== sweep: ${name} ===\n`);

    const specPath = join(work, "specs", `${slug}.json`);
    mkdirSync(dirname(specPath), { recursive: true });
    const dl = curlTo(url, specPath, { maxTimeSec: 90 });
    record.fetchMs = dl.ms;
    if (!dl.ok) {
      record.classification = "source-invalid";
      record.detail = `fetch failed: ${dl.stderr.split("\n")[0]}`.slice(0, 300);
      results.push(record);
      reportLine(record);
      process.stderr.write(`${record.classification}: ${record.detail}\n`);
      continue;
    }
    record.specBytes = statSync(specPath).size;

    const res = await compileAndCheck({
      specPath,
      service,
      root: join(work, "roots", slug),
      outBase: join(work, "generated", slug),
      manifest: null,
      capMs: SWEEP_COMPILE_CAP_MS,
    });

    if (res.classification !== "ok") {
      record.classification = res.classification;
      record.stage = res.stage;
      record.detail = (res.out?.stderr || res.out?.stdout || "")
        .split("\n").filter(Boolean).slice(-4).join(" | ").slice(0, 500);
    } else {
      record.compileMs = res.compileMs;
      record.airBytes = res.airBytes;
      record.opCount = res.opCount;
      const oracles = [...res.oracles, sizeBlowup(res.airBytes, record.specBytes)];
      record.oracles = oracles;
      const blowup = oracles.find((o) => o.name === "size-blowup" && !o.ok);
      const violated = oracles.filter((o) => !o.ok && o.name !== "size-blowup");
      record.classification = blowup ? "size-blowup" : violated.length > 0 ? "invariant-violation" : "ok";
      if (violated.length > 0) record.detail = violated.map((o) => `${o.name}: ${o.detail}`).join("; ");
    }
    results.push(record);
    reportLine(record);
    process.stderr.write(
      `${record.classification}${record.compileMs ? ` compile=${record.compileMs}ms air=${record.airBytes}B ops=${record.opCount}` : ""}${record.detail ? ` :: ${record.detail}` : ""}\n`,
    );
  }

  // Taxonomy counts + summary.
  const counts = {};
  for (const r of results) counts[r.classification] = (counts[r.classification] ?? 0) + 1;
  const lines = [
    "# Corpus sweep run",
    "",
    `- when: ${new Date().toISOString()}`,
    `- seed: ${args.seed}, limit: ${args.limit}, universe: ${universe.length}`,
    "",
    "## Taxonomy",
    "",
    ...Object.entries(counts).sort().map(([k, v]) => `- ${k}: ${v}`),
    "",
    "## Non-ok specimens",
    "",
    "| api | classification | detail |",
    "|---|---|---|",
    ...results
      .filter((r) => r.classification !== "ok")
      .map((r) => `| ${r.api} | ${r.classification} | ${(r.detail ?? "").replaceAll("|", "\\|").slice(0, 200)} |`),
  ];
  writeSummary(lines);
  process.stderr.write(`\nSWEEP taxonomy: ${JSON.stringify(counts)}\n`);
  process.stderr.write(`report: ${join(REPORT_DIR, "report.jsonl")}\nsummary: ${join(REPORT_DIR, "summary.md")}\n`);

  if ((counts.crash ?? 0) > 0) {
    process.stderr.write(`\nSWEEP: ${counts.crash} crash(es) — fatal\n`);
    process.exitCode = 1;
  }
}

// --- estates mode ---------------------------------------------------------------
//
// The gateway-estate differential. Each row of estates.tsv is imported through
// the REAL CLI seam — `anvil estate import ... --json` — twice, and gated on:
//   import-completes   exit 0 and a non-empty bundle;
//   determinism        the two runs' reports are byte-identical (bar the out dir);
//   opaque-accounting  the opaque-policy count matches the pinned baseline — a
//                      DROP means a gateway rewrite silently stopped being
//                      flagged (the exact failure the honesty invariant forbids);
//   operations-accounting  total/approved/review_required match baseline — a
//                      shift means the safety posture moved without review.
// This is complementary to the golden unit test (which pins the projection):
// here the whole pipeline runs, archive harness through bundle emission.

function readEstatesTsv() {
  return readFileSync(ESTATES_TSV, "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"))
    .map((l) => {
      const [name, vendor, fixture, api] = l.split("\t");
      return { name, vendor, fixture, api };
    });
}

/** Import one estate; returns { ok, report, out } or { ok:false, ... }. */
function importEstate(est, outDir) {
  const fixture = join(ROOT, est.fixture);
  const res = runNode(
    [ANVIL, "estate", "import", fixture, "--vendor", est.vendor, "--api", est.api, "--out", outDir, "--json"],
    { timeoutMs: 120_000 },
  );
  if (res.timedOut) return { ok: false, classification: "timeout", out: res };
  if (res.status !== 0) {
    return { ok: false, classification: looksLikeCrash(res) ? "crash" : "import-error", out: res };
  }
  let report;
  try {
    report = JSON.parse(res.stdout);
  } catch {
    return { ok: false, classification: "crash", out: res, note: "import --json did not emit JSON" };
  }
  return { ok: true, report, out: res };
}

/** Compare two reports for determinism, ignoring only the (intentionally distinct) out dir. */
function reportsMatch(a, b) {
  const strip = (r) => JSON.stringify({ ...r, out: null });
  return strip(a) === strip(b);
}

async function estates(args) {
  const rows = readEstatesTsv().filter((e) => !args.systems || args.systems.includes(e.name));
  if (rows.length === 0) throw new Error("no estates matched");
  const baseline = existsSync(ESTATES_BASELINE_PATH)
    ? JSON.parse(readFileSync(ESTATES_BASELINE_PATH, "utf8"))
    : { estates: {} };
  const work = args.work ?? mkdtempSync(join(tmpdir(), "anvil-corpus-estates-"));
  mkdirSync(work, { recursive: true });
  initReport();
  process.stderr.write(`work dir: ${work}\n`);

  const results = [];
  const baselineOut = {};
  for (const est of rows) {
    process.stderr.write(`\n=== estates: ${est.name} (${est.vendor}) ===\n`);
    const record = { mode: "estates", estate: est.name, vendor: est.vendor, at: new Date().toISOString() };

    if (!existsSync(join(ROOT, est.fixture))) {
      record.status = "fail";
      record.classification = "fixture-missing";
      record.detail = `fixture not found: ${est.fixture}`;
      results.push(record);
      reportLine(record);
      process.stderr.write(`FAIL ${record.detail}\n`);
      continue;
    }

    const first = importEstate(est, join(work, `${est.name}-a`));
    if (!first.ok) {
      record.status = "fail";
      record.classification = first.classification;
      record.detail = (first.out?.stderr || first.out?.stdout || first.note || "")
        .split("\n").filter(Boolean).slice(-3).join(" | ").slice(0, 400);
      results.push(record);
      reportLine(record);
      process.stderr.write(`${first.classification}: ${record.detail}\n`);
      continue;
    }
    const report = first.report;
    const second = importEstate(est, join(work, `${est.name}-b`));

    const base = baseline.estates?.[est.name];
    const oracles = [
      { name: "import-completes", ok: report.files > 0, detail: `${report.files} file(s), api=${report.api}` },
      {
        name: "determinism",
        ok: second.ok && reportsMatch(report, second.report),
        detail: second.ok ? "two runs identical" : `second run failed (${second.classification})`,
      },
    ];
    if (base) {
      // opaque-accounting: a DROP is a regression (a policy silently stopped
      // being flagged); a rise is drift to review. Gate on inequality either way
      // so the baseline stays an intentional, reviewed record.
      oracles.push({
        name: "opaque-accounting",
        ok: report.opaque.length === base.opaque,
        detail: `${report.opaque.length} opaque vs baseline ${base.opaque}`,
      });
      oracles.push({
        name: "operations-accounting",
        ok: JSON.stringify(report.operations) === JSON.stringify(base.operations),
        detail: `${JSON.stringify(report.operations)} vs baseline ${JSON.stringify(base.operations)}`,
      });
    } else {
      oracles.push({
        name: "baseline",
        ok: false,
        detail: "no baseline entry — run `estates --update-baseline` to pin it (reviewed)",
      });
    }

    record.files = report.files;
    record.operations = report.operations;
    record.opaque = report.opaque.length;
    record.oracles = oracles;
    record.status = oracles.every((o) => o.ok) ? "green" : "regression";
    baselineOut[est.name] = {
      files: report.files,
      operations: report.operations,
      opaque: report.opaque.length,
    };
    results.push(record);
    reportLine(record);
    process.stderr.write(
      `${record.status.toUpperCase()} files=${report.files} ops=${JSON.stringify(report.operations)} opaque=${report.opaque.length} [${fmtOracles(oracles)}]\n`,
    );
    for (const o of oracles.filter((o) => !o.ok)) process.stderr.write(`  FAIL ${o.name}: ${o.detail}\n`);
  }

  if (args.updateBaseline) {
    const next = {
      updatedAt: new Date().toISOString(),
      note: "Per-estate policy accounting. Regenerate with: node tools/corpus/run.mjs estates --update-baseline",
      estates: { ...baseline.estates, ...baselineOut },
    };
    writeFileSync(ESTATES_BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
    process.stderr.write(`\nestates-baseline.json updated (${Object.keys(baselineOut).length} estates)\n`);
  }

  const lines = [
    "# Corpus estates run",
    "",
    `- when: ${new Date().toISOString()}`,
    `- estates: ${results.length}, green: ${results.filter((r) => r.status === "green").length}`,
    "",
    "| estate | vendor | status | files | ops (total/appr/review) | opaque | failing oracles |",
    "|---|---|---|---:|---|---:|---|",
    ...results.map((r) => {
      const ops = r.operations
        ? `${r.operations.total}/${r.operations.approved}/${r.operations.review_required}`
        : "-";
      const failing = (r.oracles ?? []).filter((o) => !o.ok).map((o) => `${o.name}: ${o.detail}`).join("; ") || (r.detail ?? "");
      return `| ${r.estate} | ${r.vendor} | ${r.status} | ${r.files ?? "-"} | ${ops} | ${r.opaque ?? "-"} | ${failing} |`;
    }),
  ];
  writeSummary(lines);
  process.stderr.write(`\nreport: ${join(REPORT_DIR, "report.jsonl")}\nsummary: ${join(REPORT_DIR, "summary.md")}\n`);

  const red = results.filter((r) => r.status !== "green");
  if (red.length > 0) {
    process.stderr.write(`\nESTATES: ${red.length} estate(s) red: ${red.map((r) => r.estate).join(", ")}\n`);
    process.exitCode = 1;
  } else {
    process.stderr.write(`\nESTATES: all ${results.length} estates green\n`);
  }
}

// --- main -----------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
if (!existsSync(ANVIL)) {
  console.error(`CLI not built: ${ANVIL}\nRun \`pnpm install && pnpm build\` first.`);
  process.exit(2);
}
if (args.mode === "quick") await quick(args);
else if (args.mode === "sweep") await sweep(args);
else if (args.mode === "estates") await estates(args);
else {
  console.error(
    "usage: run.mjs quick [--systems a,b] [--update-baseline]\n     | sweep --limit N --seed S\n     | estates [--systems a,b] [--update-baseline]",
  );
  process.exit(2);
}
