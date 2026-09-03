#!/usr/bin/env node
// The refinement loop, running itself.
//
// Every stage of the quality flywheel already exists as a command a human can
// type: `anvil refine run` proposes, `anvil benchmark` measures routing and
// clusters mis-routes, `anvil refine export-task <dir> group:<id>` hands a
// cluster to a coding harness. Nothing runs them unless someone remembers to.
// This script is that memory: for each row of estates.tsv (the same local,
// offline gateway-estate fixtures `run.mjs estates` compiles), in a per-run
// workspace, it drives the REAL CLI seam —
//
//   `anvil estate import`  →  `anvil refine run --out`  →  `anvil benchmark
//   --catalog both`  →  read confusion.clusters from benchmark.report.json
//   (already floored at MIN_CLUSTER_EVIDENCE by analyzeConfusion — see
//   @anvil/refinement's clusters.ts) → `anvil refine export-task … group:<id>`
//   for each one
//
// — then writes one schema-validated report (refine-loop.report.json,
// schema in refine-loop.schema.json) and a Markdown summary a workflow posts
// to a single rolling "Refinement inbox" issue (see .github/workflows/corpus.yml).
//
// Deterministic; no model calls (the CLI's default lexical router only); no
// network beyond what the corpus already allows — every estate row is a local
// fixture under packages/compiler/src/gateway/golden/estates/.
//
// The pipeline steps named above are driven through the real `anvil` binary,
// exactly as every other corpus lane drives the CLI it is regression-testing —
// a bug in argument parsing or output wiring is exactly the kind of thing this
// harness exists to catch (see README.md's history of CLI-level regressions).
// One piece has no CLI surface at all: per-operation attribution for the
// LADDERED catalog (`anvil benchmark`'s report carries only the aggregate
// `catalogs.laddered` figure — see packages/refinement/src/benchmark/report.ts).
// For that one piece only, this script imports @anvil/refinement's built dist
// directly (the same functions `anvil benchmark --catalog both` calls
// internally: `lexicalRouter`, `benchmarkOperations`, `ladderedCatalog`,
// `stagedRoute`) and re-derives the identical per-task outcomes — never a
// second implementation of what "laddered routing" means, just the existing
// one read at finer grain than the CLI's own report exposes.
//
// Rows come from two files, acquired two different ways:
//   - estates.tsv (gateway estates)  → `anvil estate import`. These pin route-
//     only fidelity (naming, effect/risk classification, policy accounting)
//     over the local gateway fixtures and, by design, import with ZERO
//     approved operations — see README.md's Refine-loop mode section for why.
//   - refine-estates.tsv (direct specs) → `anvil compile --manifest`. These
//     carry an approved-operation-bearing manifest, so the routing-accuracy
//     ratchet below has at least one row with real signal instead of 0/0.
// Downstream of "how the bundle was acquired" every row is identical: the
// same `runOnBundle` (refine run → benchmark --catalog both → clusters →
// export-task → ratchet) runs over whatever bundle directory it received.
//
// Usage:
//   node tools/corpus/refine-loop.mjs [--systems a,b] [--work <dir>]
//                                     [--estates-file <tsv>]
//                                     [--refine-estates-file <tsv>]
//                                     [--repo-root <dir>]
//                                     [--update-routing-baseline]

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ANVIL, ROOT, runNode } from "./oracles.mjs";
import { validateAgainstSchema } from "./schema-check.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ESTATES_TSV = join(HERE, "estates.tsv");
const DEFAULT_REFINE_ESTATES_TSV = join(HERE, "refine-estates.tsv");
const ROUTING_BASELINE_PATH = join(HERE, "routing-baseline.json");
const SCHEMA_PATH = join(HERE, "refine-loop.schema.json");
const REPORT_DIR = join(HERE, "report");
const REPORT_PATH = join(REPORT_DIR, "refine-loop.report.json");
const SUMMARY_PATH = join(REPORT_DIR, "refine-loop-summary.md");

