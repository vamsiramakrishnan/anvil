import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AirDocument, planWorkflowSurface } from "@anvil/air";
import { capabilityDisclosureBudget, compile, diffContracts } from "@anvil/compiler";
import {
  approveCapabilityInBundle,
  approveOperationsInBundle,
  bundleHash,
  generateBundle,
  loadBundleAir,
  readBundleDir,
  writeBundle,
} from "@anvil/generators";
import {
  analyzeConfusion,
  applyPackToBundle,
  BENCHMARK_REPORT_FILE,
  type BenchmarkOperationResult,
  bareCatalog,
  benchmarkOperations,
  buildRefinementPlan,
  curatedCatalog,
  exportRefinementTask,
  HarnessProtocolError,
  importRefinementSubmission,
  lexicalRouter,
  packFiles,
  parseBenchmarkReport,
  readBenchmarkReport,
  readPackDir,
  readPackReceipts,
  refinementPackHash,
  routeAndScore,
  runRefinements,
  selectTaskDeficiency,
  targetKey,
} from "@anvil/refinement";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CONSOLE_ROUTES,
  type ConsoleResponse,
  zApplyPackResponse,
  zApproveCapabilityResponse,
  zApproveOperationsResponse,
  zBenchmarkView,
  zBundleInspector,
  zDecisionItem,
  zDecisionKind,
  zDecisionQueue,
  zDriftView,
  zErrorEnvelope,
  zExportTaskResponse,
  zImportTaskResponse,
  zPackList,
  zWorkspace,
} from "./contract.js";

/**
 * The contract stays honest against the code, not against hand-written JSON:
 * every response schema is parsed over a fixture built from the REAL payments
 * example — compiled, generated, written to disk — through the same lifted
 * library functions the console server will call. A field the library stops
 * producing, or a shape it changes, fails here.
 */

const examples = fileURLToPath(new URL("../../../examples/payments/", import.meta.url));
const read = (rel: string) => readFileSync(join(examples, rel), "utf8");

