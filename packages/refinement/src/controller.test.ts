import { hashCanonical, loadAirDocument } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { type RepairCheckpoint, runRepairController } from "./controller.js";
import { evaluateRepairCases, repairInvariantHash } from "./controller-eval.js";
import { HeuristicSkillExecutor, type SkillExecutor } from "./skills/executor.js";

function fixture() {
  return loadAirDocument({
    service: {
      id: "enterprise",
      displayName: "Enterprise",
      version: "1",
      source: { kind: "openapi" },
    },
    operations: [
      {
        id: "workers.get",
        canonicalName: "get_worker",
        displayName: "Get worker",
        description: "Retrieve a worker by identifier.",
        sourceRef: { kind: "openapi", path: "/workers/{ID}", method: "get" },
        input: { params: [{ name: "ID", in: "path", required: true, schema: { type: "string" } }] },
        effect: { kind: "read", action: "get", risk: "none" },
        idempotency: { mode: "natural" },
        retries: { mode: "safe", basis: "read_safe", maxAttempts: 3, retryOn: ["http_503"] },
        confirmation: { required: false },
        auth: { type: "none" },
        cli: { command: "workers get" },
        mcp: { toolName: "workers_get" },
        skill: { intentExamples: ["Retrieve worker by identifier"] },
        evidence: {
          claims: [
            {
              subject: "input.params.ID",
              predicate: "field.example",
              value: "worker-123",
              source: "test_fixture",
              sourceRef: "owned-test:workers:example",
              confidence: 0.9,
            },
            {
              subject: "input.params.ID",
              predicate: "field.description",
              value: "Unique identifier of the worker.",
              source: "source_impl",
              sourceRef: "owned-test:workers:description",
              confidence: 0.9,
            },
          ],
        },
      },
    ],
  });
}

const reference = new HeuristicSkillExecutor();
const executor: SkillExecutor = {
  name: "owned-reference",
  execute: (skill, context) =>
    ["describe-field", "generate-examples"].includes(skill.name)
      ? reference.execute(skill, context)
      : Promise.resolve(null),
};
const accepted = (state: RepairCheckpoint) => state.attempts.filter((a) => a.status === "accepted");