/** A DROP beyond this many routing-accuracy points fails the job. Mirrors the
 *  naming-conformance ratchet's "growth fails" shape, applied to accuracy
 *  instead of a defect count: unlike naming, routing accuracy is expected to
 *  jitter by fractions of a point as fixtures evolve, so the ratchet needs a
 *  tolerance rather than a bare inequality — 1.0 pt is one flipped task out of
 *  a catalog small enough that any single flip is worth naming, not noise. */
export const DROP_TOLERANCE_PTS = 1.0;

function parseArgs(argv) {
  const args = {
    systems: null,
    work: null,
    estatesFile: DEFAULT_ESTATES_TSV,
    refineEstatesFile: DEFAULT_REFINE_ESTATES_TSV,
    repoRoot: ROOT,
    updateRoutingBaseline: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--systems") args.systems = argv[++i].split(",");
    else if (a === "--work") args.work = argv[++i];
    else if (a === "--estates-file") args.estatesFile = argv[++i];
    else if (a === "--refine-estates-file") args.refineEstatesFile = argv[++i];
    else if (a === "--repo-root") args.repoRoot = argv[++i];
    else if (a === "--update-routing-baseline") args.updateRoutingBaseline = true;
    else throw new Error(`unknown flag: ${a}`);
  }
  return args;
}

export function readEstatesTsv(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"))
    .map((l) => {
      const [name, vendor, fixture, api] = l.split("\t");
      return { name, vendor, fixture, api };
    });
}

/** refine-estates.tsv's own schema (documented at the top of that file):
 *  name<TAB>vendor<TAB>spec<TAB>manifest — a direct API contract compiled via
 *  `anvil compile --manifest`, not a gateway fixture through `estate import`.
 *  A separate reader (not a `readEstatesTsv` variant) because the column
 *  shape genuinely differs: `fixture`+`api` select one API out of a
 *  multi-API gateway estate archive; `spec`+`manifest` name a contract file
 *  and the supplemental manifest to compile it with directly. */
export function readRefineEstatesTsv(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"))
    .map((l) => {
      const [name, vendor, spec, manifest] = l.split("\t");
      return { name, vendor, spec, manifest };
    });
}

// --- @anvil/refinement, loaded once from its built dist (see file header for
// why this is the one place the script reaches past the CLI). ------------------

let refinementPromise;
function refinement() {
  refinementPromise ??= import(
    pathToFileURL(join(ROOT, "packages", "refinement", "dist", "index.js")).href
  );
  return refinementPromise;
}

// --- estate import (mirrors run.mjs's `estates` mode; not exported there) -----

function importEstate(est, outDir, repoRoot) {
  const fixture = join(repoRoot, est.fixture);
  if (!existsSync(fixture)) {
    return { ok: false, classification: "fixture-missing", detail: `fixture not found: ${fixture}` };
  }
  const res = runNode(
    [
      ANVIL, "estate", "import", fixture,
      "--vendor", est.vendor, "--api", est.api,
      "--out", join(outDir, "bundle"), "--root", outDir, "--json",
    ],
    { timeoutMs: 120_000 },
  );
  if (res.timedOut) return { ok: false, classification: "timeout", detail: "estate import timed out" };
  if (res.status !== 0) {
    return { ok: false, classification: "import-error", detail: lastLines(res) };
  }
  let report;
  try {
    report = JSON.parse(res.stdout);
  } catch {
    return { ok: false, classification: "crash", detail: "estate import --json did not emit JSON" };
  }
  return { ok: true, report, bundleDir: join(outDir, "bundle") };
}

// --- direct-spec compile (refine-estates.tsv rows; not a gateway fixture) -----

/** `anvil compile <spec> --manifest <manifest>`, the same acquisition shape
 *  as `importEstate` above (fixture existence check → run the real CLI →
 *  return a bundle dir or a classified failure) but for a row that names a
 *  bare API contract plus a supplemental manifest instead of a gateway
 *  archive plus a vendor/api selector. */
