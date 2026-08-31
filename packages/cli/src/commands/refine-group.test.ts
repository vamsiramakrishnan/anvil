import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { airFromYaml, airToYaml, loadAirDocument, planWorkflowSurface } from "@anvil/air";
import { afterEach, describe, expect, it } from "vitest";
import { runAnvilCli } from "../anvil-cli.js";
import { bufferIO } from "../io.js";

/**
 * The whole GROUP loop, driven the way an operator drives it: benchmark a
 * served estate → a measured confusion cluster → `refine export-task
 * group:<id>` → a coding-harness submission → `refine import-proposal`, where
 * the proposal is benchmark-SCORED before it may reach review → receipt-bound
 * approval → `refine apply-pack` → the shared planner shrinks the served
 * surface.
 *
 * The estate is the Zendesk-shaped views family the routing benchmark measured
 * at scale (list/execute/count eating each other's tasks) — small enough to
 * predict, large enough to clear the cluster-evidence floor (6 mis-routed
 * tasks ≥ MIN_CLUSTER_EVIDENCE).
 *
 * Two refusals are pinned here because each is a mutation-gate control:
 *  - a submission that MANGLES routing is refused WITH the numbers
 *    (benchmark-admission/negative-delta-refused);
 *  - a submission naming an operation outside its grant is refused by
 *    deterministic validation, not left for a reviewer.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function read(overrides: Record<string, unknown>) {
  return {
    idempotency: { mode: "natural" },
    retries: { mode: "safe" },
    confirmation: { required: false },
    auth: { type: "api_key" },
    errors: [],
    evidence: { claims: [] },
    state: "approved",
    ...overrides,
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "anvil-refine-group-cli-"));
  dirs.push(root);
  const air = loadAirDocument({
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
        sourceRef: {
          kind: "openapi",
          path: "/views/{view_id}/execute",
          method: "get",
          operationId: "executeView",
        },
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
        sourceRef: {
          kind: "openapi",
          path: "/views/{view_id}/count",
          method: "get",
          operationId: "countView",
        },
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
        sourceRef: {
          kind: "openapi",
          path: "/tickets/{ticket_id}",
          method: "get",
          operationId: "getTicket",
        },
        effect: { kind: "read", action: "get", resource: "ticket" },
        input: { params: [{ name: "ticket_id", in: "path", required: true, example: "t1" }] },
        output: { schema: { type: "object", properties: { ticket: { type: "object" } } } },
        cli: { command: "svc tickets get" },
        mcp: { toolName: "svc_get_ticket" },
        skill: { intentExamples: ["get a ticket"] },
      }),
    ],
  });
  const airPath = join(root, "air.yaml");
  writeFileSync(airPath, airToYaml(air));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "anvil@example.test"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Anvil Test"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
  return { root, airPath };
}

async function anvil(...args: string[]) {
  const io = bufferIO();
  const code = await runAnvilCli(args, { io });
  return { code, io };
}

interface TaskFile {
  taskId: string;
  taskHash: string;
}

function workflowSubmission(task: TaskFile, payload: unknown) {
  return {
    schemaVersion: 1,
    taskId: task.taskId,
    taskHash: task.taskHash,
    executor: { name: "claude-code", version: "1" },
    status: "proposal_generated",
    summary: "Docs describe list-then-execute as one user task.",
    evidence: [{ id: "doc", kind: "repository", source: "doc_example", path: "air.yaml" }],
    claims: [{ predicate: "group.workflow", value: payload, evidenceId: "doc" }],
    patch: { set: { workflow: payload } },
  };
}

const GOOD_PAYLOAD = {
  name: "list_and_execute_view",
  description: "List views, then execute the chosen view and count its rows.",
  intent_examples: ["execute a view from the list"],
  steps: [
    { operation: "svc.views.list" },
    { operation: "svc.views.execute", bindings: { view_id: "$.output.view_id" } },
  ],
  supersedes: ["svc.views.execute", "svc.views.list"],
};

/** Grounded in member vocabulary but named after the WRONG member: it replaces
 *  list yet routes like count, stealing count's tasks and stranding list's. */
