import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { airToYaml, loadAirDocument } from "@anvil/air";
import { readBenchmarkReport } from "@anvil/refinement";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONSOLE_ROUTES, zErrorEnvelope } from "../contract.js";
import { type Client, gitInit, startServer, writeBenchmarkReport } from "./fixture.js";

/**
 * The group loop through the console: export a cluster task, import a
 * submission, and be refused — with the CLI's own error code and the numbers
 * — when the measured routing delta is negative. The estate is the views
 * family from packages/cli's refine-group test, so the numbers here are the
 * numbers `anvil refine import-proposal` prints for the same submission
 * (6→4 of 12). A refused import leaves no pack behind.
 */

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

function viewsEstate(root: string): string {
  const bundleDir = join(root, "bundle");
  mkdirSync(bundleDir, { recursive: true });
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
  writeFileSync(join(bundleDir, "air.yaml"), airToYaml(air));
  return bundleDir;
}

function workflowSubmission(task: { taskId: string; taskHash: string }, payload: unknown) {
  return {
    schemaVersion: 1,
    taskId: task.taskId,
    taskHash: task.taskHash,
    executor: { name: "claude-code", version: "1" },
    status: "proposal_generated",
    summary: "Docs describe list-then-execute as one user task.",
    evidence: [{ id: "doc", kind: "repository", source: "doc_example", path: "bundle/air.yaml" }],
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

/** Grounded in member vocabulary but named after the WRONG member. */
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

let root: string;
let bundleDir: string;
let client: Client;
let close: () => Promise<void>;
let clusterId: string;

beforeAll(async () => {
  root = join(tmpdir(), `anvil-console-admission-${process.pid}-${Date.now()}`);
  bundleDir = viewsEstate(root);
  await writeBenchmarkReport(bundleDir);
  gitInit(root);
  const cluster = readBenchmarkReport(bundleDir)?.confusion.clusters[0];
  if (!cluster) throw new Error("the views estate produced no confusion cluster");
  clusterId = cluster.id;
  const started = await startServer(root);
  client = started.client;
  close = () => started.server.close();
});

afterAll(async () => {
  await close();
  rmSync(root, { recursive: true, force: true });
});

describe("group export and scored import through the console", () => {
  let taskPath: string;
  let task: { taskId: string; taskHash: string };

  it("exports the cluster task under the workspace, hash-bound to the repository", async () => {
    const reply = await client.post(`/api/bundles/bundle/clusters/${clusterId}/export-task`, {});
    expect(reply.status, reply.text).toBe(200);
    const view = CONSOLE_ROUTES.exportTask.response.parse(reply.json);
    expect(view.taskPath.startsWith(join(root, ".anvil", "console", "tasks"))).toBe(true);
    expect(existsSync(view.taskPath)).toBe(true);
    expect(view.task.skill.name).toBe("resolve-confusable-cluster");
    taskPath = view.taskPath;
    task = view.task;
    // Re-exporting the same task is idempotent, never a different-bytes overwrite.
    const again = await client.post(`/api/bundles/bundle/clusters/${clusterId}/export-task`, {});
    expect(again.status).toBe(200);
  });

  it("REFUSES a submission that mangles routing with the CLI's code and the numbers, writing no pack", async () => {
    const submissionPath = join(root, "mangling.json");
    writeFileSync(submissionPath, JSON.stringify(workflowSubmission(task, MANGLING_PAYLOAD)));
    const reply = await client.post("/api/bundles/bundle/tasks/import", {
      taskPath,
      submissionPath: "mangling.json",
    });
    expect(reply.status, reply.text).toBe(422);
    const envelope = zErrorEnvelope.parse(reply.json);
    expect(envelope.error.code).toBe("refinement/group_delta_regressed");
    expect(envelope.error.message).toContain("this abstraction makes routing worse: 6→4");
    expect(envelope.error.issues?.join(" ")).toContain("tasks routed correctly before: 6/12");
    expect(envelope.error.issues?.join(" ")).toContain("tasks routed correctly after: 4/12");
    expect(envelope.error.delta).toMatchObject({
      clusterId,
      proposalKind: "workflow",
      passedBefore: 6,
      passedAfter: 4,
      totalTasks: 12,
    });
    expect(existsSync(join(root, ".anvil", "console", "packs"))).toBe(false);
  });

  it("refuses a tampered task by the protocol, as the CLI does", async () => {
    writeFileSync(
      join(root, "tampered-task.json"),
      JSON.stringify({ ...JSON.parse(String(await readTask())), taskHash: "0".repeat(64) }),
    );
    const reply = await client.post("/api/bundles/bundle/tasks/import", {
      taskPath: "tampered-task.json",
      submissionPath: "mangling.json",
    });
    expect(reply.status).toBe(422);
    expect(zErrorEnvelope.parse(reply.json).error.code).toMatch(/^refinement\//);
  });

  it("admits a helpful composition with its delta as evidence, then decides and applies it", async () => {
    writeFileSync(join(root, "good.json"), JSON.stringify(workflowSubmission(task, GOOD_PAYLOAD)));
    const imported = await client.post("/api/bundles/bundle/tasks/import", {
      taskPath,
      submissionPath: "good.json",
    });
    expect(imported.status, imported.text).toBe(200);
    const view = CONSOLE_ROUTES.importTask.response.parse(imported.json);
    expect(view.taskId).toBe(task.taskId);
    expect(view.packDir).toBe(join(root, ".anvil", "console", "packs", task.taskId));
    expect(view.refinement?.tier).toBe("review");
    expect(view.delta?.passedAfter).toBeGreaterThanOrEqual(view.delta?.passedBefore ?? 0);
    expect(existsSync(join(view.packDir, "routing-delta.json"))).toBe(true);

    const packs = CONSOLE_ROUTES.packs.response.parse(
      (await client.get("/api/bundles/bundle/packs")).json,
    );
    const pack = packs.find((p) => p.dir === view.packDir);
    expect(pack?.items[0]?.delta?.clusterId).toBe(clusterId);
    if (!pack) throw new Error("imported pack not discovered");

    const refinementId = pack.items[0]?.refinementId ?? "";
    // The queue lists the review-tier refinement as a pack decision, with the
    // pack hash the decision route takes and the measured delta as evidence —
    // and the cluster it came from, with its mis-routes — from the same files.
    const pending = CONSOLE_ROUTES.queue.response.parse(
      (await client.get("/api/bundles/bundle/queue")).json,
    );
    const decision = pending.items.find((item) => item.kind === "pack");
    if (decision?.kind !== "pack") throw new Error("no pack decision in the queue");
    expect(decision.id).toBe(refinementId);
    expect(decision.subject).toMatchObject({ packHash: pack.hash, refinementId, tier: "review" });
    expect(decision.subject.delta?.clusterId).toBe(clusterId);
    expect(decision.evidence).toEqual(pack.items[0]?.claims);
    const cluster = pending.items.find((item) => item.kind === "cluster");
    if (cluster?.kind !== "cluster") throw new Error("no cluster in the queue");
    expect(cluster.id).toBe(clusterId);
    expect(cluster.subject.clusterId).toBe(clusterId);
    expect(cluster.subject.memberOperationIds.length).toBeGreaterThan(1);
    expect(cluster.subject.evidence.length).toBeGreaterThan(0);
    expect(cluster.subject.evidence[0]?.intents.length).toBeGreaterThan(0);
    const decided = await client.post(`/api/bundles/bundle/packs/${pack.hash}/decisions`, {
      decision: "approve",
      refinementIds: [refinementId],
      reviewer: "reviewer@example.test",
      reason: "the measured delta is non-negative and the chain is real",
    });
    expect(decided.status, decided.text).toBe(200);
    const recorded = CONSOLE_ROUTES.packDecision.response.parse(decided.json);
    expect(recorded.receipts.map((r) => r.refinementId)).toEqual([refinementId]);
    expect(recorded.receipts[0]?.receipt.decision).toBe("approved");
    expect(recorded.receipts[0]?.receipt.packHash).toBe(pack.hash);
    expect(existsSync(recorded.receipts[0]?.path ?? "")).toBe(true);

    // The same decision again is refused, never silently replaced (exactly as
    // `anvil refine approve` refuses: the receipt file already exists).
    const twice = await client.post(`/api/bundles/bundle/packs/${pack.hash}/decisions`, {
      decision: "approve",
      refinementIds: [refinementId],
      reviewer: "someone-else@example.test",
      reason: "a second opinion",
    });
    expect(twice.status).toBe(409);
    expect(zErrorEnvelope.parse(twice.json).error.message).toContain("Receipt already exists");
    const listed = CONSOLE_ROUTES.packs.response.parse(
      (await client.get("/api/bundles/bundle/packs")).json,
    );
    expect(listed.find((p) => p.hash === pack.hash)?.receipts).toHaveLength(1);
    expect(listed.find((p) => p.hash === pack.hash)?.items[0]?.receiptPaths).toEqual([
      recorded.receipts[0]?.path,
    ]);
    // Decided, the refinement is no longer a decision; the cluster still is.
    const after = CONSOLE_ROUTES.queue.response.parse(
      (await client.get("/api/bundles/bundle/queue")).json,
    );
    expect(after.items.filter((item) => item.kind === "pack")).toEqual([]);
    expect(after.items.some((item) => item.kind === "cluster" && item.id === clusterId)).toBe(true);

    const dry = await client.post(`/api/bundles/bundle/packs/${pack.hash}/apply`, {
      dryRun: true,
    });
    expect(dry.status, dry.text).toBe(200);
    const dryView = CONSOLE_ROUTES.applyPack.response.parse(dry.json);
    expect(dryView.written).toBe(false);
    expect(dryView.applied).toEqual([refinementId]);
    expect(dryView.changes.length).toBeGreaterThan(0);

    const applied = await client.post(`/api/bundles/bundle/packs/${pack.hash}/apply`, {});
    expect(applied.status, applied.text).toBe(200);
    const appliedView = CONSOLE_ROUTES.applyPack.response.parse(applied.json);
    expect(appliedView.written).toBe(true);
    expect(appliedView.airPath).toBe(join(bundleDir, "air.yaml"));
    // `anvil refine apply-pack` writes AIR only; so does the console.
    expect(appliedView.reprojection).toBeUndefined();
    const inspector = CONSOLE_ROUTES.bundle.response.parse(
      (await client.get("/api/bundles/bundle")).json,
    );
    expect(inspector.workflows.map((wf) => wf.id)).toContain("svc.list_and_execute_view");
  });

  async function readTask(): Promise<string> {
    const { readFileSync } = await import("node:fs");
    return readFileSync(taskPath, "utf8");
  }
});