function compileSpecRow(est, outDir, repoRoot) {
  const spec = join(repoRoot, est.spec);
  const manifest = join(repoRoot, est.manifest);
  if (!existsSync(spec)) {
    return { ok: false, classification: "fixture-missing", detail: `spec not found: ${spec}` };
  }
  if (!existsSync(manifest)) {
    return { ok: false, classification: "fixture-missing", detail: `manifest not found: ${manifest}` };
  }
  const res = runNode(
    [ANVIL, "compile", spec, "--manifest", manifest, "--out", join(outDir, "bundle"), "--root", outDir],
    { timeoutMs: 120_000 },
  );
  if (res.timedOut) return { ok: false, classification: "timeout", detail: "compile timed out" };
  if (res.status !== 0) {
    return { ok: false, classification: "compile-error", detail: lastLines(res) };
  }
  return { ok: true, bundleDir: join(outDir, "bundle") };
}

function lastLines(res, n = 4) {
  return `${res.stdout}\n${res.stderr}`.split("\n").filter(Boolean).slice(-n).join(" | ").slice(0, 500);
}

// --- refine run -----------------------------------------------------------------

/** `anvil refine run <bundleDir> --out <packDir>`, then read the written pack
 *  back through @anvil/refinement's own parser — the same validated shape
 *  `anvil refine review` and the console read, never hand-parsed here. */
async function runRefine(bundleDir, packDir) {
  const res = runNode([ANVIL, "refine", "run", bundleDir, "--out", packDir], { timeoutMs: 120_000 });
  if (res.status !== 0) return { ok: false, detail: lastLines(res) };
  const packPath = join(packDir, "pack.json");
  if (!existsSync(packPath)) return { ok: false, detail: "refine run produced no pack.json" };
  const { parseRefinementPack } = await refinement();
  try {
    const pack = parseRefinementPack(JSON.parse(readFileSync(packPath, "utf8")));
    return { ok: true, pack };
  } catch (err) {
    return { ok: false, detail: `pack.json failed to parse: ${err.message}` };
  }
}

/** Review-tier refinements: `improved`/`neutral` status, i.e. `approval.tier
 *  === "review"` — measured clean but awaiting a human. Mirrors pack.ts's own
 *  `summary.review` filter exactly (see packages/refinement/src/pack.ts). */
export function reviewTierRefinements(pack) {
  return pack.refinements
    .filter((r) => r.status === "improved" || r.status === "neutral")
    .map((r) => ({
      id: r.id,
      skill: r.skill,
      status: r.status,
      deficiency: r.deficiency,
      message: r.approval.reason,
    }));
}

// --- benchmark --------------------------------------------------------------

/** `anvil benchmark <bundleDir> --catalog both`, then read the report back
 *  through @anvil/refinement's own zod parser. */
async function runBenchmarkCli(bundleDir) {
  const res = runNode([ANVIL, "benchmark", bundleDir, "--catalog", "both"], { timeoutMs: 180_000 });
  if (res.status !== 0) return { ok: false, detail: lastLines(res) };
  const { BENCHMARK_REPORT_FILE, parseBenchmarkReport } = await refinement();
  const reportPath = join(bundleDir, BENCHMARK_REPORT_FILE);
  if (!existsSync(reportPath)) return { ok: false, detail: "benchmark produced no report" };
  try {
    const report = parseBenchmarkReport(JSON.parse(readFileSync(reportPath, "utf8")));
    return { ok: true, report };
  } catch (err) {
    return { ok: false, detail: `benchmark.report.json failed to parse: ${err.message}` };
  }
}

/** Per-(operationId, intent) pass/fail for the FLAT catalog, read straight off
 *  the report the CLI already wrote — `curated.pass` is exactly what
 *  `catalogs.flat.accuracy` (curatedRouted/total) is built from. */
function flatTasks(report) {
  return report.operations.flatMap((op) =>
    op.tasks.map((t) => ({ operationId: op.operationId, intent: t.intent, pass: t.curated.pass })),
  );
}

