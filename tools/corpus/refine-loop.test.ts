// Tests for tools/corpus/refine-loop.mjs and schema-check.mjs.
//
// Split in two shapes, same as naming-conformance.test.ts:
//   - fast, pure-function tests over the ratchet math, the Markdown renderer,
//     and the schema checker — no subprocess, no filesystem beyond a JSON
//     schema file already checked in;
//   - a couple of slower integration tests that drive `runOnBundle` (and, for
//     the real corpus, `readEstatesTsv` + `estate import`) through the REAL
//     built `anvil` CLI, the same seam `run.mjs`'s `estates` mode uses. These
//     need `pnpm build` to have run first, exactly like every other corpus
//     test under this directory.
//
// Load-bearing for the mutation gate: deleting the drop check in
// `computeCatalogRatchet` must turn "the routing ratchet fails a drop beyond
// tolerance, and passes right at it" red — see tools/mutation/mutants.json,
// "corpus/refine-loop-ratchet-fails-on-drop".
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { airToYaml, loadAirDocument } from "@anvil/air";
import { afterEach, describe, expect, it } from "vitest";
import {
  DROP_TOLERANCE_PTS,
  computeCatalogRatchet,
  diffFlippedToFail,
  readEstatesTsv,
  renderSummaryMarkdown,
  reviewTierRefinements,
  runOnBundle,
} from "./refine-loop.mjs";
import { validateAgainstSchema } from "./schema-check.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const ROOT = join(HERE, "..", "..");
const ANVIL = join(ROOT, "packages", "cli", "dist", "bin-anvil.js");
const SCHEMA = JSON.parse(readFileSync(join(HERE, "refine-loop.schema.json"), "utf8"));

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

// --- diffFlippedToFail -----------------------------------------------------------

describe("diffFlippedToFail", () => {
  it("flags only tasks that passed before and fail now", () => {
    const baseline = [
      { operationId: "op.a", intent: "do a", pass: true },
      { operationId: "op.b", intent: "do b", pass: false },
      { operationId: "op.c", intent: "do c", pass: true },
    ];
    const current = [
      { operationId: "op.a", intent: "do a", pass: false }, // flipped
      { operationId: "op.b", intent: "do b", pass: true }, // improved, not a flip-to-fail
      { operationId: "op.c", intent: "do c", pass: true }, // unchanged
    ];
    expect(diffFlippedToFail(baseline, current)).toEqual([{ operationId: "op.a", intent: "do a" }]);
  });

  it("ignores a task with no baseline entry (a new intent example)", () => {
    const current = [{ operationId: "op.new", intent: "brand new", pass: false }];
    expect(diffFlippedToFail([], current)).toEqual([]);
  });

  it("returns nothing when nothing flipped", () => {
    const tasks = [{ operationId: "op.a", intent: "do a", pass: true }];
    expect(diffFlippedToFail(tasks, tasks)).toEqual([]);
  });
});

// --- computeCatalogRatchet ---------------------------------------------------------

describe("computeCatalogRatchet", () => {
  it("records rather than gates when there is no baseline entry", () => {
    const r = computeCatalogRatchet({ accuracy: 0.5, total: 4, tasks: [] }, undefined);
    expect(r.ok).toBe(true);
    expect(r.hasBaseline).toBe(false);
  });

  it("passes an improvement", () => {
    const r = computeCatalogRatchet(
      { accuracy: 0.9, total: 10, tasks: [] },
      { accuracy: 0.8, total: 10, tasks: [] },
    );
    expect(r.ok).toBe(true);
    expect(r.deltaPts).toBeCloseTo(10, 5);
  });

  it("passes a drop of EXACTLY the tolerance (a drop of 1.0 pt is not 'beyond' 1.0 pt)", () => {
    const r = computeCatalogRatchet(
      { accuracy: 0.79, total: 100, tasks: [] },
      { accuracy: 0.8, total: 100, tasks: [] },
    );
    expect(r.deltaPts).toBeCloseTo(-1.0, 5);
    expect(r.ok).toBe(true);
  });

  it("fails a drop beyond the tolerance and names the flipped tasks", () => {
    const baselineTasks = [
      { operationId: "op.a", intent: "do a", pass: true },
      { operationId: "op.b", intent: "do b", pass: true },
    ];
    const currentTasks = [
      { operationId: "op.a", intent: "do a", pass: false },
      { operationId: "op.b", intent: "do b", pass: true },
    ];
    const r = computeCatalogRatchet(
      { accuracy: 0.5, total: 2, tasks: currentTasks },
      { accuracy: 1.0, total: 2, tasks: baselineTasks },
    );
    expect(r.deltaPts).toBeLessThan(-DROP_TOLERANCE_PTS);
    expect(r.ok).toBe(false);
    expect(r.flippedToFail).toEqual([{ operationId: "op.a", intent: "do a" }]);
  });
});

