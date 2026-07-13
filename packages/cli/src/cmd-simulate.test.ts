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
    expect(report.mutation.killed).toBe(report.mutation.mutants.length);
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
});
