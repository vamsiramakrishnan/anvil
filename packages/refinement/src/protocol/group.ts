import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AirDocument, Claim, Operation } from "@anvil/air";
import { planWorkflowSurface } from "@anvil/air";
import { z } from "zod";
import { BENCHMARK_REPORT_FILE } from "../benchmark/report.js";
import {
  benchmarkOperations,
  curatedCatalog,
  lexicalRouter,
  type RoutableTool,
} from "../benchmark/routing.js";
import { type Deficiency, makeDeficiency } from "../deficiency.js";
import {
  buildGroupWorkflow,
  type GroupCapabilityPayload,
  type GroupDisambiguationPayload,
  type GroupWorkflowPayload,
  groupGrantOf,
  resolveOperationReference,
  zGroupCapabilityPayload,
  zGroupDisambiguationPayload,
  zGroupWorkflowPayload,
} from "../skills/group-proposal.js";
import { HarnessProtocolError, type HarnessRejection } from "./errors.js";

/**
 * The GROUP bridge and the benchmark-scored admission gate — the two halves of
 * asking a coding harness about a whole confusable-tool cluster.
 *
 * ## Why the bridge is not a refinement detector
 *
 * Refinement's detectors are pure functions over `AirDocument` — that purity is
 * load-bearing (same document, same plan, everywhere). A confusion cluster is
 * not derivable from AIR: it is measured by the routing benchmark and recorded
 * in `benchmark.report.json`, a DERIVED record that may have been produced by
 * any router (including a real model via `--agent`). So the honest shape is a
 * deterministic bridge beside the protocol rails rather than a detector:
 * `anvil refine export-task <dir> group:<cluster-id>` reads the report next to
 * the bundle, resolves the cluster's members against current AIR, and
 * constructs the deficiency the ordinary export rails then hash-bind into a
 * portable task. Import needs no report at all — the task's own `taskHash`
 * carries the cluster and `sourceContractHash` pins the exact document the
 * benchmark measured.
 *
 * ## The admission gate (Task B)
 *
 * A validated group proposal is SCORED before it may reach review: the same
 * deterministic lexical router the benchmark uses re-routes the same intent
 * tasks over the current served catalog and over the hypothetical one the
 * proposal would produce — for a workflow, the catalog transformed by the
 * SHARED planner (`planWorkflowSurface`: members superseded, the composite
 * registered under its real served name and description); for a capability,
 * the catalog narrowed to the members. A NEGATIVE delta is refused with the
 * numbers; a non-negative delta attaches as evidence and the proposal still
 * lands at review — the measured uplift is information for the human, never an
 * approval (approval.ts pins both group patch keys to the review tier).
 */

/* ----------------------------- report reading ----------------------------- */

const zReportCluster = z
  .object({
    id: z.string().min(1),
    members: z.array(z.object({ operationId: z.string(), toolName: z.string() }).loose()).min(2),
    taskCount: z.number(),
    edges: z
      .array(
        z
          .object({
            intended: z.string(),
            routed: z.string(),
            count: z.number(),
            intents: z.array(z.string()),
          })
          .loose(),
      )
      .default([]),
    sharedTokens: z.array(z.string()).default([]),
  })
  .loose();

const zBenchmarkReportSlice = z
  .object({
    router: z.string().default("lexical"),
    catalogSize: z.number().default(0),
    confusion: z.object({ clusters: z.array(zReportCluster).default([]) }).loose(),
  })
  .loose();

const zTrafficReportSlice = z
  .object({
    groupings: z
      .array(
        z
          .object({
            id: z.string(),
            operationIds: z.array(z.string()),
            traces: z.number().optional(),
          })
          .loose(),
      )
      .default([]),
  })
  .loose();

/**
 * Read and minimally validate the benchmark report next to a bundle. This is
 * deliberately the SLICE the bridge needs (clusters, router, catalog size)
 * read leniently, not the full `parseBenchmarkReport`: a report an older or
 * foreign router wrote may still name a cluster worth exporting.
 */
function readBenchmarkReportSlice(bundleDir: string) {
  const path = join(bundleDir, BENCHMARK_REPORT_FILE);
  if (!existsSync(path)) {
    throw new Error(
      `No ${BENCHMARK_REPORT_FILE} in ${bundleDir}. Run \`anvil benchmark ${bundleDir}\` first — ` +
        "group tasks are exported from the benchmark's measured confusion clusters.",
    );
  }
  const parsed = zBenchmarkReportSlice.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) {
    throw new Error(
      `${path} does not carry the confusion analysis this bridge reads (schemaVersion 2 with ` +
        "confusion.clusters). Re-run `anvil benchmark` to regenerate it.",
    );
  }
  return parsed.data;
}

