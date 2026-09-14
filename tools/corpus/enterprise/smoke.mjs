#!/usr/bin/env node
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { run } from "./process.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const CLI = join(ROOT, "packages/cli/dist/bin-anvil.js");
const { values } = parseArgs({ options: { report: { type: "string" }, systems: { type: "string" } } });
const reportDir = resolve(values.report ?? join(HERE, "report"));
const conversion = JSON.parse(readFileSync(join(reportDir, "report.json"), "utf8"));
const samples = JSON.parse(readFileSync(join(HERE, "smoke.json"), "utf8")).samples;
const selected = values.systems?.split(",");
if (selected?.some((id) => !samples.some((s) => s.system === id))) throw new Error("Unknown reviewed smoke system");
const report = { version: 1, startedAt: new Date().toISOString(), scope: "Reviewed reads over local mocks. No upstream requests, real credentials, or deployed Gemini Enterprise registration.", results: [] };
for (const sample of samples.filter((s) => !selected || selected.includes(s.system))) {
  const conversionRow = conversion.results.find((r) => r.id === sample.system);
  const row = { system: sample.system, operationId: sample.operationId ?? `${sample.method.toUpperCase()} ${sample.path}`, status: "not-run", checks: [] };
  report.results.push(row);
  try {
    if (conversionRow?.status !== "pass") {
      row.detail = "Requires a passing full-contract conversion in this report.";
      continue;
    }
    const rawBundle = join(reportDir, "bundles", sample.system);
    const doc = JSON.parse(readFileSync(join(rawBundle, "air.json"), "utf8"));
    const matching = doc.operations.filter((o) => o.sourceRef.operationId === sample.operationId && o.sourceRef.path === sample.path && o.sourceRef.method === sample.method);
    if (matching.length !== 1 || matching[0].effect.kind !== "read" || matching[0].state === "blocked") throw new Error("Reviewed read identity, effect or eligibility changed; review the source again.");
    if (doc.operations.some((o) => o.state === "approved")) throw new Error("Raw corpus bundle unexpectedly contains approvals");
    const op = matching[0];
    const bundle = join(reportDir, "smoke", sample.system);
    rmSync(bundle, { recursive: true, force: true });
    mkdirSync(dirname(bundle), { recursive: true });
    cpSync(rawBundle, bundle, { recursive: true });
    const approve = await run(process.execPath, [CLI, "approve", bundle, op.id], { cwd: ROOT, log: join(reportDir, `${sample.system}.smoke-approve.log`) });
    if (approve.code !== 0) throw new Error(approve.tail);
    const approved = JSON.parse(readFileSync(join(bundle, "air.json"), "utf8")).operations.filter((o) => o.state === "approved");
    if (approved.length !== 1 || approved[0].id !== op.id) throw new Error("Smoke approval must expose exactly the reviewed read");
    for (const lane of ["selftest", "conformance"]) {
      const result = await run(process.execPath, [CLI, lane, bundle], { cwd: ROOT, timeoutMs: 180_000, log: join(reportDir, `${sample.system}.${lane}.log`) });
      const proof = result.code === 0 ? JSON.parse(readFileSync(join(bundle, `${lane}.report.json`), "utf8")) : undefined;
      const required = lane === "selftest" ? "fidelity" : "wire-agreement";
      const exercised = proof?.checks.some((c) => c.id === required && c.operationId === op.id && c.status === "pass");
      row.checks.push({ name: lane, ok: result.code === 0 && exercised && proof.summary.fail === 0, ms: result.ms, summary: proof?.summary, detail: result.code !== 0 ? result.tail.slice(-2500) : exercised ? `${required} passed for the reviewed operation against local mocks` : `No passing ${required} check for the reviewed operation` });
    }
    const target = await run(process.execPath, [CLI, "target", "gemini-enterprise", bundle,
      "--surface", "custom-mcp", "--server-auth", "oauth", "--endpoint", "https://anvil-corpus.invalid/mcp",
      "--project", "anvil-corpus", "--location", "global", "--engine", "corpus-engine", "--idp", "other",
      "--oauth-authorization-url", "https://idp.invalid/authorize", "--oauth-token-url", "https://idp.invalid/token",
      "--oauth-scope", "anvil.invoke", "--inbound-issuer", "https://idp.invalid", "--inbound-audience", "https://anvil-corpus.invalid",
    ], { cwd: ROOT, timeoutMs: 60_000, log: join(reportDir, `${sample.system}.gemini-enterprise.log`) });
    row.checks.push({ name: "gemini-enterprise-kit", ok: target.code === 0, detail: target.code === 0 ? "OAuth registration artifacts generated; no deployment" : target.tail.slice(-1500) });
    row.status = row.checks.every((c) => c.ok) ? "pass" : "fail";
  } catch (error) { row.status = "fail"; row.detail = error.message; }
  finally {
    writeFileSync(join(reportDir, "smoke.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`${sample.system}: ${row.status}`);
  }
}
const lines = ["# Reviewed enterprise reads", "", report.scope, "", "| Contract | Operation | Result | Failing checks |", "|---|---|---|---|", ...report.results.map((r) => `| ${r.system} | ${r.operationId} | ${r.status} | ${r.checks.filter((c) => !c.ok).map((c) => c.name).join(", ") || r.detail?.replaceAll("|", "\\|").replaceAll(/\s+/g, " ").slice(0,200) || "—"} |`)];
writeFileSync(join(reportDir, "smoke-summary.md"), `${lines.join("\n")}\n`);
if (!report.results.length) throw new Error("No reviewed smoke cases selected");
process.exitCode = report.results.some((r) => r.status !== "pass") ? 1 : 0;
