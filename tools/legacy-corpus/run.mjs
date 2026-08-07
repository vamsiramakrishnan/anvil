#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const MANIFEST_PATH = join(HERE, "systems.json");
const REPORT_DIR = join(HERE, "report");
const DEFAULT_CLI = join(ROOT, "packages/cli/dist/bin-anvil.js");
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_REPORT_BYTES = 32 * 1024 * 1024;

const args = parseArgs(process.argv.slice(2));
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
validateManifest(manifest);
const selected = manifest.systems.filter(
  (system) => !args.systems || args.systems.has(system.id),
);
if (selected.length === 0) fail("No legacy corpus systems matched --systems.");
if (args.systems) {
  const knownIds = new Set(manifest.systems.map((system) => system.id));
  const unknownIds = [...args.systems].filter((id) => !knownIds.has(id));
  if (unknownIds.length > 0) {
    fail(`Unknown legacy corpus system${unknownIds.length === 1 ? "" : "s"}: ${unknownIds.join(", ")}.`);
  }
}

const cli = resolve(args.cli ?? DEFAULT_CLI);
if (!existsSync(cli)) {
  fail(`Built Anvil CLI not found at '${cli}'. Run 'pnpm build' first.`);
}

const workParent = args.work ? resolve(args.work) : tmpdir();
mkdirSync(workParent, { recursive: true });
const work = mkdtempSync(join(workParent, "anvil-legacy-corpus-"));
const removeWork = !args.work;

try {
  const results = [];
  for (const system of selected) {
    process.stderr.write(`legacy corpus: ${system.id}\n`);
    results.push(await evaluateSystem(system, work, cli));
  }

  const report = {
    schemaVersion: 1,
    manifestSchemaVersion: manifest.schemaVersion,
    systems: results,
    score: score(results),
  };
  writeReports(report);
  process.stdout.write(renderSummary(report));
  if (results.some((result) => !result.ok)) process.exitCode = 1;
} finally {
  if (removeWork) rmSync(work, { recursive: true, force: true });
  else process.stderr.write(`legacy corpus work directory: ${work}\n`);
}

async function evaluateSystem(system, workRoot, cliPath) {
  const sourceRoot = join(workRoot, system.id);
  const localSource = join(sourceRoot, system.source.localPath);
  mkdirSync(dirname(localSource), { recursive: true });

  const bytes = await fetchPinnedSource(system);
  writeFileSync(localSource, bytes, { flag: "wx" });

  const first = runInventory(cliPath, sourceRoot, system);
  const second = runInventory(cliPath, sourceRoot, system);
  const deterministic =
    first.status === second.status &&
    first.signal === second.signal &&
    first.stdout === second.stdout &&
    first.stderr === second.stderr;
  const actual = summarizeRun(first);
  const mismatches = compareExpectation(system.expected, actual);
  if (!deterministic) mismatches.push("same pinned input produced different CLI output");

  return {
    id: system.id,
    platform: system.platform,
    repository: system.repository,
    revision: system.revision,
    sourcePath: system.source.path,
    sourceSha256: system.source.sha256,
    license: system.license,
    sourceUrl: githubBlobUrl(system),
    deterministic,
    expected: system.expected,
    actual,
    mismatches,
    ok: mismatches.length === 0,
  };
}

async function fetchPinnedSource(system) {
  const url = rawGithubUrl(system);
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
    headers: { "user-agent": "anvil-legacy-corpus/1" },
  });
  if (!response.ok) {
    throw new Error(`Could not fetch ${system.id}: HTTP ${response.status} from ${url}`);
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_SOURCE_BYTES) {
    throw new Error(`${system.id} exceeds the ${MAX_SOURCE_BYTES}-byte source limit.`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_SOURCE_BYTES) {
    throw new Error(`${system.id} exceeds the ${MAX_SOURCE_BYTES}-byte source limit.`);
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== system.source.sha256) {
    throw new Error(
      `${system.id} content digest mismatch: expected ${system.source.sha256}, received ${digest}.`,
    );
  }
  return bytes;
}