/**
 * Per-(operationId, intent) pass/fail for the LADDERED catalog. No CLI report
 * field carries this (only the aggregate `catalogs.laddered`), so this
 * re-derives it with the exact functions `runCatalogsComparison` in
 * packages/cli/src/commands/benchmark.ts calls — same router, same ladder
 * plan, same `stagedRoute` — over the bundle's own `air.json`. Not a second
 * definition of "laddered routing": the same one, read at per-task grain.
 */
async function ladderedTasks(air) {
  const { lexicalRouter, benchmarkOperations, ladderedCatalog, stagedRoute } = await refinement();
  const router = lexicalRouter();
  const ladder = ladderedCatalog(air);
  const ops = benchmarkOperations(air);
  const tasks = [];
  for (const op of ops) {
    for (const intent of op.skill.intentExamples) {
      const outcome = await stagedRoute(router, intent, ladder, op.id);
      tasks.push({ operationId: op.id, intent, pass: outcome.pass });
    }
  }
  return tasks;
}

function catalogFromTasks(tasks) {
  const total = tasks.length;
  const passed = tasks.filter((t) => t.pass).length;
  return { accuracy: total > 0 ? passed / total : 0, total, tasks };
}

// --- routing-accuracy ratchet (pure; mutation-gated) --------------------------

/** Tasks that passed in the baseline and fail now, in the same shape
 *  `packages/refinement/src/protocol/group.ts`'s `flippedToFail` uses
 *  (`{ operationId, intent }`) — a different comparison axis (across two runs
 *  of the SAME catalog over time, not current-vs-hypothetical within one run),
 *  reusing the shape because it is exactly what "which task got worse" means
 *  in both places. */
export function diffFlippedToFail(baselineTasks, currentTasks) {
  const baselineByKey = new Map((baselineTasks ?? []).map((t) => [`${t.operationId} ${t.intent}`, t.pass]));
  const flipped = [];
  for (const t of currentTasks) {
    const key = `${t.operationId} ${t.intent}`;
    if (baselineByKey.get(key) === true && t.pass === false) {
      flipped.push({ operationId: t.operationId, intent: t.intent });
    }
  }
  return flipped;
}

/**
 * One catalog's ratchet verdict: `ok` is false only when accuracy dropped
 * BEYOND `toleranceDeltaPts` (a drop of exactly the tolerance still passes —
 * "beyond" means strictly more). No baseline entry is not a failure — it is
 * the first-run state, recorded rather than gated, mirroring every other
 * baseline in this directory (`baseline.json`, `naming-baseline.json`).
 */
export function computeCatalogRatchet(current, baselineEntry, toleranceDeltaPts = DROP_TOLERANCE_PTS) {
  if (!baselineEntry) {
    return {
      accuracy: current.accuracy,
      total: current.total,
      hasBaseline: false,
      baselineAccuracy: 0,
      deltaPts: 0,
      ok: true,
      flippedToFail: [],
      detail: `no baseline; recorded ${(current.accuracy * 100).toFixed(1)}% (${current.total} tasks)`,
    };
  }
  const deltaPts = Math.round((current.accuracy - baselineEntry.accuracy) * 1000) / 10;
  const flippedToFail = diffFlippedToFail(baselineEntry.tasks, current.tasks);
  const ok = deltaPts >= -toleranceDeltaPts;
  return {
    accuracy: current.accuracy,
    total: current.total,
    hasBaseline: true,
    baselineAccuracy: baselineEntry.accuracy,
    deltaPts,
    ok,
    flippedToFail,
    detail:
      `${(current.accuracy * 100).toFixed(1)}% vs baseline ${(baselineEntry.accuracy * 100).toFixed(1)}%` +
      ` (${deltaPts >= 0 ? "+" : ""}${deltaPts.toFixed(1)} pts)`,
  };
}

// --- cluster export -----------------------------------------------------------

