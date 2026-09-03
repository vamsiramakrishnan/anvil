import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { analyzeConfusion } from "./clusters.js";
import { type BenchmarkReport, parseBenchmarkReport } from "./report.js";

/**
 * The report schema round-trip: `anvil benchmark` writes a `BenchmarkReport`
 * as JSON and every reader (the console's contract, the certify reader in
 * `@anvil/generators`, `protocol/group.ts`) parses it back through
 * `parseBenchmarkReport`. The optional `catalogs` block has to survive that
 * trip both present and absent, because `--catalog flat` (the default) omits
 * it entirely — that omission IS the byte-compatibility guarantee the console
 * contract test depends on.
 */

const EMPTY_BUNDLE_DIGEST = createHash("sha256").digest("hex");

function baseReport(): BenchmarkReport {
  return {
    schemaVersion: 2,
    router: "lexical",
    catalogSize: 2,
    operations: [],
    confusion: analyzeConfusion([]),
    summary: { total: 0, passed: 0, score: 0, curatedRouted: 0, bareRouted: 0, upliftPts: 0 },
    bundleHash: EMPTY_BUNDLE_DIGEST,
  };
}

describe("benchmark report round-trip", () => {
  it("parses a report with no catalogs block — the default --catalog flat shape", () => {
    const report = baseReport();
    expect(report.catalogs).toBeUndefined();
    const parsed = parseBenchmarkReport(JSON.parse(JSON.stringify(report)));
    expect(parsed).toEqual(report);
    expect(parsed.catalogs).toBeUndefined();
  });

  it("round-trips a populated catalogs block byte-for-byte", () => {
    const report: BenchmarkReport = {
      ...baseReport(),
      catalogs: {
        flat: { total: 20, passed: 18, accuracy: 0.9, upliftPts: 10 },
        laddered: { total: 20, passed: 17, accuracy: 0.85, upliftPts: 8.5 },
        disclosureCost: {
          flatTokens: 24000,
          ladderRestTokens: 600,
          avgOpenedLaneTokens: 4000,
          estimatedLadderedTokens: 4600,
        },
      },
    };
    const parsed = parseBenchmarkReport(JSON.parse(JSON.stringify(report)));
    expect(parsed).toEqual(report);
  });

  it("accepts a catalogs block with only one mode populated", () => {
    const report: BenchmarkReport = {
      ...baseReport(),
      catalogs: { laddered: { total: 5, passed: 5, accuracy: 1, upliftPts: 0 } },
    };
    const parsed = parseBenchmarkReport(JSON.parse(JSON.stringify(report)));
    expect(parsed.catalogs?.flat).toBeUndefined();
    expect(parsed.catalogs?.laddered?.accuracy).toBe(1);
  });

  it("still refuses a structurally invalid report, catalogs or not", () => {
    const broken = { ...baseReport(), schemaVersion: 3 };
    expect(() => parseBenchmarkReport(broken)).toThrow(/Invalid benchmark report/);
  });
});
