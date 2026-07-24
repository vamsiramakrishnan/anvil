import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type CoverageReport,
  coverageMatrix,
  type MutantResult,
  runMutationBattery,
} from "@anvil/certification";
import { bundleHash, readBundleDir, SIMULATION_REPORT_FILE } from "@anvil/generators";
import type { Command } from "commander";
import type { CliIO } from "../io.js";
import { loadBundleAir, resolveBundleDir } from "./certify.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";

/**
 * `anvil simulate <dir>` — the mechanistic coverage lane. It generates the full
 * safety matrix from the contract (every approved operation crossed with every
 * dimension that applies to it — auth, confirmation, idempotency, fault,
 * pagination) and drives every cell through the contract-faithful, deterministic
 * simulator, then runs the safety mutation battery. Where `anvil selftest` and
 * `anvil conformance` prove the generated surfaces, this proves the *coverage*:
 * a number for how much of the safety contract was actually exercised, plus
 * proof that a weakened contract would be caught. Writes simulation.report.json.
 * Exit 0 only when every cell holds and every applicable safety mutant is killed.
 */
export function registerSimulate(parent: Command, ctx: CommandContext): void {
  annotate(
    parent
      .command("simulate")
      .summary("Drive the full safety matrix through the simulator and report coverage.")
      .description(
        "Mechanistic coverage for a bundle's approved surface. Enumerates the matrix (each operation × the safety dimensions that apply: auth scope gating, confirmation refusal, required-idempotency + replay, injected faults, pagination) and drives every cell through the deterministic simulator, checking each against an independent contract expectation. Then runs the mutation battery — deliberately weakening each safety control and proving the surface signature detects it. Reports per-dimension coverage and mutants killed. Deterministic: same seed + contract → same cells. Writes simulation.report.json. Exit 0 only when every cell holds and every applicable safety mutant is killed.",
      )
      .argument("<dir>", "generated bundle directory (or its air.yaml)")
      .option("--seed <n>", "deterministic simulator seed", "1")
      .option("--json", "emit the full report as JSON")
      .action((dir: string, opts: SimulateOptions) => {
        ctx.code = runSimulate(dir, opts, ctx.io);
      }),
    { mutates: true },
  );
}

export interface SimulateOptions {
  seed?: string;
  json?: boolean;
}

export interface SimulationReport {
  schemaVersion: 1;
  bundle: string;
  /** Digest of the generated bundle content this evidence exercised. */
  bundleHash: string;
  coverage: CoverageReport;
  mutation: { mutants: MutantResult[]; applicable: number; killed: number };
  summary: { coverageCells: number; coveragePassed: number; mutantsKilled: number; ok: boolean };
}

export function runSimulate(path: string, opts: SimulateOptions, io: CliIO): number {
  const dir = resolveBundleDir(path);
  const files = readBundleDir(dir);
  const subjectHash = bundleHash(files);
  const air = loadBundleAir(dir, files);
  const seed = Number.parseInt(opts.seed ?? "1", 10) || 1;

  const coverage = coverageMatrix(air, { seed });
  const mutants = runMutationBattery(air);
  const applicable = mutants.filter((m) => m.applicable);
  const killed = applicable.filter((m) => m.killed);
  const ok = coverage.summary.failed === 0 && applicable.every((m) => m.killed);

  const report: SimulationReport = {
    schemaVersion: 1,
    bundle: dir,
    bundleHash: subjectHash,
    coverage,
    mutation: { mutants, applicable: applicable.length, killed: killed.length },
    summary: {
      coverageCells: coverage.summary.cells,
      coveragePassed: coverage.summary.passed,
      mutantsKilled: killed.length,
      ok,
    },
  };
  writeFileSync(join(dir, SIMULATION_REPORT_FILE), `${JSON.stringify(report, null, 2)}\n`, "utf8");

  if (opts.json === true) io.out(JSON.stringify(report, null, 2));
  else io.out(renderSimulationSummary(report, dir));
  return ok ? 0 : 1;
}

/** The dimension + mutation summary `anvil simulate` prints (cells behind --json). */
export function renderSimulationSummary(report: SimulationReport, dir: string): string {
  const { coverage, mutation } = report;
  const lines: string[] = [
    `Simulation coverage — ${coverage.capabilityId}  (seed ${coverage.seed})`,
    "",
    "  Coverage by dimension:",
  ];
  for (const d of coverage.dimensions) {
    const mark = d.cells === 0 ? "–" : d.passed === d.cells ? "✓" : "✗";
    const applies =
      d.cells === 0
        ? "no applicable operations"
        : `${d.operations} op(s), ${d.passed}/${d.cells} cells`;
    lines.push(`    ${mark} ${d.dimension.padEnd(13)} ${applies}`);
  }
  const failed = coverage.cells.filter((c) => !c.ok);
  for (const c of failed) {
    lines.push(
      `      ✗ ${c.operationId} ${c.dimension}/${c.variant}: expected ${c.expected}, got ${c.actual}`,
    );
  }
  lines.push("");
  lines.push("  Mutation battery (safety-regression detection):");
  for (const m of mutation.mutants) {
    const mark = !m.applicable ? "–" : m.killed ? "✓" : "✗";
    const note = m.applicable
      ? m.killed
        ? `killed (${m.classification})`
        : `SURVIVED (${m.classification})`
      : "inapplicable";
    lines.push(`    ${mark} ${m.name.padEnd(24)} ${note}`);
  }
  lines.push("");
  lines.push(
    report.summary.ok
      ? `PASSED — ${coverage.summary.passed}/${coverage.summary.cells} cells held, ${mutation.killed}/${mutation.applicable} applicable mutants killed. Wrote ${join(dir, SIMULATION_REPORT_FILE)}.`
      : `FAILED — ${coverage.summary.failed} cell(s) failed, ${mutation.applicable - mutation.killed} applicable mutant(s) survived. Wrote ${join(dir, SIMULATION_REPORT_FILE)}.`,
  );
  return lines.join("\n");
}
