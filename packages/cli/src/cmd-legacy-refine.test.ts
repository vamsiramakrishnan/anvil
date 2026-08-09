import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LegacyRefinementSubmission, LegacyRefinementTask } from "@anvil/compiler/legacy";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAnvilCli } from "./anvil-cli.js";
import { bufferIO } from "./io.js";

type GeneratedSubmission = Extract<LegacyRefinementSubmission, { status: "proposal_generated" }>;

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "anvil-legacy-refine-"));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

async function anvil(...argv: string[]) {
  const io = bufferIO();
  const code = await runAnvilCli(argv, { io });
  return { code, out: io.stdout.join("\n"), err: io.stderr.join("\n") };
}

function sourceFixture(): string {
  const source = join(work, "refunds-prod");
  mkdirSync(join(source, "refunds", "META-INF"), { recursive: true });
  writeFileSync(
    join(source, "refunds", "META-INF", "ejb-jar.xml"),
    `<ejb-jar><enterprise-beans><session>
      <ejb-name>RefundBean</ejb-name><remote>com.acme.Refunds</remote>
    </session></enterprise-beans></ejb-jar>`,
  );
  for (const [file, target] of [
    ["weblogic-ejb-jar.xml", "ejb/refunds-v1"],
    ["weblogic-bindings.xml", "ejb/refunds-v2"],
  ]) {
    writeFileSync(
      join(source, "refunds", "META-INF", file as string),
      `<weblogic-ejb-jar><weblogic-enterprise-bean>
        <ejb-name>RefundBean</ejb-name><jndi-name>${target}</jndi-name>
      </weblogic-enterprise-bean></weblogic-ejb-jar>`,
    );
  }
  return source;
}

async function inventoryReport() {
  const path = join(work, "inventory.json");
  const result = await anvil(
    "legacy",
    "inventory",
    sourceFixture(),
    "--environment",
    "prod",
    "--application",
    "refund-service",
    "--out",
    path,
    "--json",
  );
  expect(result.code, result.err).toBe(0);
  return { path, report: JSON.parse(result.out) };
}