describe("autonomous repair controller", () => {
  it("checks Google Docs-style create/batch-update intents against unapproved siblings", async () => {
    const input = fixture();
    const update = input.operations[0]!;
    update.id = "documents.batch_update";
    update.canonicalName = "batch_update_document";
    update.description = "Applies one or more updates to the document.";
    update.sourceRef = { kind: "openapi", method: "post", path: "/documents/{ID}:batchUpdate" };
    update.effect = {
      kind: "mutation",
      action: "create",
      resource: "document",
      risk: "low",
      reversible: false,
    };
    update.skill.intentExamples = [];
    update.cli.command = "documents batch-update";
    update.mcp.toolName = "documents_batch_update";
    const create = structuredClone(update);
    create.id = "documents.create";
    create.canonicalName = "create_document";
    create.description = "Creates a new blank document using the title given in the request.";
    create.sourceRef.path = "/documents";
    create.cli.command = "documents create";
    create.mcp.toolName = "documents_create";
    input.operations.push(create);
    const result = await runRepairController(input);
    expect(
      result.checkpoint.attempts.some((a) => a.reason.includes("full operation catalog")),
    ).toBe(true);
    expect(result.air.operations[0]!.skill.intentExamples).toEqual([]);
  });

  it("returns to a declined task when an earlier accepted repair supplies its prerequisite", async () => {
    const dependent: SkillExecutor = {
      name: "dependent",
      async execute(skill, context) {
        if (skill.name === "describe-field" && !context.field?.schema.examples) return null;
        return executor.execute(skill, context);
      },
    };
    const result = await runRepairController(fixture(), { executor: dependent });
    expect(accepted(result.checkpoint).map((a) => a.round)).toEqual([1, 2]);
  });

  it("leaves review-tier naming proposals pending without creating a human receipt", async () => {
    const input = fixture();
    input.operations[0]!.canonicalName = "do_worker";
    input.operations[0]!.cli.command = "workers do";
    input.operations[0]!.mcp.toolName = "workers_do";
    const result = await runRepairController(input);
    expect(result.checkpoint.attempts.some((a) => a.status === "review")).toBe(true);
    expect(result.air.operations[0]!.canonicalName).toBe("do_worker");
    expect(result.air.operations[0]!.state).toBe(input.operations[0]!.state);
  });

  it("accepts grounded improvements, re-audits, and preserves the input and grants", async () => {
    const input = fixture();
    const hash = hashCanonical(input);
    const snapshots: RepairCheckpoint[] = [];
    const result = await runRepairController(input, {
      executor,
      checkpoint: async (s) => {
        snapshots.push(s);
      },
    });
    expect(accepted(result.checkpoint), JSON.stringify(result.checkpoint.attempts)).toHaveLength(2);
    expect(result.checkpoint.remainingDeficiencies).toBeLessThan(
      result.checkpoint.initialDeficiencies,
    );
    expect(result.checkpoint.checks.currentPassed).toBeGreaterThan(
      result.checkpoint.checks.initialPassed,
    );
    expect(hashCanonical(input)).toBe(hash);
    expect(repairInvariantHash(input)).toBe(repairInvariantHash(result.air));
    expect(snapshots.length).toBeGreaterThan(2);
    expect(snapshots[0]?.attempts).toHaveLength(1);
  });

  it("revalidates accepted checkpoint proposals and continues within the total budget", async () => {
    const input = fixture();
    const first = await runRepairController(input, { executor, maxAttempts: 1 });
    const resumed = await runRepairController(input, {
      executor,
      resume: first.checkpoint,
      maxRounds: 5,
    });
    expect(accepted(resumed.checkpoint)).toHaveLength(2);
    expect(resumed.checkpoint.currentHash).toBe(hashCanonical(resumed.air));
    const altered = structuredClone(first.checkpoint);
    altered.attempts[0]!.proposal!.patch.set = { description: "Fabricated evidence" };
    await expect(runRepairController(input, { executor, resume: altered })).rejects.toThrow(
      /replay/,
    );
    const changed = fixture();
    changed.service.version = "2";
    await expect(
      runRepairController(changed, { executor, resume: first.checkpoint }),
    ).rejects.toThrow(/mismatch/);
  });

  it("rejects a lost external case, an empty battery and a per-case regression", async () => {
    for (const mode of ["lost", "empty", "regression"] as const) {
      let evaluations = 0;
      const input = fixture();
      const result = await runRepairController(input, {
        executor,
        evaluation: {
          id: mode,
          async evaluate() {
            evaluations += 1;
            if (evaluations === 1)
              return [
                { id: "wire", passed: true },
                { id: "heldout", passed: false },
              ];
            if (mode === "empty") return [];
            if (mode === "lost") return [{ id: "wire", passed: true }];
            return [
              { id: "wire", passed: false },
              { id: "heldout", passed: true },
            ];
          },
        },
      });
      expect(accepted(result.checkpoint)).toHaveLength(0);
      expect(hashCanonical(result.air)).toBe(hashCanonical(input));
    }
  });

  it("keeps candidate-authored intents outside the original evaluation inventory", () => {
    const input = fixture();
    const changed = structuredClone(input);
    changed.operations[0]!.skill.intentExamples = ["An easier replacement", "An extra case"];
    expect(evaluateRepairCases(input, changed).map((c) => c.id)).toEqual(
      evaluateRepairCases(input, input).map((c) => c.id),
    );
  });

  it("cannot mutate the current model through executor or evaluator arguments", async () => {
    const input = fixture();
    const malicious: SkillExecutor = {
      name: "mutator",
      async execute(skill, context) {
        if (context.operation) context.operation.state = "approved";
        if (context.field) context.field.schema.type = "boolean";
        skill.output.fields.push("state");
        return null;
      },
    };
    const result = await runRepairController(input, {
      executor: malicious,
      evaluation: {
        id: "mutator",
        async evaluate(candidate) {
          candidate.operations.length = 0;
          return [{ id: "constant", passed: true }];
        },
      },
    });
    expect(hashCanonical(result.air)).toBe(hashCanonical(input));
  });

  it("stops an uncooperative executor and discards its late result", async () => {
    const input = fixture();
    const hung: SkillExecutor = { name: "hung", execute: () => new Promise(() => {}) };
    const result = await runRepairController(input, { executor: hung, timeoutMs: 30 });
    expect(result.checkpoint.stop).toBe("budget");
    expect(result.checkpoint.attempts).toHaveLength(1);
    expect(hashCanonical(result.air)).toBe(hashCanonical(input));
  });

  it("records executor failures and stops on no progress", async () => {
    const bad: SkillExecutor = {
      name: "error",
      async execute() {
        throw new Error("worker failed");
      },
    };
    const result = await runRepairController(fixture(), { executor: bad });
    expect(result.checkpoint.stop).toBe("stalled");
    expect(result.checkpoint.attempts.every((a) => a.status === "error")).toBe(true);
  });

  it("rejects proposals redirected to a different target", async () => {
    const bad: SkillExecutor = {
      name: "redirect",
      async execute(skill, context) {
        const proposal = await executor.execute(skill, context);
        if (proposal) proposal.patch.target = { kind: "operation", operationId: "workers.get" };
        return proposal;
      },
    };
    const result = await runRepairController(fixture(), { executor: bad });
    expect(accepted(result.checkpoint)).toHaveLength(0);
    expect(
      result.checkpoint.attempts.some((a) => a.reason.includes("assigned skill and target")),
    ).toBe(true);
  });

  it("does not treat a failed checkpoint write as durable progress", async () => {
    await expect(
      runRepairController(fixture(), {
        executor,
        checkpoint: async () => {
          throw new Error("disk full");
        },
      }),
    ).rejects.toThrow("disk full");
  });

  it("freezes endpoint, schema, operation inventory, auth and approval state", () => {
    const baseline = fixture();
    for (const mutate of [
      (air: ReturnType<typeof fixture>) => {
        air.operations[0]!.sourceRef.path = "/wrong";
      },
      (air: ReturnType<typeof fixture>) => {
        air.operations[0]!.state = "approved";
      },
      (air: ReturnType<typeof fixture>) => {
        air.operations[0]!.input.params[0]!.required = false;
      },
      (air: ReturnType<typeof fixture>) => {
        air.operations[0]!.auth.scopes.push("admin");
      },
      (air: ReturnType<typeof fixture>) => {
        air.operations.length = 0;
      },
    ]) {
      const changed = structuredClone(baseline);
      mutate(changed);
      expect(repairInvariantHash(changed)).not.toBe(repairInvariantHash(baseline));
    }
  });
});