let root: string;
let bundleDir: string;
let packDir: string;
let air: AirDocument;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "anvil-console-contract-"));
  bundleDir = join(root, "payments");
  const compiled = await compile({
    spec: read("openapi.yaml"),
    manifest: read("anvil.yaml"),
    serviceId: "payments",
  });
  writeBundle(bundleDir, generateBundle(compiled));
  air = loadBundleAir(bundleDir, readBundleDir(bundleDir));
  // The export/import rails bind a repository revision, so the workspace is a git repo.
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "anvil@example.test"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Anvil Test"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
  // A refinement pack where `anvil refine run --out` puts one, and a benchmark
  // report beside the bundle, both from the library: the queue projects both.
  packDir = join(root, "packs", "first");
  mkdirSync(packDir, { recursive: true });
  const pack = await runRefinements(air, { safeOnly: false });
  for (const [name, contents] of Object.entries(packFiles(pack))) {
    writeFileSync(join(packDir, name), contents, "utf8");
  }
  writeFileSync(
    join(bundleDir, BENCHMARK_REPORT_FILE),
    JSON.stringify(await benchmark(air)),
    "utf8",
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function countBy<T extends string>(values: readonly T[]): Partial<Record<T, number>> {
  const counts: Partial<Record<T, number>> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

/** A minimal benchmark report, produced by the library's own routing core. */
async function benchmark(document: AirDocument) {
  const ops = benchmarkOperations(document);
  const curated = curatedCatalog(ops);
  const bare = bareCatalog(ops);
  const router = lexicalRouter();
  const operations: BenchmarkOperationResult[] = [];
  for (const op of ops) {
    const tasks = [];
    for (const intent of op.skill.intentExamples) {
      const curatedOutcome = await routeAndScore(router, intent, curated, op.id);
      const bareOutcome = await routeAndScore(router, intent, bare, op.id);
      tasks.push({
        intent,
        curated: curatedOutcome,
        bare: bareOutcome,
        satisfiable: true,
        pass: curatedOutcome.pass,
      });
    }
    operations.push({
      operationId: op.id,
      toolName: op.mcp.toolName,
      tasks,
      score: tasks.length > 0 ? tasks.filter((t) => t.pass).length / tasks.length : 0,
    });
  }
  const all = operations.flatMap((o) => o.tasks);
  const passed = all.filter((t) => t.pass).length;
  return parseBenchmarkReport({
    schemaVersion: 2,
    router: router.name,
    catalogSize: curated.length,
    operations,
    confusion: analyzeConfusion(operations),
    summary: {
      total: all.length,
      passed,
      score: all.length > 0 ? passed / all.length : 0,
      curatedRouted: all.filter((t) => t.curated.pass).length,
      bareRouted: all.filter((t) => t.bare.pass).length,
      upliftPts: 0,
    },
    bundleHash: bundleHash(readBundleDir(bundleDir)),
  });
}

describe("the console contract parses what the library produces", () => {
  it("GET /api/workspace", () => {
    const view: ConsoleResponse<"workspace"> = {
      root,
      bundles: [
        {
          id: "payments",
          path: bundleDir,
          service: { id: air.service.id, version: air.service.version },
          sourceKind: air.service.source.kind,
          pathGrammar: air.service.source.pathGrammar?.classification,
          counts: {
            operations: countBy(air.operations.map((op) => op.state)),
            capabilities: countBy(air.capabilities.map((cap) => cap.lifecycle)),
            workflows: countBy(air.workflows.map((wf) => wf.state)),
          },
          hasBenchmark: readBenchmarkReport(bundleDir) !== undefined,
          packs: 0,
        },
      ],
    };
    expect(zWorkspace.parse(view)).toEqual(view);
    expect(view.bundles[0]?.counts.operations.approved).toBeGreaterThan(0);
  });

  it("GET /api/bundles/:id — the inspector", () => {
    const opsById = new Map(air.operations.map((op) => [op.id, op]));
    const approved = new Map([...opsById].filter(([, op]) => op.state === "approved"));
    const plan = planWorkflowSurface(air.workflows, approved, opsById);
    const before = [...approved.values()].map((op) => op.mcp.toolName);
    const after = [
      ...[...approved.values()]
        .filter((op) => !plan.superseded.has(op.id))
        .map((op) => op.mcp.toolName),
      ...plan.registrations
        .filter((r) => r.skipReason === undefined)
        .map((r) => r.workflow.id.replace(/[^A-Za-z0-9_-]/g, "_")),
    ];
    const view: ConsoleResponse<"bundle"> = {
      id: "payments",
      path: bundleDir,
      service: air.service,
      source: air.service.source,
      pathGrammar: air.service.source.pathGrammar,
      diagnostics: air.diagnostics,
      operations: air.operations.map((op) => ({
        id: op.id,
        canonicalName: op.canonicalName,
        displayName: op.displayName,
        mcp: { toolName: op.mcp.toolName },
        cli: { command: op.cli.command },
        effect: op.effect,
        state: op.state,
        idempotency: { mode: op.idempotency.mode },
        confirmation: { required: op.confirmation.required },
        diagnosticCount: air.diagnostics.filter((d) => d.operationId === op.id).length,
        blockerNotes: op.reviewNotes,
      })),
      capabilities: air.capabilities.map((cap) => ({
        id: cap.id,
        lifecycle: cap.lifecycle,
        source: cap.source,
        displayName: cap.displayName,
        members: cap.operationIds,
        budget: capabilityDisclosureBudget(air, cap.id),
      })),
      workflows: air.workflows.map((wf) => {
        const registration = plan.registrations.find((r) => r.workflow.id === wf.id);
        return {
          id: wf.id,
          state: wf.state,
          steps: wf.steps,
          supersedes: wf.supersedes,
          plan: {
            registrable: registration?.skipReason === undefined,
            skipReason: registration?.skipReason,
          },
          refusals: plan.refused.filter((r) => r.workflowId === wf.id),
        };
      }),
      servedSurface: { before, after },
    };
    const parsed = zBundleInspector.parse(view);
    expect(parsed.operations.length).toBe(air.operations.length);
    expect(parsed.capabilities.length).toBeGreaterThan(0);
    expect(parsed.workflows.length).toBeGreaterThan(0);
    expect(parsed.servedSurface.before.length).toBeGreaterThan(0);
  });

  it("GET /api/bundles/:id/queue — every kind of decision, each with its subject", () => {
    const opsById = new Map(air.operations.map((op) => [op.id, op]));
    const approved = new Map([...opsById].filter(([, op]) => op.state === "approved"));
    const plan = planWorkflowSurface(air.workflows, approved, opsById);
    const refinementPlan = buildRefinementPlan(air);
    const stored = readPackDir(packDir);
    const decided = new Set(readPackReceipts(packDir).map((r) => r.refinementId));
    const report = readBenchmarkReport(bundleDir);
    if (!report) throw new Error("the benchmark report was not written");
    const view: ConsoleResponse<"queue"> = {
      bundleId: "payments",
      items: [
        ...air.operations
          .filter((op) => op.state !== "approved")
          .map((op) => ({
            kind: "operation" as const,
            id: op.id,
            title: op.displayName,
            reasons: op.reviewNotes,
            evidence: op.evidence.claims,
            suggestedAction:
              op.state === "blocked" ? "resolve blocking diagnostics and recompile" : "approve",
            blocking: op.state === "blocked",
            subject: {
              operationId: op.id,
              effect: op.effect,
              idempotency: { mode: op.idempotency.mode },
              retries: { mode: op.retries.mode },
              confirmation: { required: op.confirmation.required },
            },
          })),
        ...air.capabilities
          .filter((cap) => cap.lifecycle === "proposed")
          .map((cap) => ({
            kind: "capability" as const,
            id: cap.id,
            title: cap.displayName,
            reasons: [`${cap.source} grouping awaiting review`],
            evidence: cap.evidence.claims,
            suggestedAction: "approve or reject the grouping",
            blocking: false,
            subject: { capabilityId: cap.id, budget: capabilityDisclosureBudget(air, cap.id) },
          })),
        ...air.workflows.map((wf) => {
          const skipReason = plan.registrations.find((r) => r.workflow.id === wf.id)?.skipReason;
          return {
            kind: "workflow" as const,
            id: wf.id,
            title: wf.id,
            reasons: skipReason !== undefined ? [skipReason] : [`workflow is ${wf.state}`],
            evidence: wf.evidence.claims,
            suggestedAction: "revise the workflow's steps or supersedes and recompile",
            blocking: false,
            subject: {
              workflowId: wf.id,
              plan: { registrable: skipReason === undefined, skipReason },
            },
          };
        }),
        ...refinementPlan.deficiencies.map((deficiency) => ({
          kind: "refinement" as const,
          id: `${deficiency.code}:${targetKey(deficiency.target)}`,
          title: deficiency.message,
          reasons: [deficiency.code],
          evidence: [],
          suggestedAction: deficiency.suggestedSkill,
          blocking: deficiency.severity === "blocking",
          subject: {
            deficiencyId: targetKey(deficiency.target),
            skill: deficiency.suggestedSkill,
          },
        })),
        ...stored.refinements
          .filter(
            (r) =>
              r.approval.tier === "review" &&
              (r.status === "improved" || r.status === "neutral") &&
              !decided.has(r.id),
          )
          .map((r) => ({
            kind: "pack" as const,
            id: r.id,
            title: `${r.skill} → ${r.id}`,
            reasons: [r.approval.reason],
            evidence: r.evidence,
            suggestedAction: "approve or reject with a receipt (anvil refine approve|reject)",
            blocking: false,
            subject: {
              packHash: refinementPackHash(stored),
              refinementId: r.id,
              tier: r.approval.tier,
            },
          })),
        ...report.confusion.clusters.map((cluster) => ({
          kind: "cluster" as const,
          id: cluster.id,
          title: `${cluster.members.length} confusable tools, ${cluster.taskCount} mis-routed tasks`,
          reasons: cluster.edges.map(
            (edge) => `${edge.intended} routed to ${edge.routed} ×${edge.count}`,
          ),
          evidence: [],
          suggestedAction: `export a case file (anvil refine export-task … group:${cluster.id})`,
          blocking: false,
          subject: {
            clusterId: cluster.id,
            memberOperationIds: cluster.members.map((member) => member.operationId),
            evidence: cluster.edges,
          },
        })),
      ],
    };
    const parsed = zDecisionQueue.parse(view);
    expect(parsed.items.filter((item) => item.kind === "operation").length).toBe(
      air.operations.filter((op) => op.state !== "approved").length,
    );
    expect(parsed.items.some((item) => item.kind === "refinement")).toBe(true);
    expect(parsed.items.some((item) => item.kind === "workflow")).toBe(true);
    for (const item of parsed.items) {
      if (item.kind === "operation") expect(item.subject.operationId).toBe(item.id);
      if (item.kind === "capability") expect(item.subject.capabilityId).toBe(item.id);
      if (item.kind === "refinement") expect(item.subject.deficiencyId).toMatch(/^[a-z]+:/);
    }
    // The payments pack's refinements are all auto-tier — the deterministic
    // executor grounds every one — so the projection lists none as a decision.
    // The pack subject is still parsed over the real pack's identity.
    const first = stored.refinements[0];
    if (!first) throw new Error("the payments pack is empty");
    expect(parsed.items.filter((item) => item.kind === "pack")).toEqual([]);
    const packItem = zDecisionItem.parse({
      kind: "pack",
      id: first.id,
      title: first.skill,
      reasons: [first.approval.reason],
      evidence: first.evidence,
      suggestedAction: "approve or reject with a receipt (anvil refine approve|reject)",
      blocking: false,
      subject: {
        packHash: refinementPackHash(stored),
        refinementId: first.id,
        tier: first.approval.tier,
      },
    });
    expect(packItem.kind === "pack" && packItem.subject.packHash).toMatch(/^[0-9a-f]{64}$/);
    // The kind enum and the discriminated union name the same six kinds, in order.
    expect(zDecisionKind.options).toEqual(zDecisionItem.options.map((o) => o.shape.kind.value));
    expect(zDecisionKind.options).toEqual([
      "operation",
      "capability",
      "workflow",
      "refinement",
      "pack",
      "cluster",
    ]);
  });
  it("GET /api/bundles/:id/packs", () => {
    const stored = readPackDir(packDir);
    const view: ConsoleResponse<"packs"> = [
      {
        dir: packDir,
        hash: refinementPackHash(stored),
        service: stored.service,
        summary: stored.summary,
        items: stored.refinements.map((refinement) => ({
          refinementId: refinement.id,
          skill: refinement.skill,
          target: refinement.target,
          status: refinement.status,
          tier: refinement.approval.tier,
          patchSummary: Object.entries(refinement.proposal.set)
            .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
            .join(" "),
          claims: refinement.evidence,
          receiptPaths: [],
        })),
        receipts: readPackReceipts(packDir),
      },
    ];
    expect(zPackList.parse(view)).toEqual(view);
  });
  it("GET /api/bundles/:id/benchmark", () => {
    const stored = readBenchmarkReport(bundleDir);
    expect(stored).toBeDefined();
    if (!stored) throw new Error("unreachable");
    const view: ConsoleResponse<"benchmark"> = {
      router: stored.router,
      catalogSize: stored.catalogSize,
      bundleHash: stored.bundleHash,
      fresh: stored.bundleHash === bundleHash(readBundleDir(bundleDir)),
      summary: stored.summary,
      confusion: stored.confusion,
    };
    expect(zBenchmarkView.parse(view)).toEqual(view);
    expect(zBenchmarkView.parse(null)).toBeNull();
    expect(view?.fresh).toBe(true);
  });
  it("GET /api/bundles/:id/drift?against=", () => {
    const later = structuredClone(air);
    const first = later.operations[0];
    if (!first) throw new Error("fixture has no operations");
    first.description = `${first.description} (changed)`;
    later.operations.splice(1, 1);
    const view: ConsoleResponse<"drift"> = {
      bundleId: "payments",
      against: "payments-next",
      items: diffContracts(air, later),
    };
    const parsed = zDriftView.parse(view);
    expect(parsed.items.length).toBeGreaterThan(0);
  });

  it("POST /api/bundles/:id/packs/:hash/apply — the wire form drops an undefined side", () => {
    const result = applyPackToBundle(bundleDir, packDir, { dryRun: true });
    const view: ConsoleResponse<"applyPack"> = {
      airPath: result.airPath,
      applied: result.applied.map((refinement) => refinement.id),
      changes: result.changes,
      written: result.written,
    };
    expect(view.applied.length).toBeGreaterThan(0);
    const wire = JSON.parse(JSON.stringify(view));
    expect(zApplyPackResponse.parse(wire)).toEqual(wire);
    // A change that adds a node has no `before`; JSON drops the key and the
    // contract parses it absent rather than coerced to null.
    const added = { ...view.changes[0], before: undefined };
    const parsed = zApplyPackResponse.parse(
      JSON.parse(JSON.stringify({ ...view, changes: [added] })),
    );
    expect(parsed.changes[0]).not.toHaveProperty("before");
    expect(parsed.changes[0]?.after).toEqual(view.changes[0]?.after);
  });

  it("POST /api/bundles/:id/operations/approve", () => {
    const already = air.operations.filter((op) => op.state === "approved").map((op) => op.id);
    const result = approveOperationsInBundle(bundleDir, already.slice(0, 2));
    const stale = {
      targetFiles: Object.keys(result.reprojection.existingFiles).filter((rel) =>
        rel.startsWith("targets/"),
      ),
      records: Object.keys(result.reprojection.existingFiles).filter((rel) =>
        rel.endsWith(".report.json"),
      ),
      gatewayReceipt: result.reprojection.existingFiles["import.receipt.json"] !== undefined,
    };
    const view: ConsoleResponse<"approveOperations"> = {
      approved: result.newlyApproved,
      alreadyApproved: result.requested.filter((id) => !result.newlyApproved.includes(id)),
      regeneratedFiles: result.reprojection.generatedFileCount,
      reprojection: {
        bundleDir: result.reprojection.bundleDir,
        generatedFileCount: result.reprojection.generatedFileCount,
        projectionsChanged: result.reprojection.projectionsChanged,
        retainedBackup: result.reprojection.retainedBackup,
        stale,
      },
      refusals: [],
    };
    const parsed = zApproveOperationsResponse.parse(view);
    expect(parsed.alreadyApproved.length).toBe(2);
    expect(parsed.reprojection.stale.records).toContain(BENCHMARK_REPORT_FILE);
  });

  it("POST /api/bundles/:id/capabilities/:capId/approve", () => {
    const proposed = air.capabilities.find((cap) => cap.lifecycle === "proposed");
    if (!proposed) throw new Error("fixture has no proposed capability");
    const { budget, reprojection } = approveCapabilityInBundle(bundleDir, proposed.id, {});
    const view: ConsoleResponse<"approveCapability"> = {
      capabilityId: proposed.id,
      budget,
      reprojection: {
        bundleDir: reprojection.bundleDir,
        generatedFileCount: reprojection.generatedFileCount,
        projectionsChanged: reprojection.projectionsChanged,
        stale: { targetFiles: [], records: [], gatewayReceipt: false },
      },
    };
    const parsed = zApproveCapabilityResponse.parse(view);
    expect(parsed.budget.verdict).toBe("ok");
    expect(parsed.reprojection.projectionsChanged).toBe(true);
    const after = loadBundleAir(bundleDir, readBundleDir(bundleDir));
    expect(after.capabilities.find((cap) => cap.id === proposed.id)?.lifecycle).toBe("approved");
  });

  it("POST export-task and tasks/import, including the refusal envelope", async () => {
    const current = loadBundleAir(bundleDir, readBundleDir(bundleDir));
    const plan = buildRefinementPlan(current);
    const candidate = plan.deficiencies.find(
      (deficiency) => deficiency.target.kind === "operation" || deficiency.target.kind === "field",
    );
    if (!candidate) throw new Error("fixture plan has no investigable deficiency");
    const key =
      candidate.target.kind === "operation"
        ? `operation:${candidate.target.operationId}`
        : `field:${candidate.target.operationId}#${candidate.target.path}`;
    const deficiency = selectTaskDeficiency(current, bundleDir, key, {
      skill: candidate.suggestedSkill,
      displayPath: bundleDir,
    });
    const taskPath = join(root, "task.json");
    const task = exportRefinementTask(current, deficiency, taskPath, { repositoryRoot: root });
    const exported: ConsoleResponse<"exportTask"> = { taskPath, task };
    expect(zExportTaskResponse.parse(exported)).toEqual(exported);

    // An honest decline is the smallest valid submission; the import writes a
    // pack with no refinements and the success view still parses.
    const submission = {
      schemaVersion: 1,
      taskId: task.taskId,
      taskHash: task.taskHash,
      executor: { name: "test-harness", version: "1" },
      status: "insufficient_evidence",
      summary: "Nothing in the repository supports a change.",
      evidence: [],
      claims: [],
    };
    const packDir = join(root, "packs", "imported");
    const imported = await importRefinementSubmission(
      current,
      JSON.parse(readFileSync(taskPath, "utf8")),
      submission,
      packDir,
      { repositoryRoot: root },
    );
    const record = imported.pack.harnessImports?.[0];
    if (!record) throw new Error("import produced no provenance record");
    const success: ConsoleResponse<"importTask"> = {
      taskId: record.task.taskId,
      packDir,
      summary: imported.pack.summary,
      refinement: imported.pack.refinements[0]
        ? {
            id: imported.pack.refinements[0].id,
            status: imported.pack.refinements[0].status,
            tier: imported.pack.refinements[0].approval.tier,
          }
        : undefined,
      delta: imported.delta,
    };
    expect(zImportTaskResponse.parse(success)).toEqual(success);

    // A tampered task is refused by the protocol; the refusal is the error envelope.
    let envelope: unknown;
    try {
      await importRefinementSubmission(
        current,
        { ...task, taskHash: "0".repeat(64) },
        submission,
        join(root, "packs", "refused"),
        { repositoryRoot: root },
      );
    } catch (error) {
      if (!(error instanceof HarnessProtocolError)) throw error;
      envelope = {
        error: {
          code: error.rejection.code,
          message: error.rejection.message,
          issues: error.rejection.issues,
        },
      };
    }
    const parsed = zErrorEnvelope.parse(envelope);
    expect(parsed.error.code).toMatch(/^refinement\//);
  });

  it("names every route once, with a schema for every body it accepts", () => {
    const paths = Object.values(CONSOLE_ROUTES).map((route) => `${route.method} ${route.path}`);
    expect(new Set(paths).size).toBe(paths.length);
    for (const route of Object.values(CONSOLE_ROUTES)) {
      if (route.mutates) {
        expect(route.method).toBe("POST");
        expect("request" in route).toBe(true);
      } else {
        expect(route.method).toBe("GET");
      }
    }
  });
});
