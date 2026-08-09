import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AirDocument, loadAirDocument } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { buildRefinementPlan } from "../plan.js";
import { targetKey } from "../target.js";
import { HarnessProtocolError } from "./errors.js";
import { importHarnessSubmission } from "./import.js";
import { resolveRepositoryRevision } from "./repository.js";
import type { HarnessSubmission, RefinementTask } from "./schema.js";
import { createRefinementTask } from "./task.js";

const DESCRIPTION =
  "Customer-facing explanation stored with the refund and displayed on the receipt.";

function air(): AirDocument {
  return loadAirDocument({
    service: {
      id: "payments",
      displayName: "Payments",
      version: "2026-08-06",
      source: { kind: "openapi", uri: "./payments.openapi.yaml" },
    },
    operations: [
      {
        id: "payments.refunds.create",
        canonicalName: "create_refund",
        displayName: "Create refund",
        description: "Create a refund against a captured payment.",
        sourceRef: { kind: "openapi", path: "/refunds", method: "post" },
        effect: { kind: "mutation", action: "create", risk: "financial", reversible: false },
        input: {
          params: [],
          body: {
            projection: "fields",
            fields: [{ name: "reason", required: true, schema: { type: "string" } }],
          },
        },
        errors: [],
        idempotency: { mode: "required", mechanism: "header", header: "Idempotency-Key" },
        retries: { mode: "safe" },
        confirmation: { required: true },
        auth: { type: "api_key" },
        cli: { command: "payments refunds create" },
        mcp: { toolName: "payments_create_refund" },
        skill: { intentExamples: ["Refund a payment."] },
        evidence: { claims: [] },
      },
    ],
  });
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "anvil-harness-protocol-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "test"));
  writeFileSync(
    join(root, "src", "refund.ts"),
    `export const reason = ${JSON.stringify(DESCRIPTION)};\n`,
  );
  writeFileSync(
    join(root, "test", "refund.test.ts"),
    `const expected = ${JSON.stringify(DESCRIPTION)};\n`,
  );
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "anvil@example.test"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Anvil Test"], { cwd: root });
  execFileSync("git", ["add", "src/refund.ts", "test/refund.test.ts"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
  return root;
}

function taskFor(document: AirDocument, root: string): RefinementTask {
  const deficiency = buildRefinementPlan(document).deficiencies.find(
    (candidate) =>
      candidate.code === "missing_field_description" &&
      targetKey(candidate.target).endsWith("input.body.reason"),
  );
  if (!deficiency) throw new Error("fixture did not produce a missing field description");
  return createRefinementTask(document, deficiency, {
    repositoryRoot: root,
    repositoryRevision: resolveRepositoryRevision(root),
    inspectScopes: ["src", "test"],
  });
}

function proposal(task: RefinementTask, patchValue = DESCRIPTION): HarnessSubmission {
  return {
    schemaVersion: 1,
    taskId: task.taskId,
    taskHash: task.taskHash,
    executor: { name: "codex", version: "1" },
    status: "proposal_generated",
    summary: "The handler and its contract test give reason the same domain meaning.",
    evidence: [
      { id: "handler", kind: "repository", source: "source_impl", path: "src/refund.ts" },
      {
        id: "contract-test",
        kind: "repository",
        source: "test_fixture",
        path: "test/refund.test.ts",
      },
    ],
    claims: [
      { predicate: "field.description", value: DESCRIPTION, evidenceId: "handler" },
      { predicate: "field.description", value: DESCRIPTION, evidenceId: "contract-test" },
    ],
    patch: { set: { description: patchValue } },
  };
}

function rejection(fn: () => unknown): HarnessProtocolError {
  try {
    fn();
  } catch (error) {
    if (error instanceof HarnessProtocolError) return error;
    throw error;
  }
  throw new Error("expected a harness protocol rejection");
}

describe("process-neutral refinement protocol", () => {
  it("rejects malformed task input with the registered task code", () => {
    const document = air();
    const root = repository();

    const error = rejection(() =>
      importHarnessSubmission(document, {}, {}, { repositoryRoot: root }),
    );
    expect(error.rejection.code).toBe("refinement/invalid_task");
  });

  it("exports byte-stable tasks with deterministic ids", () => {
    const document = air();
    const root = repository();
    const first = taskFor(document, root);
    const second = taskFor(document, root);

    expect(second).toEqual(first);
    expect(first.taskId).toBe(`rt_${first.taskHash.slice(0, 24)}`);
    expect(first.context).toHaveProperty("operation");
    expect(JSON.stringify(first.expectedSubmission)).toContain("description");
  });

  it("re-resolves evidence from the pinned Git commit and emits a normal measured pack", () => {
    const document = air();
    const root = repository();
    const task = taskFor(document, root);
    const pack = importHarnessSubmission(document, task, proposal(task), { repositoryRoot: root });

    expect(pack.refinements).toHaveLength(1);
    expect(pack.refinements[0]?.status).toBe("approved");
    const record = pack.harnessImports?.[0];
    expect(record?.task.taskId).toBe(task.taskId);
    expect(record?.artifacts).toHaveLength(2);
    for (const artifact of record?.artifacts ?? []) {
      expect(artifact.verification.status).toBe("verified");
      expect(artifact.revision).toBe(task.repository.revision);
      expect(artifact.gitBlob).toMatch(/^[a-f0-9]{40}$/);
      expect(artifact.blobSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(artifact.contentHash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("records an honest decline without inventing a refinement", () => {
    const document = air();
    const root = repository();
    const task = taskFor(document, root);
    const decline: HarnessSubmission = {
      schemaVersion: 1,
      taskId: task.taskId,
      taskHash: task.taskHash,
      executor: { name: "claude-code" },
      status: "insufficient_evidence",
      summary: "The repository does not define the field's business meaning.",
      evidence: [],
      claims: [],
    };

    const pack = importHarnessSubmission(document, task, decline, { repositoryRoot: root });
    expect(pack.refinements).toEqual([]);
    expect(pack.summary.skipped).toBe(1);
    expect(pack.harnessImports?.[0]?.submission.status).toBe("insufficient_evidence");
  });

  it("fails closed on a task changed after export", () => {
    const document = air();
    const root = repository();
    const task = taskFor(document, root);
    const tampered = structuredClone(task);
    tampered.context.note = "trust me";

    const error = rejection(() =>
      importHarnessSubmission(document, tampered, proposal(task), { repositoryRoot: root }),
    );
    expect(error.rejection.code).toBe("refinement/task_integrity_failed");
  });

  it("fails closed when AIR or the repository revision moved", () => {
    const document = air();
    const root = repository();
    const task = taskFor(document, root);
    const staleAir = structuredClone(document);
    staleAir.operations[0]!.description = "Changed after task export.";
    expect(
      rejection(() =>
        importHarnessSubmission(staleAir, task, proposal(task), { repositoryRoot: root }),
      ).rejection.code,
    ).toBe("refinement/stale_contract");

    writeFileSync(join(root, "README.md"), "new commit\n");
    execFileSync("git", ["add", "README.md"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "move revision"], { cwd: root });
    expect(
      rejection(() =>
        importHarnessSubmission(document, task, proposal(task), { repositoryRoot: root }),
      ).rejection.code,
    ).toBe("refinement/repository_revision_mismatch");
  });

  it("returns structured policy and validation rejections", () => {
    const document = air();
    const root = repository();
    const task = taskFor(document, root);
    const outside = proposal(task) as unknown as Record<string, unknown>;
    const patch = (outside.patch ?? {}) as { set?: Record<string, unknown> };
    patch.set = { type: "number" };
    outside.patch = patch;
    expect(
      rejection(() => importHarnessSubmission(document, task, outside, { repositoryRoot: root }))
        .rejection.code,
    ).toBe("refinement/task_binding_failed");

    const ungrounded = proposal(task, "An unrelated meaning not asserted by either source.");
    const error = rejection(() =>
      importHarnessSubmission(document, task, ungrounded, { repositoryRoot: root }),
    );
    expect(error.rejection.code).toBe("refinement/proposal_rejected");
    expect(error.rejection.issues.join(" ")).toContain("evidence_supports_value");
  });

  it("rejects repository traversal before reading evidence", () => {
    const document = air();
    const root = repository();
    const task = taskFor(document, root);
    const escaped = proposal(task) as unknown as { evidence: Array<Record<string, unknown>> };
    escaped.evidence[0]!.path = "../secrets.txt";

    const error = rejection(() =>
      importHarnessSubmission(document, task, escaped, { repositoryRoot: root }),
    );
    expect(error.rejection.code).toBe("refinement/invalid_submission");
  });

  it("rejects a valid repository path outside the task's inspect scopes", () => {
    const document = air();
    const root = repository();
    const task = taskFor(document, root);
    const outside = proposal(task) as unknown as { evidence: Array<Record<string, unknown>> };
    outside.evidence[0]!.path = "README.md";

    const error = rejection(() =>
      importHarnessSubmission(document, task, outside, { repositoryRoot: root }),
    );
    expect(error.rejection.code).toBe("refinement/repository_evidence_invalid");
  });
});
