import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AirDocument } from "@anvil/air";
import { airFromYaml, airToYaml } from "@anvil/air";
import { compile } from "@anvil/compiler";
import { generateBundle, writeBundle } from "@anvil/generators";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DisclosureOptions } from "./commands/disclosure.js";
import { runDisclosure } from "./commands/disclosure.js";
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
  dir = mkdtempSync(join(tmpdir(), "anvil-disclosure-"));
  writeBundle(dir, generateBundle(air));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Rewrite the bundle's canonical AIR — the only way to stage recorded figures. */
function amendAir(mutate: (air: AirDocument) => AirDocument): void {
  const path = join(dir, "air.yaml");
  writeFileSync(path, airToYaml(mutate(airFromYaml(readFileSync(path, "utf8")))), "utf8");
}

/**
 * Run the real `anvil simulate` so the report under test is the one the product
 * writes — hash, schema, cells and all. A hand-written stand-in would let this
 * suite keep passing after `simulate` changed its report shape, which is exactly
 * the coupling these tests exist to hold.
 */
function simulate(): void {
  const io = bufferIO();
  const code = runSimulate(dir, {}, io);
  if (code !== 0) throw new Error(`anvil simulate failed:\n${io.text()}`);
}

const reportPath = () => join(dir, "simulation.report.json");

/** The rendered report. Throws on a non-zero exit so a failure names itself. */
function bufferedText(opts: DisclosureOptions): string {
  const io = bufferIO();
  const code = runDisclosure(dir, opts, io);
  if (code !== 0) throw new Error(`anvil disclosure exited ${code}:\n${io.text()}`);
  return io.text();
}

/** The same run, as JSON. */
function bomJson(opts: DisclosureOptions): string {
  return bufferedText({ ...opts, json: true });
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

  it("reads the projections back out of a simulation report bound to this bundle", () => {
    const before = bufferIO();
    runDisclosure(dir, {}, before);
    expect(before.text()).toContain("Response cost: NOT MEASURED");

    simulate();

    const io = bufferIO();
    expect(runDisclosure(dir, {}, io)).toBe(0);
    const text = io.text();
    // The hint the old output could not honour now resolves: `anvil simulate`
    // was the named remedy and running it is what produced these figures.
    expect(text).toContain("Response cost: PROJECTED from simulated data under seed 1");
    expect(text).toContain("measurement of live traffic");
    // Seed, estimator and the evidence behind the numbers travel with them.
    expect(text).toContain("(o200k_base)");
    expect(text).toContain("Evidence: simulation.report.json, bound to this bundle's content");
    const hash = JSON.parse(readFileSync(reportPath(), "utf8")).bundleHash as string;
    expect(text).toContain(hash.slice(0, 12));
  });

  it("refuses a report bound to different bundle content and names the refresh", () => {
    simulate();
    // Widen the published surface. The report is excluded from the bundle's own
    // identity, so this moves the digest it was recorded against and nothing else.
    amendAir((air) => ({
      ...air,
      operations: air.operations.map((operation, index) =>
        index === 0
          ? { ...operation, description: `${operation.description} Amended.` }
          : operation,
      ),
    }));

    const io = bufferIO();
    expect(runDisclosure(dir, {}, io)).toBe(0);
    const text = io.text();
    // Stale evidence must never render as current, and "not measured" alone
    // would send the reader to re-run a command they have already run.
    expect(text).toContain("Response cost: NOT MEASURED");
    expect(text).toContain("NOT USED —");
    expect(text).toContain("simulation.report.json is stale");
    expect(text).toContain("anvil simulate");
    expect(text).not.toContain("Response cost: PROJECTED");
    // Nothing from the stale report leaks into the figures.
    expect(JSON.parse(bomJson({})).measurement.projectedOperations).toBe(0);
  });

  it("uses the refreshed report once the bundle is measured again", () => {
    simulate();
    amendAir((air) => ({
      ...air,
      operations: air.operations.map((operation, index) =>
        index === 0
          ? { ...operation, description: `${operation.description} Amended.` }
          : operation,
      ),
    }));
    expect(bufferedText({})).toContain("simulation.report.json is stale");

    simulate();
    expect(bufferedText({})).toContain("Response cost: PROJECTED from simulated data");
  });

  it("says an unreadable report is unreadable rather than unmeasured", () => {
    simulate();
    writeFileSync(reportPath(), "{ not json", "utf8");
    const text = bufferedText({});
    expect(text).toContain("Response cost: NOT MEASURED");
    expect(text).toContain("NOT USED — simulation.report.json is not valid JSON");
  });

  it("still shows figures from a failing run, and says the run failed", () => {
    simulate();
    // Freshness is a digest question and outcome is a separate one: these
    // figures were taken against this exact content and are usable, and the
    // reader is told the run that produced them went red before quoting them.
    const report = JSON.parse(readFileSync(reportPath(), "utf8"));
    report.summary.ok = false;
    report.summary.coveragePassed = report.summary.coverageCells - 1;
    writeFileSync(reportPath(), `${JSON.stringify(report, null, 2)}\n`, "utf8");

    const text = bufferedText({});
    expect(text).toContain("Response cost: PROJECTED from simulated data");
    expect(text).toContain("That simulation run did not pass its own gates");
  });

  it("carries the projection's provenance into --json for a machine reader", () => {
    simulate();
    const bom = JSON.parse(bomJson({}));
    expect(bom.responseEvidence.file).toBe("simulation.report.json");
    expect(bom.responseEvidence.state).toBe("fresh");
    expect(bom.responseEvidence.fresh).toBe(true);
    expect(bom.responseEvidence.used).toBeGreaterThan(0);
    expect(bom.measurement.projectionSources).toEqual(["simulation-report"]);
    expect(bom.operations[0].response.source).toBe("simulation-report");
  });

  it("reports tokens-to-reach by default, always with its round trips", () => {
    const text = bufferedText({});
    // The headline figure is reproducible on the reader's own bundle without
    // knowing a flag exists; the round trip it trades for is on the same line.
    expect(text).toMatch(/Reach\s+median [\d,]+ tokens · 1 hop/);
    expect(text).toContain("flat baseline");
    expect(text).toContain("typical");
    expect(text).toContain("worst case");
  });

  it("keeps the reach distribution behind --reach, where the dense detail belongs", () => {
    expect(bufferedText({})).not.toContain("Reach — tokens an agent must read");
    const text = bufferedText({ reach: true });
    expect(text).toContain("Reach — tokens an agent must read");
    expect(text).toContain("Flat listing");
    expect(text).toContain("Round trips");
    expect(text).toContain("Ratio");
    // Served flat here, so the ratio is 1 by construction and the report says
    // so rather than letting 1.0× read as a ladder that underperformed.
    expect(text).toContain("the ratios are 1 by construction");
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