const MANGLING_PAYLOAD = {
  name: "count_ticket_view",
  description: "Count tickets in the view rows.",
  intent_examples: ["count tickets in the view"],
  steps: [
    { operation: "svc.views.list" },
    { operation: "svc.views.execute", bindings: { view_id: "$.output.view_id" } },
  ],
  supersedes: ["svc.views.list"],
};

async function benchmarkAndExport(root: string, airPath: string) {
  const bench = await anvil("benchmark", root);
  expect(bench.io.text()).toContain("Confusable tool families");
  const report = JSON.parse(readFileSync(join(root, "benchmark.report.json"), "utf8"));
  const cluster = report.confusion.clusters[0];
  expect(cluster).toBeDefined();
  expect(cluster.taskCount).toBeGreaterThanOrEqual(5);
  expect(cluster.members.map((m: { toolName: string }) => m.toolName)).toEqual([
    "svc_count_view",
    "svc_execute_view",
    "svc_list_views",
  ]);

  const taskPath = join(root, "task.json");
  const exported = await anvil(
    "refine",
    "export-task",
    airPath,
    `group:${cluster.id}`,
    "--repo-root",
    root,
    "--out",
    taskPath,
  );
  expect(exported.code, exported.io.text()).toBe(0);
  const task = JSON.parse(readFileSync(taskPath, "utf8")) as TaskFile & {
    skill: { name: string };
    deficiency: { facts: { members: Array<{ operationId: string }> } };
  };
  expect(task.skill.name).toBe("resolve-confusable-cluster");
  return { cluster, taskPath, task };
}