function submission(task: LegacyRefinementTask): GeneratedSubmission {
  const targetClaim = task.candidate.claims.find((claim) => claim.dimension === "binding_target");
  if (!targetClaim) throw new Error("missing target claim");
  const selected = targetClaim.assertions.find((assertion) => assertion.value === "ejb/refunds-v2");
  const evidenceId = selected?.evidence[0]?.evidenceId;
  if (!evidenceId) throw new Error("missing target evidence");
  const decisionClaims = [
    "business_operation",
    "business_effect",
    "input_schema",
    "output_schema",
    "error_semantics",
    "completion_semantics",
    "authorization",
    "idempotency",
    "retry_policy",
  ] as const;
  if (task.candidate.invocation.kind !== "remote_method") {
    throw new Error("expected remote method candidate");
  }
  return {
    schemaVersion: 1,
    taskId: task.taskId,
    taskHash: task.taskHash,
    status: "proposal_generated",
    executor: { name: "codex", model: "gpt-5" },
    summary:
      "The remote interface and implementation contract establish a refund submission operation.",
    evidence: [
      { kind: "inventory", refId: "jndi-v2", evidenceId },
      {
        kind: "repository",
        refId: "contract",
        repository: "payments/refunds",
        revision: "0123456789abcdef",
        path: "src/main/java/com/acme/Refunds.java",
        startLine: 10,
        endLine: 50,
        blobDigest: `sha256:${"a".repeat(64)}`,
        excerptDigest: `sha256:${"b".repeat(64)}`,
      },
    ],
    claimEvidence: [
      ...decisionClaims.map((claim) => ({ claim, evidenceRefIds: ["contract"] })),
      { claim: "transport_target", evidenceRefIds: ["jndi-v2"] },
      { claim: "interaction_pattern", evidenceRefIds: ["contract"] },
    ],
    resolutions: [
      {
        dimension: "binding_target",
        selectedValue: "ejb/refunds-v2",
        evidenceRefIds: ["jndi-v2"],
        reason: "The production deployment binding selects V2.",
      },
    ],
    operation: {
      name: "refunds.submit",
      summary: "Submit a refund",
      description: "Submit one refund request and return the completed business outcome.",
      effect: "create",
      exposure: "mcp_tool",
      inputSchema: {
        type: "object",
        properties: { order_id: { type: "string" }, amount_minor_units: { type: "integer" } },
        required: ["order_id", "amount_minor_units"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { refund_id: { type: "string" }, outcome: { type: "string" } },
        required: ["refund_id", "outcome"],
        additionalProperties: false,
      },
      errors: [
        {
          code: "REFUND_REJECTED",
          meaning: "The refund request was rejected.",
          retryable: false,
          recovery: "Correct the request or contact the refunds team.",
        },
      ],
    },
    transport: {
      kind: "remote_method",
      protocol: "ejb_rmi",
      target: "ejb/refunds-v2",
      interface: task.candidate.invocation.interface,
      method: "submitRefund",
      serialization: "java_serialization",
    },
    semantics: {
      completion: "business_completed",
      timeoutMs: 30_000,
      authorization: { mode: "service_account", scopes: ["refunds.submit"] },
      idempotency: { mode: "client_key", carrier: "request.idempotencyKey" },
      retry: { mode: "safe_transient", maxAttempts: 3 },
    },
  };
}

describe("anvil legacy refine", () => {
  it("exports, reviews, and approves one exact proposal without claiming a runtime exists", async () => {
    const inventory = await inventoryReport();
    const taskPath = join(work, "task.json");
    const taskResult = await anvil(
      "legacy",
      "refine",
      "task",
      inventory.path,
      inventory.report.candidates[0].candidateId,
      "--out",
      taskPath,
      "--json",
    );
    expect(taskResult.code, taskResult.err).toBe(0);
    const taskReport = JSON.parse(taskResult.out);
    expect(taskReport).toMatchObject({ reportType: "anvil.legacy-refinement-task" });

    const submissionPath = join(work, "submission.json");
    writeFileSync(submissionPath, `${JSON.stringify(submission(taskReport.task), null, 2)}\n`);
    const reviewPath = join(work, "review.json");
    const reviewResult = await anvil(
      "legacy",
      "refine",
      "review",
      inventory.path,
      taskPath,
      submissionPath,
      "--out",
      reviewPath,
      "--json",
    );
    expect(reviewResult.code, reviewResult.err).toBe(0);
    expect(JSON.parse(reviewResult.out).assessment).toMatchObject({ ok: true, issues: [] });

    const decisionPath = join(work, "decision.json");
    const approval = await anvil(
      "legacy",
      "refine",
      "approve",
      inventory.path,
      reviewPath,
      "--reviewer",
      "refund-owner@example.com",
      "--reason",
      "Checked against the production deployment and service contract.",
      "--out",
      decisionPath,
      "--json",
    );
    expect(approval.code, approval.err).toBe(0);
    const decision = JSON.parse(approval.out);
    expect(decision).toMatchObject({
      reportType: "anvil.legacy-refinement-decision",
      decision: "approved",
      binding: {
        operation: { name: "refunds.submit" },
        runtime: { placement: "deployment_local_bridge", status: "not_implemented" },
      },
    });
    expect(JSON.parse(readFileSync(decisionPath, "utf8"))).toEqual(decision);

    const rejection = await anvil(
      "legacy",
      "refine",
      "reject",
      inventory.path,
      reviewPath,
      "--reviewer",
      "refund-owner@example.com",
      "--reason",
      "A later owner review rejected exposing this operation.",
      "--json",
    );
    expect(rejection.code, rejection.err).toBe(0);
    expect(JSON.parse(rejection.out)).toMatchObject({
      reportType: "anvil.legacy-refinement-decision",
      decision: "rejected",
      receipt: { decision: "rejected" },
    });
    expect(JSON.parse(rejection.out)).not.toHaveProperty("binding");
  });

  it("keeps invalid harness output reviewable but impossible to approve", async () => {
    const inventory = await inventoryReport();
    const task = JSON.parse(
      (
        await anvil(
          "legacy",
          "refine",
          "task",
          inventory.path,
          inventory.report.candidates[0].candidateId,
          "--json",
        )
      ).out,
    ).task;
    const taskPath = join(work, "task.json");
    writeFileSync(
      taskPath,
      `${JSON.stringify({ schemaVersion: 1, reportType: "anvil.legacy-refinement-task", task })}\n`,
    );
    const unsafe = submission(task);
    unsafe.resolutions = [];
    unsafe.semantics.completion = "unknown";
    const submissionPath = join(work, "unsafe.json");
    writeFileSync(submissionPath, JSON.stringify(unsafe));
    const reviewPath = join(work, "review.json");
    const review = await anvil(
      "legacy",
      "refine",
      "review",
      inventory.path,
      taskPath,
      submissionPath,
      "--out",
      reviewPath,
      "--json",
    );
    expect(review.code).toBe(1);
    expect(
      JSON.parse(review.out).assessment.issues.map((issue: Record<string, string>) => issue.code),
    ).toEqual(
      expect.arrayContaining([
        "legacy/refinement/unresolved_conflict",
        "legacy/refinement/unknown_completion_semantics",
      ]),
    );

    const approval = await anvil(
      "legacy",
      "refine",
      "approve",
      inventory.path,
      reviewPath,
      "--reviewer",
      "owner@example.com",
      "--reason",
      "Ignore the missing evidence.",
      "--json",
    );
    expect(approval.code).toBe(1);
    expect(JSON.parse(approval.out).code).toBe("legacy/refinement_not_approvable");
  });

  it("refuses symbolic-link inputs and different output collisions with stable codes", async () => {
    const inventory = await inventoryReport();
    const linked = join(work, "inventory-link.json");
    symlinkSync(inventory.path, linked);
    const refused = await anvil(
      "legacy",
      "refine",
      "task",
      linked,
      inventory.report.candidates[0].candidateId,
      "--json",
    );
    expect(JSON.parse(refused.out).code).toBe("legacy/refinement_input_refused");

    const output = join(work, "existing.json");
    writeFileSync(output, "different\n");
    const collision = await anvil(
      "legacy",
      "refine",
      "task",
      inventory.path,
      inventory.report.candidates[0].candidateId,
      "--out",
      output,
      "--json",
    );
    expect(JSON.parse(collision.out).code).toBe("legacy/refinement_output_exists");
    expect(readFileSync(output, "utf8")).toBe("different\n");
  });
});