/* ------------------------------- the bridge ------------------------------- */

/** Full routing detail of one member, as the harness case file carries it. */
function memberFacts(op: Operation) {
  return {
    operationId: op.id,
    toolName: op.mcp.toolName,
    canonicalName: op.canonicalName,
    displayName: op.displayName,
    description: op.description,
    intentExamples: [...op.skill.intentExamples],
    params: [
      ...op.input.params.map((p) => ({
        name: p.name,
        in: p.in,
        required: p.required,
        type: typeof p.schema.type === "string" ? p.schema.type : undefined,
      })),
      ...(op.input.body?.projection === "fields"
        ? op.input.body.fields.map((f) => ({
            name: f.name,
            in: "body",
            required: f.required,
            type: typeof f.schema.type === "string" ? f.schema.type : undefined,
          }))
        : []),
    ],
  };
}

/**
 * Construct the group deficiency for one benchmark cluster, deterministically:
 * same report, same AIR, same traffic report in — same deficiency out. Members
 * are resolved against CURRENT AIR (a member the document no longer carries
 * means the report is stale, said out loud), the mis-routed intents ride
 * verbatim with counts, and the estate's traffic groupings — when an
 * observed-capability report is supplied — contribute both context and the
 * only expansion of the grant: `relatedOperationIds`, the operations traffic
 * observed alongside the cluster's members.
 */
export function clusterDeficiency(
  air: AirDocument,
  bundleDir: string,
  clusterId: string,
  trafficReportPath?: string,
): Deficiency {
  const report = readBenchmarkReportSlice(bundleDir);
  const cluster = report.confusion.clusters.find((candidate) => candidate.id === clusterId);
  if (!cluster) {
    const available = report.confusion.clusters.map((candidate) => candidate.id);
    throw new Error(
      `No confusion cluster '${clusterId}' in ${BENCHMARK_REPORT_FILE}. ` +
        (available.length > 0
          ? `Available clusters: ${available.join(", ")}.`
          : "The report carries no clusters — the benchmark found no confusable families at the evidence floor."),
    );
  }
  const members = cluster.members.map((member) => {
    const op = air.operations.find((candidate) => candidate.id === member.operationId);
    if (!op) {
      throw new Error(
        `Cluster '${clusterId}' names operation '${member.operationId}', which this document ` +
          "does not carry. The benchmark report is stale — re-run `anvil benchmark` and export again.",
      );
    }
    return op;
  });

  const memberIds = new Set(members.map((op) => op.id));
  let trafficGroupings: Array<{ id: string; operationIds: string[]; traces?: number }> = [];
  let relatedOperationIds: string[] = [];
  if (trafficReportPath) {
    const traffic = zTrafficReportSlice.safeParse(
      JSON.parse(readFileSync(trafficReportPath, "utf8")),
    );
    if (!traffic.success) {
      throw new Error(
        `${trafficReportPath} is not an observed-capability report ` +
          "(written by `anvil capability propose --from-records --out`).",
      );
    }
    // Only groupings that intersect the cluster inform this task; their other
    // members become the explicitly-listed related operations the grant admits.
    trafficGroupings = traffic.data.groupings
      .filter((grouping) => grouping.operationIds.some((id) => memberIds.has(id)))
      .map((grouping) => ({
        id: grouping.id,
        operationIds: [...grouping.operationIds],
        ...(grouping.traces !== undefined ? { traces: grouping.traces } : {}),
      }));
    relatedOperationIds = [
      ...new Set(
        trafficGroupings
          .flatMap((grouping) => grouping.operationIds)
          .filter((id) => !memberIds.has(id) && air.operations.some((op) => op.id === id)),
      ),
    ].sort();
  }

  const misrouted = cluster.edges.reduce((n, edge) => n + edge.count, 0);
  return makeDeficiency(
    "confusable_tool_cluster",
    { kind: "group", groupId: cluster.id },
    `${cluster.members.length} served tools eat each other's tasks (${misrouted} mis-routed): ` +
      cluster.members.map((member) => member.toolName).join(", "),
    {
      clusterId: cluster.id,
      router: report.router,
      catalogSize: report.catalogSize,
      members: members.map(memberFacts),
      misroutedEdges: cluster.edges.map((edge) => ({
        intended: edge.intended,
        routed: edge.routed,
        count: edge.count,
        intents: [...edge.intents],
      })),
      sharedTokens: [...cluster.sharedTokens],
      relatedOperationIds,
      trafficGroupings,
    },
  );
}