/** `anvil refine export-task <bundleDir> group:<cluster.id> --out <file>` for
 *  every cluster the benchmark reported — every cluster in the report already
 *  cleared MIN_CLUSTER_EVIDENCE (analyzeConfusion filters below it before it
 *  is ever written), so "clusters above the evidence floor" is simply every
 *  cluster this report carries. */
function exportClusterTask(bundleDir, cluster, outDir, repoRoot) {
  mkdirSync(outDir, { recursive: true });
  const taskPath = join(outDir, `${cluster.id}.task.json`);
  const res = runNode(
    [ANVIL, "refine", "export-task", bundleDir, `group:${cluster.id}`, "--out", taskPath, "--repo-root", repoRoot],
    { timeoutMs: 60_000 },
  );
  if (res.status !== 0 || !existsSync(taskPath)) {
    return { ok: false, detail: lastLines(res) };
  }
  return { ok: true, taskPath };
}

// --- one bundle (the pipeline after a bundle directory exists) ----------------

/**
 * The pipeline body, factored out from estate acquisition so it can be driven
 * directly against any bundle directory (or bare air.yaml — `resolveBundleDir`
 * accepts either) — used both by `runEstateRow` below (a real `estate import`
 * output) and by refine-loop.test.ts (a synthetic fixture, the way
 * refine-group.test.ts builds one), so the review-tier/cluster/ratchet logic
 * is tested without needing a confusable-tool gateway fixture on disk.
 */
export async function runOnBundle(name, vendor, bundleDir, rowDir, repoRoot, routingBaseline) {
  const record = { estate: name, vendor, bundleDir: relative(ROOT, bundleDir) };
  const packDir = join(rowDir, "pack");
  const refined = await runRefine(bundleDir, packDir);
  if (!refined.ok) {
    record.status = "fail";
    record.classification = "refine-error";
    record.detail = refined.detail;
    return record;
  }
  record.refine = {
    packDir: relative(ROOT, packDir),
    summary: refined.pack.summary,
    reviewRefinements: reviewTierRefinements(refined.pack),
  };

  const benchmarked = await runBenchmarkCli(bundleDir);
  if (!benchmarked.ok) {
    record.status = "fail";
    record.classification = "benchmark-error";
    record.detail = benchmarked.detail;
    return record;
  }
  const report = benchmarked.report;
  record.benchmark = {
    bundleHash: report.bundleHash,
    router: report.router,
    catalogSize: report.catalogSize,
    summary: report.summary,
  };

  // loadAir (not a hand-rolled air.json read): accepts a bundle directory or a
  // bare air.yaml alike, same resolution the CLI itself uses, so a fixture
  // with only air.yaml on disk (no compiled air.json) works here too.
  const { loadAir } = await refinement();
  const air = loadAir(bundleDir);
  const currentFlat = catalogFromTasks(flatTasks(report));
  const currentLaddered = catalogFromTasks(await ladderedTasks(air));
  const baselineEstate = routingBaseline.estates?.[name];
  record.routing = {
    flat: computeCatalogRatchet(currentFlat, baselineEstate?.flat),
    laddered: computeCatalogRatchet(currentLaddered, baselineEstate?.laddered),
  };
  // Carried separately from the ratchet verdict so --update-routing-baseline
  // can bank the raw numbers without re-deriving them from `ok`/`detail`.
  record._currentRouting = { flat: currentFlat, laddered: currentLaddered };

  const clusterDir = join(rowDir, "clusters");
  record.clusters = [];
  for (const cluster of report.confusion.clusters) {
    const exported = exportClusterTask(bundleDir, cluster, clusterDir, repoRoot);
    record.clusters.push({
      id: cluster.id,
      taskCount: cluster.taskCount,
      members: cluster.members.map((m) => m.toolName),
      sharedTokens: cluster.sharedTokens,
      exportOk: exported.ok,
      ...(exported.ok ? { exportedTaskPath: relative(ROOT, exported.taskPath) } : { exportDetail: exported.detail }),
    });
  }

  const ratchetOk = record.routing.flat.ok && record.routing.laddered.ok;
  record.status = ratchetOk ? "green" : "regression";
  record.classification = "ok";
  return record;
}

