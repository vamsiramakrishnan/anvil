import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "@anvil/compiler";
import { generateBundle, writeBundle } from "@anvil/generators";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSimulate } from "./commands/simulate.js";
import { bufferIO } from "./io.js";

const examples = fileURLToPath(new URL("../../../examples/payments/", import.meta.url));
const read = (rel: string) => readFileSync(join(examples, rel), "utf8");

let dir: string;
beforeEach(async () => {
  const air = await compile({
    spec: read("openapi.yaml"),
    manifest: read("anvil.yaml"),
    serviceId: "payments",
  });
  dir = mkdtempSync(join(tmpdir(), "anvil-simulate-"));
  writeBundle(dir, generateBundle(air));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("anvil simulate", () => {
  it("drives the coverage matrix + mutation battery and writes the report", () => {
    const io = bufferIO();
    const code = runSimulate(dir, {}, io);
    expect(code).toBe(0);

    const text = io.text();
    expect(text).toContain("Coverage by dimension");
    expect(text).toContain("Mutation battery");
    expect(text).toMatch(/PASSED — \d+\/\d+ cells held/);

    const report = JSON.parse(readFileSync(join(dir, "simulation.report.json"), "utf8"));
    expect(report.summary.ok).toBe(true);
    expect(report.coverage.summary.failed).toBe(0);
    // Every applicable safety mutant is killed.
    expect(report.mutation.killed).toBe(report.mutation.applicable);
    expect(report.bundleHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("emits the full machine-readable report under --json", () => {
    const io = bufferIO();
    const code = runSimulate(dir, { json: true }, io);
    expect(code).toBe(0);
    const report = JSON.parse(io.text());
    expect(report.schemaVersion).toBe(1);
    expect(report.coverage.cells.length).toBeGreaterThan(0);
    expect(report.coverage.dimensions.map((d: { dimension: string }) => d.dimension)).toEqual([
      "auth",
      "confirmation",
      "idempotency",
      "fault",
      "pagination",
    ]);
  });

  it("honors an explicit --seed 0 instead of silently coercing it to 1", () => {
    const io = bufferIO();
    const code = runSimulate(dir, { seed: "0", json: true }, io);
    expect(code, io.text()).toBe(0);
    const report = JSON.parse(io.text());
    expect(report.coverage.seed).toBe(0);
  });

  it("rejects a non-numeric --seed instead of silently substituting 1", () => {
    const io = bufferIO();
    const code = runSimulate(dir, { seed: "banana" }, io);
    expect(code).toBe(1);
    expect(io.text()).toContain("Invalid --seed 'banana'");
  });

  it("rejects a negative --seed", () => {
    const io = bufferIO();
    const code = runSimulate(dir, { seed: "-1" }, io);
    expect(code).toBe(1);
    expect(io.text()).toContain("Invalid --seed '-1'");
  });
});