/* --------------------------- scored admission ----------------------------- */

interface RoutedTask {
  operationId: string;
  intent: string;
}

export interface GroupRoutingDelta {
  schemaVersion: 1;
  reportType: "anvil.group-routing-delta";
  clusterId: string;
  proposalKind: "workflow" | "capability" | "disambiguate";
  /**
   * Which tasks the paired comparison ran over. A workflow reshapes the whole
   * served surface, so ALL approved tasks are re-routed. A capability narrows
   * the catalog to its members — re-routing non-member tasks over a
   * member-only catalog would score every capability deeply negative for
   * removing tools it never touches — so the same member tasks are routed over
   * the full catalog (before) and the narrowed one (after): the measured value
   * of the narrowing for the tasks it serves.
   *
   * A disambiguation adds and removes no tools at all — it rewrites the served
   * text of members that are already there — so its effect is not confined to
   * the members: sharpened wording can just as easily stop eating a NON-member's
   * tasks, or start eating them. Scoring it over member tasks only would hide
   * the collateral, so it re-routes ALL tasks over the full catalog both times.
   */
  scope: "all_tasks" | "member_tasks";
  router: string;
  totalTasks: number;
  passedBefore: number;
  passedAfter: number;
  /** (after - before) / total, in points of task share. */
  upliftPts: number;
  flippedToPass: Array<{ operationId: string; intent: string }>;
  flippedToFail: Array<{ operationId: string; intent: string }>;
  hypothetical: {
    catalogSize: number;
    compositeTool?: string;
    supersededOperationIds: string[];
    /** For a disambiguation: whose served text the hypothetical surface rewrote. */
    rewrittenOperationIds?: string[];
  };
  /**
   * Honesty flag: the workflow chain's data flow was validated STRUCTURALLY
   * (bindings resolve against real output schemas on the shared planner);
   * nothing was executed against a mock. Never claim simulation that did not
   * happen.
   */
  simulated: false;
  simulationNote: string;
}

/** The rejection envelope a negative delta produces: the numbers, then the introduced mis-routes. */
function groupAdmissionRejection(delta: GroupRoutingDelta): HarnessRejection {
  return {
    code: "refinement/group_delta_regressed",
    stage: "admission",
    message:
      `this abstraction makes routing worse: ${delta.passedBefore}→${delta.passedAfter} of ` +
      `${delta.totalTasks} tasks routed correctly (${delta.upliftPts.toFixed(1)} pts). ` +
      `Refused before review. Mis-routes it introduces: ` +
      (delta.flippedToFail
        .slice(0, 5)
        .map((flip) => `"${flip.intent}"`)
        .join(", ") || "(none listed)"),
    issues: [
      `tasks routed correctly before: ${delta.passedBefore}/${delta.totalTasks}`,
      `tasks routed correctly after: ${delta.passedAfter}/${delta.totalTasks}`,
      `upliftPts: ${delta.upliftPts.toFixed(1)}`,
      ...delta.flippedToFail.map(
        (flip) => `now mis-routed: "${flip.intent}" (${flip.operationId})`,
      ),
    ],
  };
}

/**
 * A group proposal whose measured routing delta is negative. Refused, with the
 * numbers. It is a `HarnessProtocolError`, so every caller that already renders
 * a harness rejection envelope (the CLI's `--json`, a console) renders this one
 * the same way; the measured delta rides along for readers that want the numbers
 * structured rather than in prose.
 */
export class GroupAdmissionRefusal extends HarnessProtocolError {
  readonly delta: GroupRoutingDelta;
  constructor(delta: GroupRoutingDelta) {
    super(groupAdmissionRejection(delta));
    this.name = "GroupAdmissionRefusal";
    this.delta = delta;
  }
}

async function routeTasks(
  tasks: readonly RoutedTask[],
  catalog: readonly RoutableTool[],
  targetToolFor: (operationId: string) => string | undefined,
): Promise<boolean[]> {
  const router = lexicalRouter();
  const results: boolean[] = [];
  for (const task of tasks) {
    const routed = await router.route(task.intent, catalog);
    const target = targetToolFor(task.operationId);
    results.push(routed !== undefined && target !== undefined && routed === target);
  }
  return results;
}

/**
 * Score one validated group proposal: the same intent tasks, routed by the
 * benchmark's deterministic lexical router over the current served catalog and
 * over the hypothetical catalog the proposal would produce. Pure with respect
 * to its inputs — no report is read; the current side is recomputed live so a
 * stale report can never flatter a proposal.
 */
