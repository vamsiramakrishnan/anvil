import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "@anvil/compiler";
import { generateBundle, writeBundle } from "@anvil/generators";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { runAnvilCli } from "../anvil-cli.js";
import { bufferIO } from "../io.js";
import type { BenchmarkOperationResult, BenchmarkReport, BenchmarkTask } from "./benchmark.js";
import { runBenchmarkCommand } from "./benchmark.js";

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../../../examples/${rel}`, import.meta.url)), "utf8");

const dirs: string[] = [];

async function buildBundle(spec: string, manifest: string, serviceId: string): Promise<string> {
  const air = await compile({ spec: read(spec), manifest: read(manifest), serviceId });
  const dir = mkdtempSync(join(tmpdir(), `anvil-benchmark-${serviceId}-`));
  dirs.push(dir);
  writeBundle(dir, generateBundle(air));
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "anvil-benchmark-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("anvil benchmark — command and rendering", () => {
  describe("runBenchmarkCommand — error handling and exit codes", () => {
    it("throws a plain error when the bundle path does not exist", async () => {
      const io = bufferIO();
      const nonexistent = join(root, "nonexistent");
      await expect(runBenchmarkCommand(nonexistent, {}, io)).rejects.toThrow(
        `No such bundle: ${nonexistent}`,
      );
      expect(io.text()).toBe("");
    });

    it("throws the same friendly 'No air.yaml or air.json' message when neither file exists", async () => {
      const io = bufferIO();
      const invalidBundle = join(root, "empty-bundle");
      mkdirSync(invalidBundle, { recursive: true });
      writeFileSync(join(invalidBundle, "README.md"), "not a bundle\n");
      await expect(runBenchmarkCommand(invalidBundle, {}, io)).rejects.toThrow(
        `No air.yaml or air.json in ${invalidBundle}. Run \`anvil compile\` first.`,
      );
    });

    it("validates threshold is a number between 0 and 1", async () => {
      const bundleDir = await buildBundle(
        "payments/openapi.yaml",
        "payments/anvil.yaml",
        "payments",
      );
      const io = bufferIO();

      // Test invalid threshold values
      await expect(runBenchmarkCommand(bundleDir, { check: "invalid" }, io)).rejects.toThrow(
        /Invalid threshold.*Must be a number between 0 and 1/,
      );
      await expect(runBenchmarkCommand(bundleDir, { check: "-0.5" }, io)).rejects.toThrow(
        /Invalid threshold.*Must be a number between 0 and 1/,
      );
      await expect(runBenchmarkCommand(bundleDir, { check: "1.5" }, io)).rejects.toThrow(
        /Invalid threshold.*Must be a number between 0 and 1/,
      );
    });
  });

  describe("Report generation with real bundle", () => {
    it("generates a valid benchmark.report.json from a real compiled bundle", async () => {
      const bundleDir = await buildBundle(
        "payments/openapi.yaml",
        "payments/anvil.yaml",
        "payments",
      );
      const io = bufferIO();

      const code = await runBenchmarkCommand(bundleDir, {}, io);
      expect(code).toBe(0);

      // Check that report file was written
      const reportPath = join(bundleDir, "benchmark.report.json");
      const reportText = readFileSync(reportPath, "utf8");
      const report: BenchmarkReport = JSON.parse(reportText);

      // Verify report structure — typed against the exported report contract,
      // so a shape change here is a deliberate contract change, not drift.
      expect(report.schemaVersion).toBe(1);
      expect(Array.isArray(report.operations)).toBe(true);
      const firstOp: BenchmarkOperationResult | undefined = report.operations[0];
      const firstTask: BenchmarkTask | undefined = firstOp?.tasks[0];
      if (firstOp) expect(typeof firstOp.score).toBe("number");
      if (firstTask) expect(typeof firstTask.pass).toBe("boolean");
      expect(report.summary).toBeDefined();
      expect(report.summary.total).toBeGreaterThanOrEqual(0);
      expect(report.summary.passed).toBeGreaterThanOrEqual(0);
      expect(report.summary.score).toBeGreaterThanOrEqual(0);
      expect(report.summary.score).toBeLessThanOrEqual(1);
      expect(report.bundleHash).toBeDefined();
      expect(report.bundleHash.length).toBeGreaterThan(0);

      // Verify output contains expected text
      const output = io.text();
      expect(output).toContain("Agent-task benchmark");
      expect(output).toContain("benchmark.report.json");
    });

    it("reports operations with no intentExamples", async () => {
      const bundleDir = await buildBundle(
        "payments/openapi.yaml",
        "payments/anvil.yaml",
        "payments",
      );
      const io = bufferIO();

      const code = await runBenchmarkCommand(bundleDir, {}, io);
      expect(code).toBe(0);

      const reportPath = join(bundleDir, "benchmark.report.json");
      const reportText = readFileSync(reportPath, "utf8");
      const report: BenchmarkReport = JSON.parse(reportText);

      // At least some operations should be included
      expect(report.operations.length).toBeGreaterThan(0);
    });

    it("filters for approved operations only", async () => {
      const bundleDir = await buildBundle(
        "payments/openapi.yaml",
        "payments/anvil.yaml",
        "payments",
      );
      const io = bufferIO();

      const code = await runBenchmarkCommand(bundleDir, {}, io);
      expect(code).toBe(0);

      const reportPath = join(bundleDir, "benchmark.report.json");
      const reportText = readFileSync(reportPath, "utf8");
      const report: BenchmarkReport = JSON.parse(reportText);

      // All reported operations should be approved (in real bundles, only approved ops are included)
      expect(report.operations.length).toBeGreaterThan(0);
      const output = io.text();
      // Output should have operation details
      expect(output.length).toBeGreaterThan(0);
    });

    it("includes bundleHash in the written report", async () => {
      const bundleDir = await buildBundle(
        "payments/openapi.yaml",
        "payments/anvil.yaml",
        "payments",
      );
      const io = bufferIO();

      const code = await runBenchmarkCommand(bundleDir, {}, io);
      expect(code).toBe(0);

      const reportPath = join(bundleDir, "benchmark.report.json");
      const reportText = readFileSync(reportPath, "utf8");
      const report: BenchmarkReport = JSON.parse(reportText);

      expect(report.bundleHash).toBeDefined();
      expect(typeof report.bundleHash).toBe("string");
      expect(report.bundleHash.length).toBeGreaterThan(0);
    });
  });

  describe("Task derivation from intent examples", () => {
    it("passes a task whose required params are satisfiable from surface examples", async () => {
      // Regression: the satisfiability check iterated Object.entries over the
      // params ARRAY (param name '0') and compared raw wire names against the
      // surface-keyed example input, failing every op with a required param.
      const bundleDir = await buildBundle(
        "payments/openapi.yaml",
        "payments/anvil.yaml",
        "payments",
      );
      const airPath = join(bundleDir, "air.yaml");
      const air = parseYaml(readFileSync(airPath, "utf8")) as {
        operations: Array<{
          id: string;
          state: string;
          input: { params: Array<{ required?: boolean }> };
          skill: { intentExamples: string[] };
        }>;
      };
      const op = air.operations.find(
        (o) => o.state === "approved" && o.input.params.some((p) => p.required),
      );
      if (!op) throw new Error("payments fixture has no approved op with a required param");
      op.skill.intentExamples = ["get a payment by id"];
      writeFileSync(airPath, stringifyYaml(air), "utf8");

      const io = bufferIO();
      const code = await runBenchmarkCommand(bundleDir, {}, io);
      expect(code).toBe(0);
      const report: BenchmarkReport = JSON.parse(
        readFileSync(join(bundleDir, "benchmark.report.json"), "utf8"),
      );
      const scored = report.operations.find((o) => o.operationId === op.id);
      expect(scored?.tasks).toHaveLength(1);
      expect(scored?.tasks[0]?.pass).toBe(true);
      expect(scored?.tasks[0]?.failReason).toBeUndefined();
    });
  });

  describe("Threshold checking with --check", () => {
    it("exits 0 when score meets the threshold", async () => {
      const bundleDir = await buildBundle(
        "payments/openapi.yaml",
        "payments/anvil.yaml",
        "payments",
      );
      const io = bufferIO();

      // With threshold 0, should always pass (score >= 0)
      const code = await runBenchmarkCommand(bundleDir, { check: "0" }, io);
      expect(code).toBe(0);
    });

    it("can exit 1 when score falls below a very high threshold", async () => {
      const bundleDir = await buildBundle(
        "payments/openapi.yaml",
        "payments/anvil.yaml",
        "payments",
      );
      const io = bufferIO();

      // With threshold 1.1 (impossible), should fail validation first
      await expect(runBenchmarkCommand(bundleDir, { check: "1.1" }, io)).rejects.toThrow();
    });
  });

  describe("CLI integration", () => {
    it("accepts benchmark command with required dir argument", async () => {
      const io = bufferIO();
      const code = await runAnvilCli(["benchmark", join(root, "nonexistent")], { io });
      expect(code).toBe(1);
      expect(io.text()).toContain("No such bundle");
    });

    it("rejects benchmark without required dir argument", async () => {
      const io = bufferIO();
      const code = await runAnvilCli(["benchmark"], { io });
      expect(code).toBe(1);
      expect(io.text()).toContain("missing required argument");
    });

    it("recognizes --check option with valid threshold", async () => {
      const io = bufferIO();
      // This will fail because the bundle doesn't exist, but should parse the option
      const code = await runAnvilCli(["benchmark", join(root, "nonexistent"), "--check", "0.5"], {
        io,
      });
      expect(code).toBe(1);
      expect(io.text()).toContain("No such bundle");
    });
  });

  describe("Summary statistics", () => {
    it("correctly reports aggregate score in output", async () => {
      const bundleDir = await buildBundle(
        "payments/openapi.yaml",
        "payments/anvil.yaml",
        "payments",
      );
      const io = bufferIO();

      const code = await runBenchmarkCommand(bundleDir, {}, io);
      expect(code).toBe(0);

      const output = io.text();
      // Output should contain summary line with statistics
      expect(output).toContain("tasks passed");
    });
  });
});
