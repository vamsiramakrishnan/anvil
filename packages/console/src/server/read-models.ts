import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type AirDocument, type Operation, planWorkflowSurface } from "@anvil/air";
import { capabilityDisclosureBudget, diffContracts } from "@anvil/compiler";
import { bundleHash, loadBundleAir, readBundleDir } from "@anvil/generators";
import { buildRefinementPlan, readBenchmarkReport, readPackReceipts } from "@anvil/refinement";
import {
  type BenchmarkView,
  type BundleInspector,
  type DecisionQueue,
  type DriftView,
  type PackList,
  type Workspace,
  zGroupRoutingDelta,
} from "../contract.js";
import { discoverBundles, discoverPacks, findBundle, type WorkspaceBundle } from "./workspace.js";

/**
 * The GET routes: pure projections of files on disk. Every number here is
 * computed by the library that owns it — counts by AIR state, budgets by
 * `capabilityDisclosureBudget`, the served surface by `planWorkflowSurface`,
 * drift by `diffContracts`, deficiencies by `buildRefinementPlan` — and every
 * call re-reads the bundle, so what the reviewer sees is what is on disk now.
 * Nothing in this module writes; the security contract's rule 6 is kept by
 * construction (no cache files, no report regeneration).
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
    workflows: air.workflows.map((wf) => {
      const registration = plan.registrations.find((r) => r.workflow.id === wf.id);
      const skipReason = registration?.skipReason;
      return {
        id: wf.id,
        state: wf.state,
        steps: wf.steps,
        supersedes: wf.supersedes,
        plan: {
          registrable: skipReason === undefined,
          ...(skipReason !== undefined ? { skipReason } : {}),
        },
        refusals: plan.refused.filter((r) => r.workflowId === wf.id),
      };
    }),
    servedSurface: { before, after },
  };
}

export function queueView(root: string, id: string): DecisionQueue {
  const { air } = loadBundle(findBundle(root, id));
  const { plan } = servedSurface(air);
  const refinementPlan = buildRefinementPlan(air);
  return {
    bundleId: id,
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
        })),
      ...air.workflows.flatMap((wf) => {
        const registration = plan.registrations.find((r) => r.workflow.id === wf.id);
        const refusals = plan.refused.filter((r) => r.workflowId === wf.id);
        const reasons = [
          ...(registration?.skipReason !== undefined ? [registration.skipReason] : []),
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
          },
        ];
      }),
      ...refinementPlan.deficiencies.map((deficiency) => ({
        kind: "refinement" as const,
        id: `${deficiency.code}:${JSON.stringify(deficiency.target)}`,
        title: deficiency.message,
        reasons: [deficiency.code],
        evidence: [],
        suggestedAction: deficiency.suggestedSkill,
        blocking: deficiency.severity === "blocking",
      })),
    ],
  };
}

export function packsView(root: string, id: string): PackList {
  const { air } = loadBundle(findBundle(root, id));
  return discoverPacks(root, air.service.id).map(({ dir, pack, hash }) => {
    const deltaPath = join(dir, "routing-delta.json");
    const delta = existsSync(deltaPath)
      ? zGroupRoutingDelta.safeParse(JSON.parse(readFileSync(deltaPath, "utf8")))
      : undefined;
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
        patchSummary: Object.entries(refinement.proposal.set)
          .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
          .join(" "),
        claims: refinement.evidence,
        ...(delta?.success && refinement.target.kind === "group" ? { delta: delta.data } : {}),
      })),
      receipts: readPackReceipts(dir),
    };
  });
}

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