// --- one row (acquires a bundle — `estate import` or `compile`, by row kind
// — then runOnBundle) ------------------------------------------------------------

async function runEstateRow(est, work, repoRoot, routingBaseline) {
  const rowDir = join(work, est.name);
  mkdirSync(rowDir, { recursive: true });

  // The only branch downstream of "how was this bundle acquired": a gateway
  // row (estates.tsv) goes through `estate import`, a direct-spec row
  // (refine-estates.tsv) through `compile`. Everything after — runOnBundle
  // (refine run, benchmark --catalog both, clusters, export-task, ratchet) —
  // is identical for both.
  const acquired = est.kind === "spec" ? compileSpecRow(est, rowDir, repoRoot) : importEstate(est, rowDir, repoRoot);
  if (!acquired.ok) {
    return {
      estate: est.name,
      vendor: est.vendor,
      status: "fail",
      classification: acquired.classification ?? "import-error",
      detail: acquired.detail,
    };
  }
  return runOnBundle(est.name, est.vendor, acquired.bundleDir, rowDir, repoRoot, routingBaseline);
}

// --- report assembly ------------------------------------------------------------

function buildReport(estates, dropTolerancePts) {
  const summary = {
    estates: estates.length,
    green: estates.filter((e) => e.status === "green").length,
    totalReviewRefinements: estates.reduce((n, e) => n + (e.refine?.reviewRefinements.length ?? 0), 0),
    totalClusters: estates.reduce((n, e) => n + (e.clusters?.length ?? 0), 0),
    totalExportedTasks: estates.reduce(
      (n, e) => n + (e.clusters?.filter((c) => c.exportOk).length ?? 0),
      0,
    ),
  };

  const regressions = [];
  for (const e of estates) {
    if (!e.routing) continue;
    for (const catalog of ["flat", "laddered"]) {
      const r = e.routing[catalog];
      if (!r.ok) {
        regressions.push({
          estate: e.estate,
          catalog,
          baselineAccuracy: r.baselineAccuracy,
          currentAccuracy: r.accuracy,
          deltaPts: r.deltaPts,
          flippedToFail: r.flippedToFail,
        });
      }
    }
  }

  // Strip the internal-only carry field before this becomes the public report.
  const publicEstates = estates.map(({ _currentRouting, ...rest }) => rest);

  return {
    schemaVersion: 1,
    reportType: "anvil.refine-loop",
    generatedAt: new Date().toISOString(),
    dropTolerancePts,
    estates: publicEstates,
    summary,
    ratchet: { status: regressions.length > 0 ? "red" : "green", regressions },
  };
}

// --- Markdown summary (the body posted to the Refinement inbox issue) -----------

