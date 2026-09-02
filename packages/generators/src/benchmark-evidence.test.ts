import { BENCHMARK_REPORT_FILE, type BenchmarkReport } from "@anvil/refinement";
import { describe, expect, it } from "vitest";
import { benchmarkEvidenceStatus, bundleHash } from "./certify.js";

/**
 * The two readers of `benchmark.report.json` agree. The full report shape is
 * declared once, as zod, in `@anvil/refinement` (what `anvil benchmark`
 * writes); the certify reader here validates only the envelope it needs for
 * freshness. A report that is well-typed against the full shape must therefore
 * be accepted here as fresh — otherwise a schema change on one side would
 * silently turn every benchmark into "corrupt" evidence on the other.
 */
describe("benchmark evidence reader", () => {
  it("accepts a report typed against the full @anvil/refinement shape as fresh", () => {
    const files: Record<string, string> = { "air.yaml": "service: {}\n" };
    const report: BenchmarkReport = {
      schemaVersion: 2,
      router: "lexical",
      catalogSize: 1,
      operations: [
        {
          operationId: "svc.things.list",
          toolName: "svc_list_things",
          tasks: [
            {
              intent: "list the things",
              curated: { routed: "svc_list_things", pass: true },
              bare: { routed: "listThings", pass: true },
              satisfiable: true,
              pass: true,
            },
          ],
          score: 1,
        },
      ],
      confusion: {
        posture: "candidate",
        minClusterEvidence: 5,
        hubPartnerFraction: 0.05,
        hubMinPartners: 6,
        hubs: [],
        clusters: [],
      },
      summary: {
        total: 1,
        passed: 1,
        score: 1,
        curatedRouted: 1,
        bareRouted: 1,
        upliftPts: 0,
      },
      bundleHash: bundleHash(files),
    };
    const status = benchmarkEvidenceStatus({
      ...files,
      [BENCHMARK_REPORT_FILE]: JSON.stringify(report),
    });
    expect(status).toMatchObject({ state: "fresh", fresh: true, score: 1 });
  });
});