function runInventory(cliPath, sourceRoot, system) {
  const child = spawnSync(
    process.execPath,
    [
      cliPath,
      "legacy",
      "inventory",
      sourceRoot,
      "--environment",
      "github-corpus",
      "--application",
      system.id,
      "--estate",
      system.id,
      "--source-id",
      `github-${system.id}`,
      "--source-kind",
      "source_repository",
      "--revision",
      system.revision,
      "--collector",
      "auto",
      "--json",
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: MAX_REPORT_BYTES,
      timeout: 90_000,
    },
  );
  return {
    status: child.status,
    signal: child.signal,
    stdout: child.stdout ?? "",
    stderr: child.stderr ?? "",
    error: child.error?.message,
  };
}

function summarizeRun(run) {
  if (run.error || run.signal || run.status === null) {
    return {
      classification: "crash",
      exitCode: run.status,
      collectors: [],
      observations: 0,
      candidates: 0,
      conflicts: 0,
      diagnostics: [],
      processError: run.error ?? `terminated by ${run.signal}`,
    };
  }

  let report;
  try {
    report = JSON.parse(run.stdout);
  } catch {
    return {
      classification: "crash",
      exitCode: run.status,
      collectors: [],
      observations: 0,
      candidates: 0,
      conflicts: 0,
      diagnostics: [],
      processError: "CLI did not emit a JSON legacy inventory report",
    };
  }

  const diagnostics = (report.inventory?.diagnostics ?? [])
    .map((diagnostic) => diagnostic.code)
    .sort();
  const collectors = (report.collectors ?? []).map((entry) => entry.collector).sort();
  const summary = report.summary ?? {};
  return {
    classification: classify(summary, diagnostics),
    exitCode: run.status,
    collectors,
    observations: summary.observations ?? 0,
    candidates: summary.candidates ?? 0,
    conflicts: summary.conflicts ?? 0,
    diagnostics,
  };
}

function classify(summary, diagnostics) {
  if (
    diagnostics.some((code) =>
      /(?:secret_like|unsafe_xml_construct|forbidden_xml_construct)/u.test(code),
    )
  ) {
    return "safety-refusal";
  }
  if ((summary.candidates ?? 0) === 0) return "unsupported";
  if ((summary.diagnostics?.error ?? 0) > 0 || (summary.diagnostics?.warning ?? 0) > 0) {
    return "partial";
  }
  return "supported";
}

function compareExpectation(expected, actual) {
  const mismatches = [];
  for (const key of [
    "classification",
    "exitCode",
    "collectors",
    "observations",
    "candidates",
    "conflicts",
    "diagnostics",
  ]) {
    if (canonical(expected[key]) !== canonical(actual[key])) {
      mismatches.push(
        `${key}: expected ${JSON.stringify(expected[key])}, received ${JSON.stringify(actual[key])}`,
      );
    }
  }
  return mismatches;
}

function score(results) {
  const classifications = {
    supported: 0,
    partial: 0,
    unsupported: 0,
    "safety-refusal": 0,
    crash: 0,
  };
  for (const result of results) {
    const key = result.actual.classification;
    classifications[key] = (classifications[key] ?? 0) + 1;
  }
  const actionable = classifications.supported + classifications.partial;
  return {
    total: results.length,
    passingExpectations: results.filter((result) => result.ok).length,
    deterministic: results.filter((result) => result.deterministic).length,
    actionable,
    actionablePercent: percent(actionable, results.length),
    classifications,
  };
}