describe("anvil refine group loop (benchmark → export → scored import → apply)", () => {
  it("scores a helpful composition, attaches the delta, and the surface shrinks on apply", async () => {
    const { root, airPath } = fixture();
    const { taskPath, task } = await benchmarkAndExport(root, airPath);

    const submissionPath = join(root, "submission.json");
    writeFileSync(
      submissionPath,
      `${JSON.stringify(workflowSubmission(task, GOOD_PAYLOAD), null, 2)}\n`,
    );
    const packDir = join(root, "pack");
    const imported = await anvil(
      "refine",
      "import-proposal",
      airPath,
      taskPath,
      submissionPath,
      "--repo-root",
      root,
      "--out",
      packDir,
    );
    expect(imported.code, imported.io.text()).toBe(0);
    expect(imported.io.text()).toContain("review");

    // The measured delta is attached as evidence — the reviewer sees the number.
    const delta = JSON.parse(readFileSync(join(packDir, "routing-delta.json"), "utf8"));
    expect(delta.reportType).toBe("anvil.group-routing-delta");
    expect(delta.totalTasks).toBe(12);
    expect(delta.passedBefore).toBe(6);
    expect(delta.passedAfter).toBe(11);
    expect(delta.upliftPts).toBeCloseTo(41.7, 1);
    // Per-intent flips, BOTH directions: the composite wins six confused tasks
    // and steals one of count's — the reviewer sees the honest trade, verbatim.
    expect(delta.flippedToPass.length).toBe(6);
    expect(delta.flippedToFail).toEqual([
      { intent: "execute a count of the view", operationId: "svc.views.count" },
    ]);
    // Honesty: nothing was executed against a mock, and the report says so.
    expect(delta.simulated).toBe(false);
    expect(delta.simulationNote).toContain("NOT executed");
    const pack = JSON.parse(readFileSync(join(packDir, "pack.json"), "utf8"));
    const refinement = pack.refinements[0];
    expect(refinement.approval.tier).toBe("review");
    expect(
      refinement.evidence.some(
        (claim: { predicate: string }) => claim.predicate === "group.routing_delta",
      ),
    ).toBe(true);

    // Receipt-bound approval, then apply — never auto.
    const approved = await anvil(
      "refine",
      "approve",
      packDir,
      refinement.id,
      "--reviewer",
      "reviewer@example.test",
      "--reason",
      "measured +41.7 pts; composes cleanly",
    );
    expect(approved.code, approved.io.text()).toBe(0);
    const applied = await anvil("refine", "apply-pack", airPath, packDir);
    expect(applied.code, applied.io.text()).toBe(0);

    // The served surface SHRANK: 4 operations − 2 superseded + 1 composite = 3.
    const next = airFromYaml(readFileSync(airPath, "utf8"));
    expect(next.workflows).toHaveLength(1);
    const opsById = new Map(next.operations.map((op) => [op.id, op]));
    const plan = planWorkflowSurface(next.workflows, opsById, opsById);
    expect([...plan.superseded.keys()].sort()).toEqual(["svc.views.execute", "svc.views.list"]);
    const servedTools = next.operations.filter((op) => !plan.superseded.has(op.id)).length + 1;
    expect(servedTools).toBe(3);
  });

  it("REFUSES a submission that mangles routing, with the numbers, writing no pack", async () => {
    const { root, airPath } = fixture();
    const { taskPath, task } = await benchmarkAndExport(root, airPath);

    const submissionPath = join(root, "mangling.json");
    writeFileSync(
      submissionPath,
      `${JSON.stringify(workflowSubmission(task, MANGLING_PAYLOAD), null, 2)}\n`,
    );
    const packDir = join(root, "pack-refused");
    const refused = await anvil(
      "refine",
      "import-proposal",
      airPath,
      taskPath,
      submissionPath,
      "--repo-root",
      root,
      "--out",
      packDir,
      "--json",
    );
    expect(refused.code).toBe(1);
    const envelope = JSON.parse(refused.io.stdout[0] ?? "{}");
    expect(envelope).toMatchObject({
      ok: false,
      reportType: "anvil.refinement-harness-import-error",
      code: "refinement/group_delta_regressed",
      stage: "admission",
    });
    // The refusal carries the numbers — before, after, and the introduced mis-routes.
    expect(envelope.message).toContain("this abstraction makes routing worse: 6→4");
    expect(envelope.issues.join(" ")).toContain("tasks routed correctly before: 6/12");
    expect(envelope.issues.join(" ")).toContain("tasks routed correctly after: 4/12");
    expect(envelope.issues.join(" ")).toContain('now mis-routed: "show all views"');
    // A refused proposal leaves nothing behind for anyone to apply.
    expect(existsSync(packDir)).toBe(false);
  });

  it("REFUSES a submission naming an operation outside its grant, by validation", async () => {
    const { root, airPath } = fixture();
    const { taskPath, task } = await benchmarkAndExport(root, airPath);

    const payload = {
      ...GOOD_PAYLOAD,
      steps: [
        { operation: "svc.tickets.get" },
        { operation: "svc.views.execute", bindings: { view_id: "$.output.view_id" } },
      ],
      supersedes: ["svc.views.execute"],
    };
    const submissionPath = join(root, "outside.json");
    writeFileSync(
      submissionPath,
      `${JSON.stringify(workflowSubmission(task, payload), null, 2)}\n`,
    );
    const refused = await anvil(
      "refine",
      "import-proposal",
      airPath,
      taskPath,
      submissionPath,
      "--repo-root",
      root,
      "--out",
      join(root, "pack-outside"),
      "--json",
    );
    expect(refused.code).toBe(1);
    const envelope = JSON.parse(refused.io.stdout[0] ?? "{}");
    expect(envelope).toMatchObject({ ok: false, code: "refinement/proposal_rejected" });
    expect(envelope.issues.join(" ")).toContain("group_grant_respected");
    expect(envelope.issues.join(" ")).toContain("svc.tickets.get");
  });
});