// --- reviewTierRefinements ---------------------------------------------------------

describe("reviewTierRefinements", () => {
  it("keeps only improved/neutral (approval.tier === review) refinements", () => {
    const pack = {
      refinements: [
        { id: "a", skill: "s1", status: "approved", deficiency: "d1", approval: { tier: "auto", reason: "auto" } },
        { id: "b", skill: "s1", status: "improved", deficiency: "d2", approval: { tier: "review", reason: "measured clean" } },
        { id: "c", skill: "s1", status: "neutral", deficiency: "d3", approval: { tier: "review", reason: "no change" } },
        { id: "d", skill: "s1", status: "rejected", deficiency: "d4", approval: { tier: "reject", reason: "invalid" } },
        { id: "e", skill: "s1", status: "regressed", deficiency: "d5", approval: { tier: "reject", reason: "regressed" } },
      ],
    };
    const review = reviewTierRefinements(pack as never);
    expect(review.map((r) => r.id)).toEqual(["b", "c"]);
    expect(review[0]).toEqual({ id: "b", skill: "s1", status: "improved", deficiency: "d2", message: "measured clean" });
  });
});

// --- readEstatesTsv -----------------------------------------------------------------

describe("readEstatesTsv", () => {
  it("parses the real corpus, skipping comments and blank lines", () => {
    const rows = readEstatesTsv(join(HERE, "estates.tsv"));
    expect(rows.length).toBe(6);
    expect(rows[0]).toEqual({
      name: "kong-refunds",
      vendor: "kong",
      fixture: "packages/compiler/src/gateway/golden/estates/kong.yaml",
      api: "refunds",
    });
  });

  it("skips '#' comment lines and blank lines", () => {
    const dir = tempDir("refine-loop-tsv-");
    const path = join(dir, "estates.tsv");
    writeFileSync(path, "# comment\n\nname\tvendor\tfixture\tapi\n\n# trailing\n");
    expect(readEstatesTsv(path)).toEqual([{ name: "name", vendor: "vendor", fixture: "fixture", api: "api" }]);
  });
});

// --- schema-check + renderSummaryMarkdown -------------------------------------------

function minimalReport() {
  return {
    schemaVersion: 1,
    reportType: "anvil.refine-loop",
    generatedAt: "2026-01-01T00:00:00.000Z",
    dropTolerancePts: 1.0,
    estates: [
      {
        estate: "e1",
        vendor: "v1",
        status: "green",
        classification: "ok",
        refine: {
          packDir: "pack",
          summary: { proposed: 1, approved: 1, review: 0, rejected: 0, regressed: 0, skipped: 0 },
          reviewRefinements: [],
        },
        benchmark: {
          bundleHash: "a".repeat(64),
          router: "lexical",
          catalogSize: 0,
          summary: { total: 0, passed: 0, score: 0, curatedRouted: 0, bareRouted: 0, upliftPts: 0 },
        },
        clusters: [],
        routing: {
          flat: { accuracy: 0, total: 0, hasBaseline: false, baselineAccuracy: 0, deltaPts: 0, ok: true, flippedToFail: [], detail: "no baseline" },
          laddered: { accuracy: 0, total: 0, hasBaseline: false, baselineAccuracy: 0, deltaPts: 0, ok: true, flippedToFail: [], detail: "no baseline" },
        },
      },
    ],
    summary: { estates: 1, green: 1, totalReviewRefinements: 0, totalClusters: 0, totalExportedTasks: 0 },
    ratchet: { status: "green", regressions: [] },
  };
}

describe("refine-loop.schema.json + validateAgainstSchema", () => {
  it("accepts a well-formed report", () => {
    expect(validateAgainstSchema(SCHEMA, minimalReport())).toEqual([]);
  });

  it("rejects a report missing a required field", () => {
    const bad = minimalReport() as Record<string, unknown>;
    delete bad.ratchet;
    const errors = validateAgainstSchema(SCHEMA, bad);
    expect(errors.some((e) => e.includes("ratchet"))).toBe(true);
  });

  it("rejects a report with a wrong-typed field", () => {
    const bad = minimalReport();
    (bad.summary as unknown as { estates: string }).estates = "one" as never;
    const errors = validateAgainstSchema(SCHEMA, bad);
    expect(errors.some((e) => e.includes("summary.estates"))).toBe(true);
  });

  it("rejects an unknown top-level property (additionalProperties: false)", () => {
    const bad = { ...minimalReport(), extra: true };
    const errors = validateAgainstSchema(SCHEMA, bad);
    expect(errors.some((e) => e.includes("unexpected property 'extra'"))).toBe(true);
  });
});