function writeReports(report) {
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(join(REPORT_DIR, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(REPORT_DIR, "summary.md"), renderSummary(report));
}

function renderSummary(report) {
  const lines = [
    "# Legacy GitHub corpus result",
    "",
    `Expectations: ${report.score.passingExpectations}/${report.score.total} passed`,
    `Determinism: ${report.score.deterministic}/${report.score.total} passed`,
    `Actionable inventory: ${report.score.actionable}/${report.score.total} (${report.score.actionablePercent}%)`,
    "",
    "| result | system | platform | classification | candidates | conflicts | diagnostics |",
    "|---|---|---|---|---:|---:|---|",
  ];
  for (const result of report.systems) {
    lines.push(
      `| ${result.ok ? "PASS" : "FAIL"} | ${result.id} | ${result.platform} | ${result.actual.classification} | ${result.actual.candidates} | ${result.actual.conflicts} | ${result.actual.diagnostics.join("<br>") || "—"} |`,
    );
    for (const mismatch of result.mismatches) lines.push(`|  | ↳ |  | ${mismatch} |  |  |  |`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function validateManifest(value) {
  if (value?.schemaVersion !== 1 || !Array.isArray(value.systems)) {
    fail("Legacy corpus manifest must have schemaVersion 1 and a systems array.");
  }
  const ids = new Set();
  for (const system of value.systems) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(system.id)) fail(`Invalid system id '${system.id}'.`);
    if (ids.has(system.id)) fail(`Duplicate system id '${system.id}'.`);
    ids.add(system.id);
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(system.repository)) {
      fail(`Invalid GitHub repository for '${system.id}'.`);
    }
    if (typeof system.platform !== "string" || system.platform.length === 0) {
      fail(`Invalid platform for '${system.id}'.`);
    }
    if (!/^[0-9a-f]{40}$/u.test(system.revision)) fail(`Invalid revision for '${system.id}'.`);
    if (!/^[0-9a-f]{64}$/u.test(system.source?.sha256)) {
      fail(`Invalid source digest for '${system.id}'.`);
    }
    if (!safeRelativePath(system.source?.path) || !safeRelativePath(system.source?.localPath)) {
      fail(`Unsafe source path for '${system.id}'.`);
    }
    if (
      typeof system.license?.spdx !== "string" ||
      !system.license.evidenceUrl?.startsWith(
        `https://github.com/${system.repository}/blob/${system.revision}/`,
      )
    ) {
      fail(`Invalid license evidence for '${system.id}'.`);
    }
    validateExpectation(system);
  }
}

function validateExpectation(system) {
  const expected = system.expected;
  const classifications = new Set([
    "supported",
    "partial",
    "unsupported",
    "safety-refusal",
    "crash",
  ]);
  if (!classifications.has(expected?.classification)) {
    fail(`Invalid expected classification for '${system.id}'.`);
  }
  for (const field of ["exitCode", "observations", "candidates", "conflicts"]) {
    if (!Number.isInteger(expected[field]) || expected[field] < 0) {
      fail(`Invalid expected ${field} for '${system.id}'.`);
    }
  }
  for (const field of ["collectors", "diagnostics"]) {
    if (!Array.isArray(expected[field]) || expected[field].some((item) => typeof item !== "string")) {
      fail(`Invalid expected ${field} for '${system.id}'.`);
    }
  }
}

function safeRelativePath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  );
}

function rawGithubUrl(system) {
  const path = system.source.path.split("/").map(encodeURIComponent).join("/");
  return `https://raw.githubusercontent.com/${system.repository}/${system.revision}/${path}`;
}

function githubBlobUrl(system) {
  const path = system.source.path.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${system.repository}/blob/${system.revision}/${path}`;
}

function percent(numerator, denominator) {
  if (denominator === 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseArgs(argv) {
  const parsed = { systems: undefined, work: undefined, cli: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--systems" && value) {
      parsed.systems = new Set(value.split(",").filter(Boolean));
      index += 1;
    } else if (arg === "--work" && value) {
      parsed.work = value;
      index += 1;
    } else if (arg === "--cli" && value) {
      parsed.cli = value;
      index += 1;
    } else {
      fail(`Unknown or incomplete argument '${arg}'. Use --systems, --work, or --cli.`);
    }
  }
  return parsed;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
