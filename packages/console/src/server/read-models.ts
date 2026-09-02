import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type AirDocument, type Operation, planWorkflowSurface } from "@anvil/air";
import { capabilityDisclosureBudget, diffContracts } from "@anvil/compiler";
import { bundleHash, loadBundleAir, readBundleDir } from "@anvil/generators";
import {
  buildRefinementPlan,
  describeTarget,
  readBenchmarkReport,
  readPackReceipts,
  targetKey,
  zRefinementReviewReceipt,
} from "@anvil/refinement";
import {
  type BenchmarkView,
  type BundleInspector,
  type DecisionItem,
  type DecisionQueue,
  type DriftView,
  type PackList,
  type Workspace,
  zGroupRoutingDelta,
} from "../contract.js";
import {
  type DiscoveredPack,
  discoverBundles,
  discoverPacks,
  findBundle,
  type WorkspaceBundle,
} from "./workspace.js";

/**
 * The GET routes: pure projections of files on disk. Every number here is
 * computed by the library that owns it — counts by AIR state, budgets by
 * `capabilityDisclosureBudget`, the served surface by `planWorkflowSurface`,
 * drift by `diffContracts`, deficiencies by `buildRefinementPlan` — and every
 * call re-reads the bundle, so what the reviewer sees is what is on disk now.
 * Nothing in this module writes; the security contract's rule 6 is kept by
 * construction (no cache files, no report regeneration, no scratch directory).
 */

interface LoadedBundle extends WorkspaceBundle {
  air: AirDocument;
  files: Record<string, string>;
}

function loadBundle(bundle: WorkspaceBundle): LoadedBundle {
  const files = readBundleDir(bundle.dir);
  return { ...bundle, files, air: loadBundleAir(bundle.dir, files) };
}