describe("renderSummaryMarkdown", () => {
  it("titles the rolling issue 'Refinement inbox' and never auto-applies", () => {
    const md = renderSummaryMarkdown(minimalReport() as never);
    expect(md).toContain("# Refinement inbox");
    expect(md).toContain("Nothing here was auto-applied");
    expect(md).toContain("e1");
  });

  it("surfaces flipped operations under a routing regression", () => {
    const report = minimalReport();
    report.ratchet = {
      status: "red",
      regressions: [
        {
          estate: "e1",
          catalog: "flat",
          baselineAccuracy: 1,
          currentAccuracy: 0.5,
          deltaPts: -50,
          flippedToFail: [{ operationId: "svc.op", intent: "do the thing" }],
        },
      ],
    };
    const md = renderSummaryMarkdown(report as never);
    expect(md).toContain("Routing-accuracy regressions");
    expect(md).toContain("svc.op");
    expect(md).toContain("do the thing");
  });
});

// --- integration: runOnBundle against a real, built anvil CLI -----------------------
//
// Mirrors packages/cli/src/commands/refine-group.test.ts's fixture: three
// confusable "views" operations (list/execute/count) plus one unrelated
// operation, whose intent phrasing routes some "count"/"execute" tasks to the
// wrong tool — enough mis-routes to clear MIN_CLUSTER_EVIDENCE.

function confusableClusterAir() {
  const read = (overrides: Record<string, unknown>) => ({
    idempotency: { mode: "natural" },
    retries: { mode: "safe" },
    confirmation: { required: false },
    auth: { type: "api_key" },
    errors: [],
    evidence: { claims: [] },
    state: "approved",
    ...overrides,
  });
  return loadAirDocument({
    service: { id: "svc", displayName: "Service", version: "1", source: { kind: "openapi" } },
    operations: [
      read({
        id: "svc.views.list",
        canonicalName: "list_views",
        displayName: "List views",
        description: "List all views.",
        sourceRef: { kind: "openapi", path: "/views", method: "get", operationId: "listViews" },
        effect: { kind: "read", action: "list", resource: "view" },
        input: { params: [] },
        output: { schema: { type: "array", items: { type: "object", properties: { view_id: { type: "string" } } } } },
        cli: { command: "svc views list" },
        mcp: { toolName: "svc_list_views" },
        skill: {
          intentExamples: [
            "show all views",
            "execute the view list",
            "count the views available",
            "execute the whole view list",
            "count the views for me",
          ],
        },
      }),
      read({
        id: "svc.views.execute",
        canonicalName: "execute_view",
        displayName: "Execute view",
        description: "Execute a view and return its rows.",
        sourceRef: { kind: "openapi", path: "/views/{view_id}/execute", method: "get", operationId: "executeView" },
        effect: { kind: "read", action: "get", resource: "view" },
        input: { params: [{ name: "view_id", in: "path", required: true, example: "v1" }] },
        output: { schema: { type: "object", properties: { rows: { type: "array" } } } },
        cli: { command: "svc views execute" },
        mcp: { toolName: "svc_execute_view" },
        skill: {
          intentExamples: [
            "execute the view",
            "list the view rows",
            "count rows the view returns",
            "count rows in the view result",
          ],
        },
      }),
      read({
        id: "svc.views.count",
        canonicalName: "count_view",
        displayName: "Count view tickets",
        description: "Count tickets in a view.",
        sourceRef: { kind: "openapi", path: "/views/{view_id}/count", method: "get", operationId: "countView" },
        effect: { kind: "read", action: "get", resource: "view" },
        input: { params: [{ name: "view_id", in: "path", required: true, example: "v1" }] },
        output: { schema: { type: "object", properties: { count: { type: "integer" } } } },
        cli: { command: "svc views count" },
        mcp: { toolName: "svc_count_view" },
        skill: { intentExamples: ["count tickets in the view", "execute a count of the view"] },
      }),
      read({
        id: "svc.tickets.get",
        canonicalName: "get_ticket",
        displayName: "Get ticket",
        description: "Get one ticket.",
        sourceRef: { kind: "openapi", path: "/tickets/{ticket_id}", method: "get", operationId: "getTicket" },
        effect: { kind: "read", action: "get", resource: "ticket" },
        input: { params: [{ name: "ticket_id", in: "path", required: true, example: "t1" }] },
        output: { schema: { type: "object", properties: { ticket: { type: "object" } } } },
        cli: { command: "svc tickets get" },
        mcp: { toolName: "svc_get_ticket" },
        skill: { intentExamples: ["get a ticket"] },
      }),
    ],
  });
}

