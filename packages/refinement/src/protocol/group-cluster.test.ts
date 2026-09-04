import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AirDocument,
  loadAirDocument,
  mcpToolDescription,
  planWorkflowSurface,
} from "@anvil/air";
import { describe, expect, it } from "vitest";
import { applyPatch } from "../apply.js";
import { classifyApproval } from "../approval.js";
import { makeDeficiency } from "../deficiency.js";
import { applyReviewed, createReviewReceipt } from "../pack.js";
import type { GroupDisambiguationPayload, GroupWorkflowPayload } from "../skills/group-proposal.js";
import { HarnessProtocolError } from "./errors.js";
import { admitOrRefuse, GroupAdmissionRefusal, scoreGroupProposal } from "./group.js";
import { importHarnessSubmission } from "./import.js";
import { resolveRepositoryRevision } from "./repository.js";
import type { HarnessSubmission, RefinementTask } from "./schema.js";
import { createRefinementTask } from "./task.js";

/**
 * The GROUP rails end to end: a benchmark-measured confusable cluster becomes
 * one hash-bound task, a coding harness answers with a bounded proposal union
 * (workflow XOR capability XOR honest decline), and the import re-validates the
 * answer deterministically — landing every valid proposal at REVIEW tier and
 * refusing, by name, a reference outside the grant, a supersedes outside the
 * proposal's own steps, an unthreaded binding, and an ungrounded name. The
 * estate is shaped like the Zendesk views family the routing benchmark
 * measured (list/execute/count eating each other's tasks).
 */

const CLUSTER_ID = "cc_0123456789ab";

function viewsEstate(): AirDocument {
  const read = {
    effectKind: "read" as const,
    idempotency: { mode: "natural" as const },
    retries: { mode: "safe" as const },
    confirmation: { required: false },
    auth: { type: "api_key" as const },
    errors: [],
    evidence: { claims: [] },
    state: "approved" as const,
  };
  const { effectKind: _unused, ...common } = read;
  void _unused;
  return loadAirDocument({
    service: { id: "svc", displayName: "Service", version: "1", source: { kind: "openapi" } },
    operations: [
      {
        ...common,
        id: "svc.views.list",
        canonicalName: "list_views",
        displayName: "List views",
        description: "List all views.",
        sourceRef: { kind: "openapi", path: "/views", method: "get" },
        effect: { kind: "read", action: "list", resource: "view" },
        input: { params: [] },
        output: {
          schema: {
            type: "array",
            items: {
              type: "object",
              properties: { view_id: { type: "string" }, title: { type: "string" } },
            },
          },
        },
        cli: { command: "svc views list" },
        mcp: { toolName: "svc_list_views" },
        skill: { intentExamples: ["show all views", "execute the view list"] },
      },
      {
        ...common,
        id: "svc.views.execute",
        canonicalName: "execute_view",
        displayName: "Execute view",
        description: "Execute a view and return its rows.",
        sourceRef: { kind: "openapi", path: "/views/{view_id}/execute", method: "get" },
        effect: { kind: "read", action: "get", resource: "view" },
        input: { params: [{ name: "view_id", in: "path", required: true }] },
        cli: { command: "svc views execute" },
        mcp: { toolName: "svc_execute_view" },
        skill: { intentExamples: ["execute the view", "run the view rows"] },
      },
      {
        ...common,
        id: "svc.views.count",
        canonicalName: "count_view",
        displayName: "Count view tickets",
        description: "Count tickets in a view.",
        sourceRef: { kind: "openapi", path: "/views/{view_id}/count", method: "get" },
        effect: { kind: "read", action: "get", resource: "view" },
        input: { params: [{ name: "view_id", in: "path", required: true }] },
        cli: { command: "svc views count" },
        mcp: { toolName: "svc_count_view" },
        skill: { intentExamples: ["count tickets in the view"] },
      },
      // In the estate, NOT in the cluster's grant — the out-of-grant refusal.
      {
        ...common,
        id: "svc.tickets.get",
        canonicalName: "get_ticket",
        displayName: "Get ticket",
        description: "Get one ticket.",
        sourceRef: { kind: "openapi", path: "/tickets/{ticket_id}", method: "get" },
        effect: { kind: "read", action: "get", resource: "ticket" },
        input: { params: [{ name: "ticket_id", in: "path", required: true }] },
        cli: { command: "svc tickets get" },
        mcp: { toolName: "svc_get_ticket" },
        skill: { intentExamples: ["get a ticket"] },
      },
    ],
  });
}