export function renderSummaryMarkdown(report) {
  const lines = [
    "# Refinement inbox",
    "",
    `_Generated ${report.generatedAt} by \`node tools/corpus/refine-loop.mjs\`._`,
    "",
    `- estates: ${report.summary.estates}, green: ${report.summary.green}`,
    `- review-tier refinements awaiting a human: ${report.summary.totalReviewRefinements}`,
    `- confusable-tool clusters found: ${report.summary.totalClusters} (${report.summary.totalExportedTasks} exported as harness case files)`,
    `- routing-accuracy ratchet: **${report.ratchet.status.toUpperCase()}** (drop tolerance ${report.dropTolerancePts.toFixed(1)} pt)`,
    "",
  ];

  if (report.ratchet.regressions.length > 0) {
    lines.push("## Routing-accuracy regressions", "");
    for (const r of report.ratchet.regressions) {
      lines.push(
        `- **${r.estate}** (${r.catalog}): ${(r.baselineAccuracy * 100).toFixed(1)}% → ${(r.currentAccuracy * 100).toFixed(1)}%` +
          ` (${r.deltaPts.toFixed(1)} pts)`,
      );
      for (const f of r.flippedToFail) {
        lines.push(`  - flipped to fail: \`${f.operationId}\` — "${f.intent}"`);
      }
    }
    lines.push("");
  }

  lines.push("## Per-estate", "");
  for (const e of report.estates) {
    if (e.status === "fail") {
      lines.push(`### ${e.estate} (${e.vendor}) — FAILED at ${e.classification}`, "", e.detail ?? "", "");
      continue;
    }
    const s = e.refine.summary;
    lines.push(
      `### ${e.estate} (${e.vendor}) — ${e.status === "green" ? "green" : "routing regressed"}`,
      "",
      `- refine: ${s.proposed} proposed · ${s.approved} auto-approved · ${s.review} awaiting review · ${s.rejected} rejected · ${s.regressed} regressed · ${s.skipped} skipped`,
      `- benchmark: flat ${(e.routing.flat.accuracy * 100).toFixed(1)}% (${e.routing.flat.total} tasks), laddered ${(e.routing.laddered.accuracy * 100).toFixed(1)}% (${e.routing.laddered.total} tasks), catalog size ${e.benchmark.catalogSize}`,
      `- clusters: ${e.clusters.length}`,
      "",
    );
    if (e.refine.reviewRefinements.length > 0) {
      lines.push("  Review-tier refinements:");
      for (const r of e.refine.reviewRefinements) {
        lines.push(`  - \`${r.id}\` (${r.skill}, ${r.deficiency}): ${r.message}`);
      }
      lines.push("");
    }
    for (const c of e.clusters) {
      lines.push(
        `  Cluster \`${c.id}\` — ${c.members.length} tools, ${c.taskCount} mis-routed tasks: ${c.members.join(", ")}`,
      );
      lines.push(
        c.exportOk
          ? `    exported → \`${c.exportedTaskPath}\` (hand it to a coding harness, then \`anvil refine import-proposal\`)`
          : `    export FAILED: ${c.exportDetail}`,
      );
    }
  }

  lines.push(
    "",
    "---",
    "_Nothing here was auto-applied. Review a pack with `anvil refine review <pack-dir>`, decide with `anvil refine approve|reject`, " +
      "hand a cluster to a coding harness with the exported task file, or open the workspace in `anvil console <dir>` to work the whole queue — " +
      "see docs/console.md#the-refinement-loops-packs._",
  );
  return `${lines.join("\n")}\n`;
}

// --- routing baseline -----------------------------------------------------------

function writeRoutingBaseline(estates, priorBaseline) {
  const next = { ...(priorBaseline.estates ?? {}) };
  for (const e of estates) {
    if (!e._currentRouting) continue;
    next[e.estate] = {
      flat: { accuracy: e._currentRouting.flat.accuracy, total: e._currentRouting.flat.total, tasks: e._currentRouting.flat.tasks },
      laddered: {
        accuracy: e._currentRouting.laddered.accuracy,
        total: e._currentRouting.laddered.total,
        tasks: e._currentRouting.laddered.tasks,
      },
    };
  }
  const out = {
    updatedAt: new Date().toISOString(),
    note:
      "Per-estate, per-catalog routing accuracy (regenerate with: node tools/corpus/refine-loop.mjs --update-routing-baseline). " +
      `A DROP beyond ${DROP_TOLERANCE_PTS.toFixed(1)} pt fails the refine-loop job and names the estate and flipped operations.`,
    dropTolerancePts: DROP_TOLERANCE_PTS,
    estates: next,
  };
  writeFileSync(ROUTING_BASELINE_PATH, `${JSON.stringify(out, null, 2)}\n`);
  process.stderr.write(`\nrouting-baseline.json updated (${estates.length} estate(s))\n`);
}

