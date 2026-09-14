#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { acquire, saveLock } from "./acquire.mjs";
import { coverage, inventory, metrics, staticChecks } from "./checks.mjs";
import { run } from "./process.mjs";
import { writeReport } from "./report.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const CLI = join(ROOT, "packages/cli/dist/bin-anvil.js");
const { values } = parseArgs({ options: {
  systems: { type: "string" }, industry: { type: "string" }, list: { type: "boolean" },
  "source-dir": { type: "string" }, cache: { type: "string" }, out: { type: "string" },
  offline: { type: "boolean" }, refresh: { type: "boolean" },
  "timeout-ms": { type: "string", default: "120000" },
} });
const timeoutMs = Number(values["timeout-ms"]);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000) throw new Error("--timeout-ms must be an integer >= 1000");
const catalog = JSON.parse(readFileSync(join(HERE, "catalog.json"), "utf8"));
const requested = values.systems?.split(",");
if (requested?.some((id) => !catalog.systems.some((s) => s.id === id))) throw new Error("Unknown system in --systems; use --list");
const systems = catalog.systems.filter((s) => (!requested || requested.includes(s.id)) && (!values.industry || s.industries.includes(values.industry)));
if (!systems.length) throw new Error("No contracts match the selection");
if (values.list) {
  for (const system of systems) console.log(`${system.id}\t${system.access}\t${system.provenance}\t${system.name}`);
} else {
  const reportDir = resolve(values.out ?? join(HERE, "report"));
  mkdirSync(reportDir, { recursive: true });
  const cache = resolve(values.cache ?? join(HERE, ".cache"));
  const lockFile = join(HERE, "sources.lock.json");
  const lock = existsSync(lockFile) ? JSON.parse(readFileSync(lockFile, "utf8")).sources : {};
  const options = { cache, reportDir, offline: !!values.offline, refresh: !!values.refresh, sourceDir: values["source-dir"] && resolve(values["source-dir"]) };
  const codeFiles = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "packages", "tools/corpus/enterprise"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter((p) => /\.(ts|tsx|mjs)$/.test(p)).sort();
  const fingerprint = createHash("sha256");
  for (const file of codeFiles) fingerprint.update(file).update("\0").update(readFileSync(join(ROOT, file))).update("\0");
  const report = { version: 1, startedAt: new Date().toISOString(), gitTree: execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: ROOT, encoding: "utf8" }).trim(), implementationSha256: fingerprint.digest("hex"), worktreeDirty: execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).length > 0, results: [] };
  for (const system of systems) {
    const row = { id: system.id, name: system.name, industries: system.industries, provenance: system.provenance, url: system.url, status: "pending", checks: [] };
    report.results.push(row);
    console.log(`${system.id}: acquiring`);
    try {
      const source = await acquire(system, options, lock);
      if (values.refresh) saveLock(lockFile, lock);
      const { file, ...identity } = source;
      row.source = identity;
      if (source.status !== "acquired") { row.status = source.status; row.detail = source.detail; }
      else {
        row.inventory = inventory(readFileSync(file, "utf8"), system.format);
        const bundle = join(reportDir, "bundles", system.id);
        const repeat = join(reportDir, "repeat", system.id);
        // Fresh directories prevent a failed run from reading an older successful bundle.
        rmSync(bundle, { recursive: true, force: true });
        rmSync(repeat, { recursive: true, force: true });
        const args = [CLI, "compile", file, "--service", system.id, "--root", join(reportDir, "sources", system.id), "--out"];
        const compiled = await run(process.execPath, [...args, bundle], { cwd: ROOT, timeoutMs, log: join(reportDir, `${system.id}.compile.log`) });
        row.compileMs = compiled.ms;
        if (compiled.code !== 0) {
          row.status = compiled.timedOut ? "timeout" : "compile-failed";
          row.detail = compiled.tail.slice(-3000);
          if (existsSync(join(bundle, "air.json"))) {
            const raw = readFileSync(join(bundle, "air.json"), "utf8");
            const doc = JSON.parse(raw);
            row.metrics = metrics(doc, Buffer.byteLength(raw));
            row.checks.push(coverage(row.inventory, doc));
            row.compilerErrors = doc.diagnostics.filter((d) => d.level === "error");
            if (row.compilerErrors.length) row.detail = [...new Set(row.compilerErrors.map((d) => d.code))].join(", ");
            if (!compiled.timedOut && row.compilerErrors.length && row.compilerErrors.every((d) => d.code === "query_language_passthrough")) row.status = "policy-blocked";
          }
        } else {
          const repeated = await run(process.execPath, [...args, repeat], { cwd: ROOT, timeoutMs, log: join(reportDir, `${system.id}.repeat.log`) });
          const result = staticChecks(row.inventory, bundle, repeat);
          row.checks.push(...result.checks);
          row.metrics = result.metrics;
          if (repeated.code !== 0) row.checks.push({ name: "repeat-compile", ok: false, detail: repeated.tail.slice(-1000) });
          const lint = await run(process.execPath, [CLI, "lint", bundle], { cwd: ROOT, timeoutMs, log: join(reportDir, `${system.id}.lint.log`) });
          row.checks.push({ name: "lint", ok: lint.code === 0, detail: lint.code === 0 ? "No lint errors" : lint.tail.slice(-1000) });
          row.execution = { status: "not-run", detail: "Raw import; no additional operation approvals or vendor requests. See the separate reviewed smoke lane." };
          row.status = row.checks.every((c) => c.ok) ? "pass" : "check-failed";
        }
      }
    } catch (error) { row.status = "harness-error"; row.detail = error.stack; }
    writeReport(report, reportDir);
    console.log(`${system.id}: ${row.status}${row.metrics ? ` (${row.metrics.operations} operations)` : ""}`);
  }
  report.finishedAt = new Date().toISOString();
  writeReport(report, reportDir);
  // Export requirements are coverage gaps, never green tests. Other failures fail the lane.
  process.exitCode = !report.results.some((r) => r.source?.status === "acquired") ? 2
    : report.results.some((r) => !["pass", "needs-export"].includes(r.status)) ? 1 : 0;
}