/** The deficiency exactly as the CLI bridge constructs it from the report. */
function clusterDeficiencyFixture(air: AirDocument) {
  const memberIds = ["svc.views.list", "svc.views.execute", "svc.views.count"];
  const members = memberIds.map((id) => {
    const op = air.operations.find((candidate) => candidate.id === id);
    if (!op) throw new Error(`fixture is missing ${id}`);
    return {
      operationId: op.id,
      toolName: op.mcp.toolName,
      canonicalName: op.canonicalName,
      displayName: op.displayName,
      description: op.description,
      intentExamples: [...op.skill.intentExamples],
      params: op.input.params.map((p) => ({ name: p.name, in: p.in, required: p.required })),
    };
  });
  return makeDeficiency(
    "confusable_tool_cluster",
    { kind: "group", groupId: CLUSTER_ID },
    "3 served tools eat each other's tasks (6 mis-routed): svc_list_views, svc_execute_view, svc_count_view",
    {
      clusterId: CLUSTER_ID,
      router: "lexical",
      catalogSize: 4,
      members,
      misroutedEdges: [
        {
          intended: "svc_list_views",
          routed: "svc_execute_view",
          count: 1,
          intents: ["execute the view list"],
        },
        {
          intended: "svc_execute_view",
          routed: "svc_count_view",
          count: 1,
          intents: ["run the view rows"],
        },
      ],
      sharedTokens: ["view"],
      relatedOperationIds: [],
      trafficGroupings: [],
    },
  );
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "anvil-group-cluster-"));
  mkdirSync(join(root, "docs"));
  writeFileSync(
    join(root, "docs", "views.md"),
    "Users list views, then execute the chosen view to see its rows.\n",
  );
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "anvil@example.test"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Anvil Test"], { cwd: root });
  execFileSync("git", ["add", "docs/views.md"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
  return root;
}

function taskFor(air: AirDocument, root: string): RefinementTask {
  return createRefinementTask(air, clusterDeficiencyFixture(air), {
    repositoryRoot: root,
    repositoryRevision: resolveRepositoryRevision(root),
    inspectScopes: ["docs"],
  });
}

const WORKFLOW_PAYLOAD: GroupWorkflowPayload = {
  name: "list_and_execute_view",
  description: "List views and execute the chosen view.",
  intent_examples: ["execute a view from the list"],
  steps: [
    { operation: "svc.views.list" },
    { operation: "svc.views.execute", bindings: { view_id: "$.output.view_id" } },
  ],
  supersedes: ["svc.views.execute", "svc.views.list"],
};

const CAPABILITY_PAYLOAD = {
  id: "views",
  display_name: "Views",
  description: "List, execute, and count views.",
  intent_examples: ["work with the views"],
  operations: ["svc.views.list", "svc.views.execute", "svc.views.count"],
};

function submission(
  task: RefinementTask,
  set: Record<string, unknown>,
  predicate: string,
  value: unknown,
): HarnessSubmission {
  return {
    schemaVersion: 1,
    taskId: task.taskId,
    taskHash: task.taskHash,
    executor: { name: "claude-code", version: "1" },
    status: "proposal_generated",
    summary: "The docs describe list-then-execute as one task.",
    evidence: [{ id: "doc", kind: "repository", source: "doc_example", path: "docs/views.md" }],
    claims: [{ predicate, value: value as never, evidenceId: "doc" }],
    patch: { set: set as never },
  } as HarnessSubmission;
}

function importRejection(
  air: AirDocument,
  task: RefinementTask,
  sub: HarnessSubmission,
  root: string,
): HarnessProtocolError {
  try {
    importHarnessSubmission(air, task, sub, { repositoryRoot: root });
  } catch (error) {
    if (error instanceof HarnessProtocolError) return error;
    throw error;
  }
  throw new Error("expected the submission to be refused");
}

describe("group task export", () => {
  it("hash-binds the cluster's members, mis-routed intents, and grant into the task", () => {
    const air = viewsEstate();
    const task = taskFor(air, repository());
    expect(task.skill.name).toBe("resolve-confusable-cluster");
    expect(task.deficiency.target).toEqual({ kind: "group", groupId: CLUSTER_ID });
    const facts = task.deficiency.facts as Record<string, unknown>;
    const members = facts.members as Array<Record<string, unknown>>;
    expect(members.map((m) => m.operationId)).toEqual([
      "svc.views.list",
      "svc.views.execute",
      "svc.views.count",
    ]);
    // Full routing detail rides with each member.
    expect(members[0]?.toolName).toBe("svc_list_views");
    expect(members[0]?.intentExamples).toEqual(["show all views", "execute the view list"]);
    expect(members[1]?.params).toEqual([{ name: "view_id", in: "path", required: true }]);
    // The mis-routed intents, verbatim, with counts.
    const edges = facts.misroutedEdges as Array<Record<string, unknown>>;
    expect(edges[0]?.intents).toEqual(["execute the view list"]);
    expect(task.policy.writableFields).toEqual(["workflow", "capability", "disambiguate"]);
    expect(JSON.stringify(task.expectedSubmission)).toContain("workflow");
  });
});

describe("group proposal approval tier", () => {
  it("pins BOTH proposal kinds to review on the patch key, at any evidence strength", () => {
    const sets: Array<Record<string, never>> = [
      { workflow: WORKFLOW_PAYLOAD as never },
      { capability: CAPABILITY_PAYLOAD as never },
    ];
    for (const set of sets) {
      const decision = classifyApproval({
        skill: "resolve-confusable-cluster",
        proposal: {
          skill: "resolve-confusable-cluster",
          skillVersion: 1,
          deficiency: "confusable_tool_cluster",
          target: { kind: "group", groupId: CLUSTER_ID },
          claims: [
            {
              subject: CLUSTER_ID,
              predicate: "group.workflow",
              value: true,
              source: "recorded_traffic",
              sourceRef: "spool",
              confidence: 0.99,
            },
          ],
          patch: { target: { kind: "group", groupId: CLUSTER_ID }, set },
        },
        evidence: [
          {
            subject: CLUSTER_ID,
            predicate: "group.workflow",
            value: true,
            source: "recorded_traffic",
            sourceRef: "spool",
            confidence: 0.99,
          },
        ],
      });
      // The TIER alone does not pin this control: rule 5's default is review
      // too, so a test that only reads the tier passes with the group guard
      // deleted. The reason is what says the FIELD was recognised.
      expect(decision.tier).toBe("review");
      expect(decision.reason).toContain("served tool surface");
    }
  });
});

describe("group workflow proposal → import → review → apply", () => {
  it("lands a valid composed workflow at REVIEW tier with its evidence", () => {
    const air = viewsEstate();
    const root = repository();
    const task = taskFor(air, root);
    const pack = importHarnessSubmission(
      air,
      task,
      submission(task, { workflow: WORKFLOW_PAYLOAD }, "group.workflow", WORKFLOW_PAYLOAD),
      { repositoryRoot: root },
    );
    expect(pack.refinements).toHaveLength(1);
    const refinement = pack.refinements[0]!;
    expect(refinement.approval.tier).toBe("review");
    expect(refinement.status).not.toBe("approved");
    expect(pack.summary.approved).toBe(0);
    expect(refinement.validation.every((outcome) => outcome.ok)).toBe(true);
  });

  it("apply-after-receipt lands the workflow and the shared planner SHRINKS the surface", () => {
    const air = viewsEstate();
    const root = repository();
    const task = taskFor(air, root);
    const pack = importHarnessSubmission(
      air,
      task,
      submission(task, { workflow: WORKFLOW_PAYLOAD }, "group.workflow", WORKFLOW_PAYLOAD),
      { repositoryRoot: root },
    );
    const refinement = pack.refinements[0]!;
    const receipt = createReviewReceipt(
      pack,
      refinement.id,
      "approved",
      "reviewer@example.test",
      "composes cleanly; routing delta attached",
    );
    const { air: next, applied } = applyReviewed(air, pack, [receipt]);
    expect(applied).toHaveLength(1);
    expect(next.workflows).toHaveLength(1);
    const workflow = next.workflows[0]!;
    expect(workflow.id).toBe("svc.list_and_execute_view");
    expect(workflow.supersedes?.sort()).toEqual(["svc.views.execute", "svc.views.list"]);
    // The receipt-approved workflow registers and its supersessions apply:
    // 4 operations − 2 superseded + 1 composite = the shrink the loop buys.
    const opsById = new Map(next.operations.map((op) => [op.id, op]));
    const plan = planWorkflowSurface(next.workflows, opsById, opsById);
    expect(plan.registrations[0]?.skipReason).toBeUndefined();
    expect([...plan.superseded.keys()].sort()).toEqual(["svc.views.execute", "svc.views.list"]);
    const served = next.operations.filter((op) => !plan.superseded.has(op.id)).length + 1;
    expect(served).toBe(3);
  });

  it("apply of a capability proposal lands it born PROPOSED — declaration, not approval", () => {
    const air = viewsEstate();
    const root = repository();
    const task = taskFor(air, root);
    const pack = importHarnessSubmission(
      air,
      task,
      submission(task, { capability: CAPABILITY_PAYLOAD }, "group.capability", CAPABILITY_PAYLOAD),
      { repositoryRoot: root },
    );
    const refinement = pack.refinements[0]!;
    expect(refinement.approval.tier).toBe("review");
    const receipt = createReviewReceipt(
      pack,
      refinement.id,
      "approved",
      "reviewer@example.test",
      "grouping matches observed use",
    );
    const { air: next } = applyReviewed(air, pack, [receipt]);
    const capability = next.capabilities.find((c) => c.id === "views");
    expect(capability).toBeDefined();
    expect(capability?.lifecycle).toBe("proposed");
    expect(capability?.source).toBe("manifest");
    expect(capability?.operationIds).toEqual([
      "svc.views.count",
      "svc.views.execute",
      "svc.views.list",
    ]);
  });
});

describe("group proposal refusals — deterministic, by name", () => {
  it("REFUSES a workflow step naming an operation outside the task's grant", () => {
    const air = viewsEstate();
    const root = repository();
    const task = taskFor(air, root);
    const payload = {
      ...WORKFLOW_PAYLOAD,
      steps: [
        { operation: "svc.tickets.get" },
        { operation: "svc.views.execute", bindings: { view_id: "$.output.view_id" } },
      ],
      supersedes: ["svc.views.execute"],
    };
    const rejection = importRejection(
      air,
      task,
      submission(task, { workflow: payload }, "group.workflow", payload),
      root,
    );
    expect(rejection.rejection.code).toBe("refinement/proposal_rejected");
    expect(rejection.rejection.issues.join(" ")).toContain("group_grant_respected");
    expect(rejection.rejection.issues.join(" ")).toContain("svc.tickets.get");
  });

  it("REFUSES supersedes naming a granted member that is not one of the proposal's own steps", () => {
    const air = viewsEstate();
    const root = repository();
    const task = taskFor(air, root);
    const payload = { ...WORKFLOW_PAYLOAD, supersedes: ["svc.views.count"] };
    const rejection = importRejection(
      air,
      task,
      submission(task, { workflow: payload }, "group.workflow", payload),
      root,
    );
    expect(rejection.rejection.code).toBe("refinement/proposal_rejected");
    // The named check owns this rule (armed as mutation
    // refinement/group-supersedes-outside-steps-refused); the AIR schema's own
    // refinement is defense in depth behind it.
    expect(rejection.rejection.issues.join(" ")).toContain("group_supersedes_within_steps");
    expect(rejection.rejection.issues.join(" ")).toContain("svc.views.count");
  });

  it("REFUSES a binding whose field the previous step does not output", () => {
    const air = viewsEstate();
    const root = repository();
    const task = taskFor(air, root);
    const payload = {
      ...WORKFLOW_PAYLOAD,
      steps: [
        { operation: "svc.views.list" },
        { operation: "svc.views.execute", bindings: { view_id: "$.output.nonexistent" } },
      ],
      supersedes: ["svc.views.execute"],
    };
    const rejection = importRejection(
      air,
      task,
      submission(task, { workflow: payload }, "group.workflow", payload),
      root,
    );
    expect(rejection.rejection.issues.join(" ")).toContain("group_workflow_composes");
    expect(rejection.rejection.issues.join(" ")).toContain("nonexistent");
  });

  it("REFUSES a name the members' own vocabulary never states", () => {
    const air = viewsEstate();
    const root = repository();
    const task = taskFor(air, root);
    const payload = { ...WORKFLOW_PAYLOAD, name: "gizmo_flow" };
    const rejection = importRejection(
      air,
      task,
      submission(task, { workflow: payload }, "group.workflow", payload),
      root,
    );
    expect(rejection.rejection.issues.join(" ")).toContain("group_names_grounded");
    expect(rejection.rejection.issues.join(" ")).toContain("gizmo");
  });

  it("REFUSES a patch carrying both arms of the union", () => {
    const air = viewsEstate();
    const root = repository();
    const task = taskFor(air, root);
    const set = { workflow: WORKFLOW_PAYLOAD, capability: CAPABILITY_PAYLOAD };
    const rejection = importRejection(
      air,
      task,
      submission(task, set, "group.workflow", WORKFLOW_PAYLOAD),
      root,
    );
    expect(rejection.rejection.issues.join(" ")).toContain("group_proposal_shape");
  });

  it("accepts the honest decline: no patch, a reason, nothing lands", () => {
    const air = viewsEstate();
    const root = repository();
    const task = taskFor(air, root);
    const decline: HarnessSubmission = {
      schemaVersion: 1,
      taskId: task.taskId,
      taskHash: task.taskHash,
      executor: { name: "claude-code", version: "1" },
      status: "insufficient_evidence",
      summary:
        "The members are true alternatives, not one task; neither composition nor grouping is grounded.",
      evidence: [],
      claims: [],
    };
    const pack = importHarnessSubmission(air, task, decline, { repositoryRoot: root });
    expect(pack.refinements).toHaveLength(0);
    expect(pack.summary.skipped).toBe(1);
  });
});

/**
 * The DISAMBIGUATION arm: the third answer, and the one the measurements say a
 * cluster usually needs. The members are real and distinct; what collides is
 * their served text. This suite holds the two things that make the arm
 * trustworthy — the deterministic distinctness rule, which refuses a reword
 * that could not change a router's pick, and the scored admission, which
 * re-routes every task over a catalog rebuilt through the same
 * `curatedCatalog`/`mcpToolDescription` path the runtime serves from.
 */

/** Each member says something the others cannot: what it returns, and on what. */
const DISAMBIGUATION_PAYLOAD: GroupDisambiguationPayload = {
  operations: [
    {
      operation: "svc.views.list",
      description:
        "List every view available, returning each view's title and id. This does not execute a view or read any tickets.",
      rationale: "Only this member enumerates views; the others act on one view already chosen.",
    },
    {
      operation: "svc.views.execute",
      description: "Execute one view by view_id and return the ticket rows it matches, row by row.",
      rationale: "Only this member returns the rows themselves.",
    },
    {
      operation: "svc.views.count",
      description:
        "Count how many tickets one view by view_id matches, returning only the number and not the tickets.",
      rationale: "Only this member returns a count instead of the content.",
    },
  ],
};

describe("group disambiguation proposal", () => {
  it("pins the disambiguate key to review, at any evidence strength", () => {
    const decision = classifyApproval({
      skill: "resolve-confusable-cluster",
      proposal: {
        skill: "resolve-confusable-cluster",
        skillVersion: 1,
        deficiency: "confusable_tool_cluster",
        target: { kind: "group", groupId: CLUSTER_ID },
        claims: [],
        patch: {
          target: { kind: "group", groupId: CLUSTER_ID },
          set: { disambiguate: DISAMBIGUATION_PAYLOAD as never },
        },
      },
      evidence: [
        {
          subject: CLUSTER_ID,
          predicate: "group.disambiguate",
          value: true,
          source: "source_impl",
          sourceRef: "src/views.rb",
          confidence: 0.99,
        },
      ],
    });
    expect(decision.tier).toBe("review");
    // Pinned on the reason, not just the tier: rule 5 defaults to review as
    // well, so only the reason distinguishes "the guard recognised this field"
    // from "nothing matched and a human gets it anyway".
    expect(decision.reason).toContain("rewording the served tool surface");
  });

  it("lands at REVIEW tier, then rewrites the served text WITHOUT changing the catalog", () => {
    const air = viewsEstate();
    const root = repository();
    const task = taskFor(air, root);
    const pack = importHarnessSubmission(
      air,
      task,
      submission(
        task,
        { disambiguate: DISAMBIGUATION_PAYLOAD },
        "group.disambiguate",
        DISAMBIGUATION_PAYLOAD,
      ),
      { repositoryRoot: root },
    );
    const refinement = pack.refinements[0]!;
    expect(refinement.validation.every((outcome) => outcome.ok)).toBe(true);
    expect(refinement.approval.tier).toBe("review");

    const receipt = createReviewReceipt(
      pack,
      refinement.id,
      "approved",
      "reviewer@example.test",
      "the distinctions are the ones the source states",
    );
    const { air: next } = applyReviewed(air, pack, [receipt]);

    // Nothing was added or removed: this arm changes what tools SAY, not which
    // tools exist — the whole point of offering it beside workflow/capability.
    expect(next.operations).toHaveLength(air.operations.length);
    expect(next.workflows).toHaveLength(0);
    expect(next.capabilities).toEqual(air.capabilities);

    const byId = new Map(next.operations.map((op) => [op.id, op]));
    for (const entry of DISAMBIGUATION_PAYLOAD.operations) {
      const op = byId.get(entry.operation)!;
      expect(op.description).toBe(entry.description);
      // The served description is what the router reads, so assert the real
      // composition — not just the field.
      expect(mcpToolDescription(op)).toContain(entry.description);
      expect(op.evidence.claims.some((c) => c.note?.includes(entry.rationale))).toBe(true);
    }

    // Intent examples are the task set the delta was measured against. If an
    // apply could move them, every measurement in this loop would be circular.
    for (const op of next.operations) {
      const before = air.operations.find((candidate) => candidate.id === op.id)!;
      expect(op.skill.intentExamples).toEqual(before.skill.intentExamples);
    }
  });

  it("REFUSES a rewrite that shares every content word with its siblings", () => {
    const air = viewsEstate();
    const root = repository();
    const task = taskFor(air, root);
    const payload: GroupDisambiguationPayload = {
      operations: [
        {
          operation: "svc.views.list",
          description: "Work with the view tickets.",
          rationale: "clearer",
        },
        {
          operation: "svc.views.execute",
          description: "Work with the view tickets.",
          rationale: "clearer",
        },
      ],
    };
    const rejection = importRejection(
      air,
      task,
      submission(task, { disambiguate: payload }, "group.disambiguate", payload),
      root,
    );
    expect(rejection.rejection.issues.join(" ")).toContain("group_disambiguation_distinguishes");
    expect(rejection.rejection.issues.join(" ")).toContain(
      "would not change which tool a router picks",
    );
  });

  it("REFUSES disambiguating a single operation — it is distinguished from nothing", () => {
    const air = viewsEstate();
    const root = repository();
    const task = taskFor(air, root);
    const payload = {
      operations: [
        {
          operation: "svc.views.list",
          description: "List every view, returning titles and ids.",
          rationale: "clearer",
        },
      ],
    };
    const rejection = importRejection(
      air,
      task,
      submission(task, { disambiguate: payload }, "group.disambiguate", payload),
      root,
    );
    expect(rejection.rejection.issues.join(" ")).toContain("group_proposal_shape");
  });

  it("REFUSES a member outside the task's grant", () => {
    const air = viewsEstate();
    const root = repository();
    const task = taskFor(air, root);
    const payload: GroupDisambiguationPayload = {
      operations: [
        {
          operation: "svc.views.list",
          description: "List every view, returning each title and id.",
          rationale: "enumerates",
        },
        {
          operation: "svc.tickets.get",
          description: "Read one ticket by its own id, not through a view.",
          rationale: "different resource",
        },
      ],
    };
    const rejection = importRejection(
      air,
      task,
      submission(task, { disambiguate: payload }, "group.disambiguate", payload),
      root,
    );
    expect(rejection.rejection.issues.join(" ")).toContain("group_grant_respected");
  });

  it("applies ALL member rewrites or none — a half-disambiguated catalog is not what was approved", () => {
    const air = viewsEstate();
    // The second reference resolves against nothing. Validation would have
    // caught it upstream; this pins the apply path's own guard, because a
    // partial write leaves some members moved apart and the rest not.
    const { air: next, changes } = applyPatch(air, {
      target: { kind: "group", groupId: CLUSTER_ID },
      set: {
        disambiguate: {
          operations: [
            {
              operation: "svc.views.list",
              description: "List every view, returning each title and id.",
              rationale: "enumerates",
            },
            {
              operation: "svc.views.nonexistent",
              description: "Something else entirely.",
              rationale: "unresolvable",
            },
          ],
        } as never,
      },
    });
    expect(changes).toEqual([]);
    for (const op of next.operations) {
      const before = air.operations.find((candidate) => candidate.id === op.id)!;
      expect(op.description).toBe(before.description);
    }
  });

  it("scores the rewrite over EVERY task on a catalog rebuilt the way the runtime serves it", async () => {
    const air = viewsEstate();
    const delta = await scoreGroupProposal(air, clusterDeficiencyFixture(air), {
      disambiguate: DISAMBIGUATION_PAYLOAD,
    });
    expect(delta.proposalKind).toBe("disambiguate");
    expect(delta.scope).toBe("all_tasks");
    // A disambiguation neither adds nor supersedes: the served catalog is the
    // same size it was, and the delta names exactly whose text moved.
    expect(delta.hypothetical.catalogSize).toBe(air.operations.length);
    expect(delta.hypothetical.supersededOperationIds).toEqual([]);
    expect(delta.hypothetical.rewrittenOperationIds).toEqual([
      "svc.views.count",
      "svc.views.execute",
      "svc.views.list",
    ]);
    // Every intent example in the estate is a task, member or not — the point
    // of scoring this arm over all tasks.
    const allTasks = air.operations.reduce((n, op) => n + op.skill.intentExamples.length, 0);
    expect(delta.totalTasks).toBe(allTasks);
    expect(admitOrRefuse(delta)).toBe(delta);
    expect(delta.passedAfter).toBeGreaterThan(delta.passedBefore);
  });

  it("REFUSES a distinct-but-worse rewrite with the numbers, before a reviewer sees it", async () => {
    const air = viewsEstate();
    // Each member still says something the others do not — the deterministic
    // check passes — but the wording pulls the wrong tasks. Only the benchmark
    // can catch this, which is why the arm has both gates and not one.
    const worse: GroupDisambiguationPayload = {
      operations: [
        {
          operation: "svc.views.list",
          description: "Return the ticket rows one view matches, row by row.",
          rationale: "wrong on purpose",
        },
        {
          operation: "svc.views.execute",
          description: "A general view helper.",
          rationale: "wrong on purpose",
        },
        {
          operation: "svc.views.count",
          description: "Another view utility.",
          rationale: "wrong on purpose",
        },
      ],
    };
    const delta = await scoreGroupProposal(air, clusterDeficiencyFixture(air), {
      disambiguate: worse,
    });
    expect(() => admitOrRefuse(delta)).toThrow(GroupAdmissionRefusal);
    try {
      admitOrRefuse(delta);
    } catch (error) {
      const refusal = error as GroupAdmissionRefusal;
      expect(refusal.rejection.code).toBe("refinement/group_delta_regressed");
      expect(refusal.rejection.message).toContain("makes routing worse");
      expect(refusal.delta.flippedToFail.length).toBeGreaterThan(0);
    }
  });
});