export async function scoreGroupProposal(
  air: AirDocument,
  deficiency: Pick<Deficiency, "facts" | "target">,
  patchSet: Record<string, unknown>,
): Promise<GroupRoutingDelta> {
  const clusterId = deficiency.target.kind === "group" ? deficiency.target.groupId : "unknown";
  const ops = benchmarkOperations(air);
  const current = curatedCatalog(ops);
  const currentToolByOp = new Map(current.map((tool) => [tool.operationId, tool.name]));

  const grant = groupGrantOf(deficiency.facts);
  const grantedIds = new Set([...grant.memberOperationIds, ...grant.relatedOperationIds]);
  const grantOps = ops.filter((op) => grantedIds.has(op.id));

  if ("workflow" in patchSet) {
    const payload: GroupWorkflowPayload = zGroupWorkflowPayload.parse(patchSet.workflow);
    const build = buildGroupWorkflow(payload, grantOps, air.service.id);
    if (!build.workflow) {
      // Validation runs before scoring, so this is a programming error, not a
      // user-facing path — but fail loudly rather than score a phantom.
      throw new Error(`group workflow did not build: ${build.issues.join("; ")}`);
    }
    const workflow = build.workflow;
    const opsById = new Map(ops.map((op) => [op.id, op]));
    const plan = planWorkflowSurface([workflow], opsById, opsById);
    const registration = plan.registrations[0];
    if (!registration || registration.skipReason !== undefined) {
      throw new Error(
        `the shared planner would not register this workflow: ${registration?.skipReason ?? "no verdict"}`,
      );
    }
    const superseded = new Set(
      [...plan.superseded.entries()]
        .filter(([, workflowId]) => workflowId === workflow.id)
        .map(([operationId]) => operationId),
    );
    // The composite exactly as `@anvil/mcp-runtime` would serve it: the
    // sanitized workflow id as the tool name, the workflow description (or the
    // server's fallback) as the description. The proposal's intent examples do
    // NOT enter the served description — scoring a surface the runtime would
    // not serve would be measuring a fiction.
    const compositeTool: RoutableTool = {
      name: workflow.id.replace(/[^A-Za-z0-9_-]/g, "_"),
      description:
        workflow.description ||
        `Composite workflow: ${workflow.steps.map((s) => s.operationId).join(" → ")}`,
      operationId: workflow.id,
    };
    const hypothetical = [
      ...current.filter((tool) => !superseded.has(tool.operationId)),
      compositeTool,
    ];

    const tasks: RoutedTask[] = ops.flatMap((op) =>
      op.skill.intentExamples.map((intent) => ({ operationId: op.id, intent })),
    );
    const before = await routeTasks(tasks, current, (id) => currentToolByOp.get(id));
    // On the hypothetical surface a superseded operation's tasks are correctly
    // answered by the composite that replaced it — that is what "stands in for
    // it" means — and every other task still targets its own tool.
    const after = await routeTasks(tasks, hypothetical, (id) =>
      superseded.has(id) ? compositeTool.name : currentToolByOp.get(id),
    );
    return assembleDelta(clusterId, "workflow", "all_tasks", tasks, before, after, {
      catalogSize: hypothetical.length,
      compositeTool: compositeTool.name,
      supersededOperationIds: [...superseded].sort(),
    });
  }

  if ("disambiguate" in patchSet) {
    const payload: GroupDisambiguationPayload = zGroupDisambiguationPayload.parse(
      patchSet.disambiguate,
    );
    // Rewrite the operations themselves and rebuild the catalog through the SAME
    // `curatedCatalog`/`mcpToolDescription` path the runtime serves from. Composing
    // the hypothetical description by hand here would measure a surface the server
    // does not serve — the safety and pagination sentences would go missing, and
    // those are part of what the router reads.
    const rewrittenById = new Map<string, { description: string; displayName?: string }>();
    for (const entry of payload.operations) {
      const op = resolveOperationReference(grantOps, entry.operation);
      if (!op) continue;
      rewrittenById.set(op.id, {
        description: entry.description,
        displayName: entry.display_name,
      });
    }
    const rewrittenOps = ops.map((op) => {
      const rewrite = rewrittenById.get(op.id);
      if (!rewrite) return op;
      return {
        ...op,
        description: rewrite.description,
        displayName: rewrite.displayName ?? op.displayName,
      };
    });
    const hypothetical = curatedCatalog(rewrittenOps);
    // The tool NAME is `op.mcp.toolName`, which a disambiguation does not touch,
    // so each task's target tool is the same on both surfaces: this is a pure
    // measurement of whether the new wording routes better.
    const tasks: RoutedTask[] = ops.flatMap((op) =>
      op.skill.intentExamples.map((intent) => ({ operationId: op.id, intent })),
    );
    const before = await routeTasks(tasks, current, (id) => currentToolByOp.get(id));
    const after = await routeTasks(tasks, hypothetical, (id) => currentToolByOp.get(id));
    return assembleDelta(clusterId, "disambiguate", "all_tasks", tasks, before, after, {
      catalogSize: hypothetical.length,
      supersededOperationIds: [],
      rewrittenOperationIds: [...rewrittenById.keys()].sort(),
    });
  }

  const payload: GroupCapabilityPayload = zGroupCapabilityPayload.parse(patchSet.capability);
  const memberOps = payload.operations
    .map((reference) => resolveOperationReference(grantOps, reference))
    .filter((op): op is Operation => op !== undefined);
  const memberIds = new Set(memberOps.map((op) => op.id));
  const memberCatalog = current.filter((tool) => memberIds.has(tool.operationId));
  const tasks: RoutedTask[] = memberOps.flatMap((op) =>
    op.skill.intentExamples.map((intent) => ({ operationId: op.id, intent })),
  );
  const before = await routeTasks(tasks, current, (id) => currentToolByOp.get(id));
  const after = await routeTasks(tasks, memberCatalog, (id) => currentToolByOp.get(id));
  return assembleDelta(clusterId, "capability", "member_tasks", tasks, before, after, {
    catalogSize: memberCatalog.length,
    supersededOperationIds: [],
  });
}