function countBy<T extends string>(values: readonly T[]): Partial<Record<T, number>> {
  const counts: Partial<Record<T, number>> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

export function workspaceView(root: string): Workspace {
  return {
    root,
    bundles: discoverBundles(root).map((bundle) => {
      const { air, dir } = loadBundle(bundle);
      return {
        id: bundle.id,
        path: dir,
        service: { id: air.service.id, version: air.service.version },
        sourceKind: air.service.source.kind,
        ...(air.service.source.pathGrammar
          ? { pathGrammar: air.service.source.pathGrammar.classification }
          : {}),
        counts: {
          operations: countBy(air.operations.map((op) => op.state)),
          capabilities: countBy(air.capabilities.map((cap) => cap.lifecycle)),
          workflows: countBy(air.workflows.map((wf) => wf.state)),
        },
        hasBenchmark: existsSync(join(dir, "benchmark.report.json")),
        packs: discoverPacks(root, air.service.id).length,
      };
    }),
  };
}

function servedSurface(air: AirDocument) {
  const opsById = new Map(air.operations.map((op) => [op.id, op]));
  const approved = new Map<string, Operation>(
    [...opsById].filter(([, op]) => op.state === "approved"),
  );
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
  return { plan, before, after };
}

function planVerdict(plan: ReturnType<typeof servedSurface>["plan"], workflowId: string) {
  const skipReason = plan.registrations.find((r) => r.workflow.id === workflowId)?.skipReason;
  return {
    registrable: skipReason === undefined,
    ...(skipReason !== undefined ? { skipReason } : {}),
  };
}

export function bundleView(root: string, id: string): BundleInspector {
  const { air, dir } = loadBundle(findBundle(root, id));
  const { plan, before, after } = servedSurface(air);
  return {
    id,
    path: dir,
    service: air.service,
    source: air.service.source,
    ...(air.service.source.pathGrammar ? { pathGrammar: air.service.source.pathGrammar } : {}),
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
    workflows: air.workflows.map((wf) => ({
      id: wf.id,
      state: wf.state,
      steps: wf.steps,
      supersedes: wf.supersedes,
      plan: planVerdict(plan, wf.id),
      refusals: plan.refused.filter((r) => r.workflowId === wf.id),
    })),
    servedSurface: { before, after },
  };
}

/* ------------------------------- packs ------------------------------------ */

interface PackReceiptFile {
  path: string;
  refinementId: string;
}

/**
 * The receipt files under a pack's `receipts/`, sorted, each parsed only far
 * enough to know which refinement it binds. `readPackReceipts` (the library)
 * is what validates them; a file it would refuse is listed under no
 * refinement rather than hidden, and the list itself is what `applyPack`
 * loads by default.
 */
function receiptFiles(packDir: string): PackReceiptFile[] {
  const dir = join(packDir, "receipts");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .flatMap((name) => {
      const path = join(dir, name);
      try {
        const parsed = zRefinementReviewReceipt.safeParse(JSON.parse(readFileSync(path, "utf8")));
        return parsed.success ? [{ path, refinementId: parsed.data.refinementId }] : [];
      } catch {
        return [];
      }
    });
}

/** The measured routing delta beside a pack (`routing-delta.json`), when the import wrote one. */
function packDelta(dir: string) {
  const deltaPath = join(dir, "routing-delta.json");
  if (!existsSync(deltaPath)) return undefined;
  const parsed = zGroupRoutingDelta.safeParse(JSON.parse(readFileSync(deltaPath, "utf8")));
  return parsed.success ? parsed.data : undefined;
}

function packView(found: DiscoveredPack): PackList[number] {
  const { dir, pack, hash } = found;
  const delta = packDelta(dir);
  const receipts = receiptFiles(dir);
  return {
    dir,
    hash,
    service: pack.service,
    summary: pack.summary,
    items: pack.refinements.map((refinement) => ({
      refinementId: refinement.id,
      skill: refinement.skill,
      target: refinement.target,
      status: refinement.status,
      tier: refinement.approval.tier,
      patchSummary: patchSummary(refinement.proposal.set),
      claims: refinement.evidence,
      ...(delta !== undefined && refinement.target.kind === "group" ? { delta } : {}),
      receiptPaths: receipts.filter((r) => r.refinementId === refinement.id).map((r) => r.path),
    })),
    receipts: readPackReceipts(dir),
  };
}

function patchSummary(set: Record<string, unknown>): string {
  return Object.entries(set)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(" ");
}

export function packsView(root: string, id: string): PackList {
  const { air } = loadBundle(findBundle(root, id));
  return discoverPacks(root, air.service.id).map(packView);
}

/* ------------------------------- queue ------------------------------------ */

/**
 * The refinements in a pack that await a human's receipt: review tier, measured
 * clean (`improved` or `neutral`), and not yet decided — the same predicate
 * `createReviewReceipt` enforces, so an item here is one the decision route
 * will accept. A pack's auto-approved and regressed refinements are not
 * decisions; the pack list still shows them.
 */
function packDecisions(found: DiscoveredPack): DecisionItem[] {
  const decided = new Set(receiptFiles(found.dir).map((r) => r.refinementId));
  const delta = packDelta(found.dir);
  return found.pack.refinements
    .filter(
      (refinement) =>
        refinement.approval.tier === "review" &&
        (refinement.status === "improved" || refinement.status === "neutral") &&
        !decided.has(refinement.id),
    )
    .map((refinement) => ({
      kind: "pack" as const,
      id: refinement.id,
      title: `${refinement.skill} → ${describeTarget(refinement.target)}`,
      reasons: [
        refinement.approval.reason,
        `proposes ${patchSummary(refinement.proposal.set)}`,
        `pack ${found.hash.slice(0, 12)} at ${found.dir}`,
      ],
      evidence: refinement.evidence,
      suggestedAction: "approve or reject with a receipt (anvil refine approve|reject)",
      blocking: false,
      subject: {
        packHash: found.hash,
        refinementId: refinement.id,
        tier: refinement.approval.tier,
        ...(delta !== undefined && refinement.target.kind === "group" ? { delta } : {}),
      },
    }));
}

export function queueView(root: string, id: string): DecisionQueue {
  const { air, dir } = loadBundle(findBundle(root, id));
  const { plan } = servedSurface(air);
  const refinementPlan = buildRefinementPlan(air);
  const clusters = readBenchmarkReport(dir)?.confusion.clusters ?? [];
  const items: DecisionItem[] = [
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
    ...air.workflows.flatMap((wf) => {
      const verdict = planVerdict(plan, wf.id);
      const refusals = plan.refused.filter((r) => r.workflowId === wf.id);
      const reasons = [
        ...(verdict.skipReason !== undefined ? [verdict.skipReason] : []),
        ...refusals.map((r) => `${r.operationId}: ${r.reason}`),
      ];
      if (reasons.length === 0 && wf.state === "approved") return [];
      return [
        {
          kind: "workflow" as const,
          id: wf.id,
          title: wf.id,
          reasons: reasons.length > 0 ? reasons : [`workflow is ${wf.state}`],
          evidence: wf.evidence.claims,
          suggestedAction: "revise the workflow's steps or supersedes and recompile",
          blocking: false,
          subject: { workflowId: wf.id, plan: verdict },
        },
      ];
    }),
    ...refinementPlan.deficiencies.map((deficiency) => ({
      kind: "refinement" as const,
      id: `${deficiency.code}:${targetKey(deficiency.target)}`,
      title: deficiency.message,
      reasons: [deficiency.code],
      evidence: [],
      suggestedAction: deficiency.suggestedSkill,
      blocking: deficiency.severity === "blocking",
      subject: { deficiencyId: targetKey(deficiency.target), skill: deficiency.suggestedSkill },
    })),
    ...discoverPacks(root, air.service.id).flatMap(packDecisions),
    ...clusters.map((cluster) => ({
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
  ];
  return { bundleId: id, items };
}

/* ----------------------------- benchmark, drift --------------------------- */

export function benchmarkView(root: string, id: string): BenchmarkView {
  const { dir, files } = loadBundle(findBundle(root, id));
  const report = readBenchmarkReport(dir);
  if (!report) return null;
  return {
    router: report.router,
    catalogSize: report.catalogSize,
    bundleHash: report.bundleHash,
    fresh: report.bundleHash === bundleHash(files),
    summary: report.summary,
    confusion: report.confusion,
  };
}

export function driftView(root: string, id: string, against: string): DriftView {
  const { air } = loadBundle(findBundle(root, id));
  const other = loadBundle(findBundle(root, against)).air;
  return { bundleId: id, against, items: diffContracts(air, other) };
}