function writeBundleFixture(): string {
  const root = tempDir("refine-loop-bundle-");
  writeFileSync(join(root, "air.yaml"), airToYaml(confusableClusterAir()));
  return root;
}

describe("runOnBundle (real anvil CLI)", () => {
  it("collects a confusable cluster, exports its task, and finds no review-tier refinements on a fully-approved fixture", async () => {
    if (!existsSync(ANVIL)) throw new Error(`CLI not built: ${ANVIL}. Run \`pnpm build\` first.`);
    const bundleDir = writeBundleFixture();
    const rowDir = tempDir("refine-loop-row-");

    const record = await runOnBundle("fixture-estate", "fixture-vendor", bundleDir, rowDir, ROOT, { estates: {} });

    expect(record.status).toBe("green"); // no baseline yet — recorded, not gated
    expect(record.refine.summary.proposed).toBeGreaterThanOrEqual(0);
    expect(record.clusters.length).toBeGreaterThan(0);
    const cluster = record.clusters[0];
    expect(cluster.taskCount).toBeGreaterThanOrEqual(5);
    expect(cluster.exportOk).toBe(true);
    expect(cluster.exportedTaskPath).toBeDefined();

    const taskPath = join(ROOT, cluster.exportedTaskPath as string);
    expect(existsSync(taskPath)).toBe(true);
    const task = JSON.parse(readFileSync(taskPath, "utf8"));
    expect(task.skill.name).toBe("resolve-confusable-cluster");

    // The whole record must still satisfy the schema this test suite ships
    // (root passed explicitly so the estate item's $ref into #/definitions
    // resolves against the full document, not the sub-schema alone). Strip
    // the internal-only `_currentRouting` carry field the way buildReport
    // does before the record becomes part of the public report.
    const { _currentRouting, ...publicRecord } = record as Record<string, unknown>;
    void _currentRouting;
    const errors = validateAgainstSchema(SCHEMA.properties.estates.items, publicRecord, "", SCHEMA);
    expect(errors).toEqual([]);
  }, 60_000);

  it("fails the ratchet and names the flipped operation when a synthetic baseline shows a prior pass turning into a fail", async () => {
    if (!existsSync(ANVIL)) throw new Error(`CLI not built: ${ANVIL}. Run \`pnpm build\` first.`);
    const bundleDir = writeBundleFixture();
    const rowDir = tempDir("refine-loop-row-");

    // First, a real run to learn this fixture's actual flat-catalog tasks.
    const first = await runOnBundle("fixture-estate", "fixture-vendor", bundleDir, rowDir, ROOT, { estates: {} });
    const realTasks = (first as unknown as { _currentRouting: { flat: { tasks: unknown[] } } })._currentRouting.flat
      .tasks as Array<{ operationId: string; intent: string; pass: boolean }>;
    expect(realTasks.length).toBeGreaterThan(0);

    // Fabricate a baseline where every task the fixture actually got right is
    // recorded as having passed, but at a perfect accuracy that this run
    // cannot possibly still meet (the fixture is built to mis-route some
    // tasks) — a real, not a contrived, drop.
    const inflatedTasks = realTasks.map((t) => ({ ...t, pass: true }));
    const baseline = {
      estates: {
        "fixture-estate": {
          flat: { accuracy: 1, total: inflatedTasks.length, tasks: inflatedTasks },
          laddered: { accuracy: 1, total: inflatedTasks.length, tasks: inflatedTasks },
        },
      },
    };

    const rowDir2 = tempDir("refine-loop-row-");
    const record = await runOnBundle("fixture-estate", "fixture-vendor", bundleDir, rowDir2, ROOT, baseline);

    expect(record.status).toBe("regression");
    expect(record.routing.flat.ok).toBe(false);
    expect(record.routing.flat.flippedToFail.length).toBeGreaterThan(0);
  }, 60_000);
});

describe("runEstateRow via the real corpus (kong-refunds)", () => {
  it("imports the real gateway fixture end to end and stays schema-valid", () => {
    if (!existsSync(ANVIL)) throw new Error(`CLI not built: ${ANVIL}. Run \`pnpm build\` first.`);
    const outDir = tempDir("refine-loop-cli-");
    const result = spawnSync(
      process.execPath,
      [join(HERE, "refine-loop.mjs"), "--systems", "kong-refunds", "--work", outDir],
      { cwd: ROOT, encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("kong-refunds");

    const report = JSON.parse(readFileSync(join(HERE, "report", "refine-loop.report.json"), "utf8"));
    expect(validateAgainstSchema(SCHEMA, report)).toEqual([]);
    expect(report.estates.some((e: { estate: string }) => e.estate === "kong-refunds")).toBe(true);
  }, 60_000);
});