// --- main -------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(ANVIL)) {
    console.error(`CLI not built: ${ANVIL}\nRun \`pnpm install && pnpm build\` first.`);
    process.exit(2);
  }

  // Two row sources, tagged by acquisition kind (see runEstateRow): gateway
  // rows from estates.tsv (`estate import`), direct-spec rows from
  // refine-estates.tsv (`compile`). The refine-estates file is optional —
  // an explicit `--refine-estates-file` pointed at a missing path is an
  // error (readRefineEstatesTsv throws), but the default path silently
  // contributing zero rows if absent keeps `--estates-file` overrides (e.g.
  // in a test fixture directory with no sibling refine-estates.tsv) working
  // exactly as they did before this file existed.
  const gatewayRows = readEstatesTsv(args.estatesFile).map((e) => ({ ...e, kind: "gateway" }));
  const specRows = existsSync(args.refineEstatesFile)
    ? readRefineEstatesTsv(args.refineEstatesFile).map((e) => ({ ...e, kind: "spec" }))
    : [];
  const rows = [...gatewayRows, ...specRows].filter((e) => !args.systems || args.systems.includes(e.name));
  if (rows.length === 0) throw new Error("no estates matched");

  const routingBaseline = existsSync(ROUTING_BASELINE_PATH)
    ? JSON.parse(readFileSync(ROUTING_BASELINE_PATH, "utf8"))
    : { estates: {} };

  const work = args.work ?? mkdtempSync(join(tmpdir(), "anvil-refine-loop-"));
  mkdirSync(work, { recursive: true });
  process.stderr.write(`work dir: ${work}\n`);

  const estates = [];
  for (const est of rows) {
    process.stderr.write(`\n=== refine-loop: ${est.name} (${est.vendor}) ===\n`);
    const record = await runEstateRow(est, work, args.repoRoot, routingBaseline);
    estates.push(record);
    if (record.status === "fail") {
      process.stderr.write(`FAIL at ${record.classification}: ${record.detail}\n`);
    } else {
      process.stderr.write(
        `${record.status.toUpperCase()} refine=${JSON.stringify(record.refine.summary)} ` +
          `flat=${record.routing.flat.detail} laddered=${record.routing.laddered.detail} clusters=${record.clusters.length}\n`,
      );
    }
  }

  const report = buildReport(estates, DROP_TOLERANCE_PTS);
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
  const schemaErrors = validateAgainstSchema(schema, report);
  if (schemaErrors.length > 0) {
    // A harness bug, not a report defect: never write or post a report that
    // does not match its own declared schema.
    throw new Error(`refine-loop.report.json failed its own schema:\n  ${schemaErrors.join("\n  ")}`);
  }

  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  const summaryMd = renderSummaryMarkdown(report);
  writeFileSync(SUMMARY_PATH, summaryMd);
  process.stderr.write(`\nreport: ${REPORT_PATH}\nsummary: ${SUMMARY_PATH}\n`);

  if (args.updateRoutingBaseline) {
    writeRoutingBaseline(estates, routingBaseline);
  }

  const failed = estates.filter((e) => e.status === "fail");
  if (failed.length > 0) {
    process.stderr.write(`\nREFINE-LOOP: ${failed.length} estate(s) failed: ${failed.map((e) => e.estate).join(", ")}\n`);
    process.exitCode = 1;
  }
  if (report.ratchet.status === "red") {
    process.stderr.write("\nREFINE-LOOP: routing-accuracy ratchet regressed:\n");
    for (const r of report.ratchet.regressions) {
      const ops = [...new Set(r.flippedToFail.map((f) => f.operationId))];
      process.stderr.write(
        `  ${r.estate} (${r.catalog}): ${r.deltaPts.toFixed(1)} pts` +
          (ops.length > 0 ? ` — flipped: ${ops.join(", ")}` : "") +
          "\n",
      );
    }
    process.exitCode = 1;
  }
  if (process.exitCode !== 1) {
    process.stderr.write(`\nREFINE-LOOP: all ${estates.length} estate(s) green, ratchet holds\n`);
  }
}

// Only run when invoked directly (`node refine-loop.mjs`), not when imported
// for its pure helpers by refine-loop.test.ts.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