function assembleDelta(
  clusterId: string,
  proposalKind: GroupRoutingDelta["proposalKind"],
  scope: "all_tasks" | "member_tasks",
  tasks: readonly RoutedTask[],
  before: readonly boolean[],
  after: readonly boolean[],
  hypothetical: GroupRoutingDelta["hypothetical"],
): GroupRoutingDelta {
  const passedBefore = before.filter(Boolean).length;
  const passedAfter = after.filter(Boolean).length;
  const flippedToPass = tasks.filter((_, i) => !before[i] && after[i]);
  const flippedToFail = tasks.filter((_, i) => before[i] && !after[i]);
  return {
    schemaVersion: 1,
    reportType: "anvil.group-routing-delta",
    clusterId,
    proposalKind,
    scope,
    router: "lexical",
    totalTasks: tasks.length,
    passedBefore,
    passedAfter,
    upliftPts:
      tasks.length > 0 ? Math.round(((passedAfter - passedBefore) / tasks.length) * 1000) / 10 : 0,
    flippedToPass: flippedToPass.map((task) => ({ ...task })),
    flippedToFail: flippedToFail.map((task) => ({ ...task })),
    hypothetical,
    simulated: false,
    simulationNote:
      "Data flow validated structurally (bindings resolve against real output schemas on the " +
      "shared surface planner); the chain was NOT executed against a mock.",
  };
}

/**
 * The admission rule, stated honestly: a NEGATIVE delta is refused with the
 * numbers before a reviewer ever sees the proposal; zero is not refusal —
 * routing is one dimension, and a human may still want the composition for
 * safety or ergonomics — but the evidence must say it bought nothing. This is
 * the line the mutation gate arms (`benchmark-admission/negative-delta-refused`).
 */
export function admitOrRefuse(delta: GroupRoutingDelta): GroupRoutingDelta {
  if (delta.passedAfter < delta.passedBefore) {
    throw new GroupAdmissionRefusal(delta);
  }
  return delta;
}

/** The measured delta as a claim, attached to the refinement as reviewer evidence. */
export function groupDeltaClaim(delta: GroupRoutingDelta): Claim {
  const bought =
    delta.passedAfter === delta.passedBefore
      ? "routing unchanged — the composition bought nothing on this dimension; " +
        "a reviewer may still want it for safety or ergonomics"
      : `routing improved ${delta.passedBefore}→${delta.passedAfter} of ${delta.totalTasks}`;
  return {
    subject: delta.clusterId,
    predicate: "group.routing_delta",
    value: {
      scope: delta.scope,
      totalTasks: delta.totalTasks,
      passedBefore: delta.passedBefore,
      passedAfter: delta.passedAfter,
      upliftPts: delta.upliftPts,
      flippedToPass: delta.flippedToPass.length,
      flippedToFail: delta.flippedToFail.length,
      simulated: delta.simulated,
    },
    source: "inferred",
    sourceRef: "anvil-benchmark-admission",
    method: "routing_benchmark",
    confidence: 1,
    note: `Deterministic lexical re-route of the same intent tasks, current vs hypothetical surface: ${bought}. ${delta.simulationNote}`,
    review: "accepted",
  };
}
