import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AirDocument } from "@anvil/air";
import { airFromYaml, airToYaml } from "@anvil/air";
import { compile } from "@anvil/compiler";
import { generateBundle, writeBundle } from "@anvil/generators";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDisclosure } from "./commands/disclosure.js";
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
  dir = mkdtempSync(join(tmpdir(), "anvil-disclosure-"));
  writeBundle(dir, generateBundle(air));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Rewrite the bundle's canonical AIR — the only way to stage recorded figures. */
function amendAir(mutate: (air: AirDocument) => AirDocument): void {
  const path = join(dir, "air.yaml");
  writeFileSync(path, airToYaml(mutate(airFromYaml(readFileSync(path, "utf8")))), "utf8");
}

describe("anvil disclosure", () => {
  it("renders a ranked, attributed summary of where the context budget goes", () => {
    const io = bufferIO();
    expect(runDisclosure(dir, {}, io)).toBe(0);
    const text = io.text();
    expect(text).toContain("Disclosure BOM — payments");
    expect(text).toContain("Most expensive operations (measured tool surface)");
    expect(text).toContain("By capability:");
    expect(text).toContain("Ladder");
    // The unit travels with the figures; a token count without one is unitless.
    expect(text).toContain("o200k_base");
  });

  it("emits the whole bill of materials under --json", () => {
    const io = bufferIO();
    expect(runDisclosure(dir, { json: true }, io)).toBe(0);
    const bom = JSON.parse(io.text());
    expect(bom.schemaVersion).toBe(1);
    expect(bom.operations.length).toBeGreaterThan(0);
    expect(bom.operations[0].contributors.length).toBeGreaterThan(0);
    expect(bom.service.serviceId).toBe("payments");
    expect(bom.ladder.mode).toMatch(/^(flat|laddered)$/);
  });

  it("says 'not measured' for responses instead of rendering zeros as findings", () => {
    const io = bufferIO();
    expect(runDisclosure(dir, {}, io)).toBe(0);
    const text = io.text();
    expect(text).toContain("Response cost: NOT MEASURED");
    expect(text).toContain("anvil simulate");
    // The absence must not be dressed up as a measurement of zero.
    expect(text).not.toContain("~0 tokens");
  });

  it("labels every response figure as projected, and only those", () => {
    amendAir((air) => ({
      ...air,
      operations: air.operations.map((operation) => {
        const cost = operation.disclosureCost;
        if (cost === undefined) return operation;
        return {
          ...operation,
          disclosureCost: { ...cost, responseTokens: 60_000, responseItemTokens: 120, seed: 3 },
        };
      }),
    }));
    const io = bufferIO();
    expect(runDisclosure(dir, {}, io)).toBe(0);
    const text = io.text();
    expect(text).toContain("Response cost: PROJECTED from simulated data under seed 3");
    expect(text).toContain("not a");
    expect(text).toContain("measurement of live traffic");
    // A projected finding is marked as such; a measured one is not.
    expect(text).toContain("~ [projected]");
    expect(text).not.toMatch(/✗ \[measured\].*returns .* tokens per call/);
  });

  it("reports an over-budget tool surface as a measured fact naming the field", () => {
    // A description big enough to blow the per-tool budget on its own, so the
    // attribution has an unambiguous culprit to name.
    amendAir((air) => ({
      ...air,
      operations: air.operations.map((operation, index) =>
        index === 0 ? { ...operation, description: "overwrought prose. ".repeat(600) } : operation,
      ),
    }));
    const io = bufferIO();
    expect(runDisclosure(dir, {}, io)).toBe(0);
    const text = io.text();
    expect(text).toContain("✗ [measured]");
    expect(text).toContain("over the 1,200-token per-tool budget");
    expect(text).toContain("the tool description");
  });

  it("is a report by default and a gate only under --check", () => {
    amendAir((air) => ({
      ...air,
      operations: air.operations.map((operation, index) =>
        index === 0 ? { ...operation, description: "overwrought prose. ".repeat(600) } : operation,
      ),
    }));
    // Observing that an API is expensive is not a failure of the command.
    expect(runDisclosure(dir, {}, bufferIO())).toBe(0);
    expect(runDisclosure(dir, { check: true }, bufferIO())).toBe(1);
  });

  it("never gates on a projection, however far over budget it is", () => {
    amendAir((air) => ({
      ...air,
      operations: air.operations.map((operation) => {
        const cost = operation.disclosureCost;
        if (cost === undefined) return operation;
        return {
          ...operation,
          disclosureCost: { ...cost, responseTokens: 500_000, responseItemTokens: 900, seed: 3 },
        };
      }),
    }));
    const io = bufferIO();
    // Findings are reported; the exit code stays 0 because the figures depend on
    // a seed and synthetic data, not on the contract under review.
    expect(runDisclosure(dir, { check: true }, io)).toBe(0);
    expect(io.text()).toContain("~ [projected]");
  });

  it("clamps the detailed listing with --top and admits what it withheld", () => {
    const io = bufferIO();
    expect(runDisclosure(dir, { top: "1" }, io)).toBe(0);
    expect(io.text()).toMatch(/… \d+ more \(--top 0 for all/);

    const all = bufferIO();
    expect(runDisclosure(dir, { top: "0" }, all)).toBe(0);
    expect(all.text()).not.toContain("--top 0 for all");
  });

  it("rejects a non-numeric --top instead of silently substituting a default", () => {
    const io = bufferIO();
    expect(runDisclosure(dir, { top: "banana" }, io)).toBe(1);
    expect(io.text()).toContain("Invalid --top 'banana'");
  });

  it("fails loudly on a directory that is not a bundle", () => {
    const empty = mkdtempSync(join(tmpdir(), "anvil-disclosure-empty-"));
    try {
      expect(() => runDisclosure(empty, {}, bufferIO())).toThrow(/air\.yaml/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
