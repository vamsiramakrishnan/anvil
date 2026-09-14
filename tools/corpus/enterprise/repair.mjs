#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { hashCanonical } from "../../../packages/air/dist/index.js";
import { validate } from "../../../packages/compiler/dist/index.js";
import { loadAir, repairInvariantHash, runRepairController } from "../../../packages/refinement/dist/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const { values } = parseArgs({ options: {
  corpus: { type: "string", default: join(HERE, "report") },
  out: { type: "string", default: join(HERE, "report", "repair") },
  systems: { type: "string" },
  "max-attempts": { type: "string", default: "40" },
  "timeout-ms": { type: "string", default: "30000" },
} });
const corpus = resolve(values.corpus);
const out = resolve(values.out);
const sourceReport = JSON.parse(readFileSync(join(corpus, "report.json"), "utf8"));
const selected = values.systems?.split(",");
if (selected?.some((id) => !sourceReport.results.some((r) => r.id === id))) throw new Error("Unknown system");
const rows = sourceReport.results.filter((r) => !selected || selected.includes(r.id));
mkdirSync(out, { recursive: true });
const digest = createHash("sha256");
for (const name of ["air", "compiler", "refinement"]) digest.update(readFileSync(join(ROOT, "packages", name, "dist/index.js")));
digest.update(readFileSync(fileURLToPath(import.meta.url)));
const report = {
  version: 1, startedAt: new Date().toISOString(),
  gitHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(),
  worktreeDirty: execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).trim().length > 0,
  implementationSha256: digest.digest("hex"),
  sourceRun: { startedAt: sourceReport.startedAt, implementationSha256: sourceReport.implementationSha256 },
  budget: { maxRounds: 3, maxAttempts: Number(values["max-attempts"]), timeoutMs: Number(values["timeout-ms"]) },
  results: [],
};
for (const row of rows) {
  const started = performance.now();
  const bundle = join(corpus, "bundles", row.id);
  const result = { id: row.id, name: row.name, sourceStatus: row.status, sourceSha256: row.source?.sha256 };
  if (!existsSync(join(bundle, "air.yaml")) && !existsSync(join(bundle, "air.json"))) {
    Object.assign(result, { status: "needs-source", detail: row.detail ?? "No generated AIR available" });
  } else {
    try {
      const air = loadAir(bundle);
      const originalHash = hashCanonical(air);
      const originalErrors = new Set(validate(air.operations).diagnostics.filter((d) => d.level === "error").map((d) => `${d.operationId}:${d.code}`));
      const run = await runRepairController(air, {
        ...report.budget,
        evaluation: {
          id: "enterprise-no-new-compiler-errors-v1",
          async evaluate(candidate) {
            const introduced = validate(candidate.operations).diagnostics.filter((d) => d.level === "error" && !originalErrors.has(`${d.operationId}:${d.code}`));
            return [{ id: "no-new-compiler-errors", passed: introduced.length === 0 }];
          },
        },
      });
      const state = run.checkpoint;
      const counts = {};
      for (const attempt of state.attempts) counts[attempt.status] = (counts[attempt.status] ?? 0) + 1;
      Object.assign(result, {
        status: state.stop, operations: air.operations.length, attempts: state.attempts.length,
        decisions: counts, initialDeficiencies: state.initialDeficiencies, remainingDeficiencies: state.remainingDeficiencies,
        checks: state.checks, originalHash, outputHash: state.currentHash,
        invariantsPreserved: repairInvariantHash(air) === repairInvariantHash(run.air),
        inputUnchanged: originalHash === hashCanonical(loadAir(bundle)),
        accepted: state.attempts.filter((a) => a.status === "accepted").map((a) => ({ deficiency: a.deficiency, round: a.round, patch: a.proposal.patch })),
        unresolvedConversion: row.status !== "pass" ? row.status : undefined,
      });
      writeFileSync(join(out, `${row.id}.checkpoint.json`), `${JSON.stringify(state, null, 2)}\n`);
    } catch (error) {
      Object.assign(result, { status: "error", detail: error.message });
    }
  }
  report.results.push(result);
  result.elapsedMs = Math.round(performance.now() - started);
  writeFileSync(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${result.id}: ${result.status}; accepted ${result.decisions?.accepted ?? 0}; deficiencies ${result.initialDeficiencies ?? "—"} → ${result.remainingDeficiencies ?? "—"}`);
}
report.finishedAt = new Date().toISOString();
writeFileSync(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
if (report.results.some((r) => r.status === "error" || r.invariantsPreserved === false || r.inputUnchanged === false)) process.exitCode = 1;
