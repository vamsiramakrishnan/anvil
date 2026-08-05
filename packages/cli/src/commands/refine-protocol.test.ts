import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { airToYaml, loadAirDocument } from "@anvil/air";
import { afterEach, describe, expect, it } from "vitest";
import { runAnvilCli } from "../anvil-cli.js";
import { bufferIO } from "../io.js";

const DESCRIPTION = "Customer-facing explanation stored with the refund and shown on the receipt.";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "anvil-refine-protocol-cli-"));
  dirs.push(root);
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
  const air = loadAirDocument({
    service: {
      id: "payments",
      displayName: "Payments",
      version: "1",
      source: { kind: "openapi", uri: "./openapi.yaml" },
    },
    operations: [
      {
        id: "payments.refunds.create",
        canonicalName: "create_refund",
        displayName: "Create refund",
        description: "Create a refund.",
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
  const airPath = join(root, "air.yaml");
  writeFileSync(airPath, airToYaml(air));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "anvil@example.test"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Anvil Test"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
  return { root, airPath };
}

async function refine(...args: string[]) {
  const io = bufferIO();
  const code = await runAnvilCli(["refine", ...args], { io });
  return { code, io };
}

describe("anvil refine portable harness protocol", () => {
  it("exports a task and imports a harness response into the normal pack layout", async () => {
    const { root, airPath } = fixture();
    const taskPath = join(root, ".anvil", "task.json");
    const exported = await refine(
      "export-task",
      airPath,
      "field:payments.refunds.create#input.body.reason",
      "--repo-root",
      root,
      "--inspect",
      "src,test",
      "--skill",
      "describe-field",
      "--out",
      taskPath,
    );
    expect(exported.code, exported.io.text()).toBe(0);
    const task = JSON.parse(readFileSync(taskPath, "utf8"));
    expect(task.taskId).toMatch(/^rt_/);

    const submissionPath = join(root, ".anvil", "submission.json");
    writeFileSync(
      submissionPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          taskId: task.taskId,
          taskHash: task.taskHash,
          executor: { name: "codex" },
          status: "proposal_generated",
          summary: "Handler and contract test agree.",
          evidence: [
            { id: "impl", kind: "repository", source: "source_impl", path: "src/refund.ts" },
            {
              id: "test",
              kind: "repository",
              source: "test_fixture",
              path: "test/refund.test.ts",
            },
          ],
          claims: [
            { predicate: "field.description", value: DESCRIPTION, evidenceId: "impl" },
            { predicate: "field.description", value: DESCRIPTION, evidenceId: "test" },
          ],
          patch: { set: { description: DESCRIPTION } },
        },
        null,
        2,
      )}\n`,
    );
    const packDir = join(root, ".anvil", "pack");
    const imported = await refine(
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
    expect(imported.code).toBe(0);
    expect(JSON.parse(imported.io.stdout[0] ?? "{}")).toMatchObject({ ok: true });
    for (const file of [
      "pack.json",
      "review.md",
      "harness-tasks.json",
      "harness-submissions.json",
      "harness-evidence.json",
    ]) {
      expect(existsSync(join(packDir, file)), file).toBe(true);
    }
  });

  it("prints a stable JSON rejection for a tampered task", async () => {
    const { root, airPath } = fixture();
    const taskPath = join(root, "task.json");
    const exported = await refine(
      "export-task",
      airPath,
      "field:payments.refunds.create#input.body.reason",
      "--repo-root",
      root,
      "--skill",
      "describe-field",
      "--out",
      taskPath,
    );
    expect(exported.code, exported.io.text()).toBe(0);
    const task = JSON.parse(readFileSync(taskPath, "utf8"));
    task.context.tampered = true;
    writeFileSync(taskPath, `${JSON.stringify(task, null, 2)}\n`);
    const submissionPath = join(root, "decline.json");
    writeFileSync(
      submissionPath,
      `${JSON.stringify({
        schemaVersion: 1,
        taskId: task.taskId,
        taskHash: task.taskHash,
        executor: { name: "codex" },
        status: "insufficient_evidence",
        summary: "No evidence.",
        evidence: [],
        claims: [],
      })}\n`,
    );

    const result = await refine(
      "import-proposal",
      airPath,
      taskPath,
      submissionPath,
      "--repo-root",
      root,
      "--out",
      join(root, "pack"),
      "--json",
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.io.stdout[0] ?? "{}")).toMatchObject({
      schemaVersion: 1,
      reportType: "anvil.refinement-harness-import-error",
      ok: false,
      code: "refinement/task_integrity_failed",
      stage: "task",
    });
  });
});
