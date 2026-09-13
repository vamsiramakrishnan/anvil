import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashCanonical } from "@anvil/air";
import { compileBusiness } from "@anvil/compiler";
import type { AgentAdapter } from "@anvil/fuzz";
import { afterEach, describe, expect, it } from "vitest";
import { type BusinessEvaluator, compareBusinessProject } from "./comparison.js";
import { businessFixtureContract } from "./fixture.js";
import { businessImpact } from "./impact.js";
import { buildBusinessProject, readBusinessProject, saveBusinessProject } from "./project.js";

const directories: string[] = [];
function workspace() {
  const root = mkdtempSync(join(tmpdir(), "anvil-business-project-"));
  directories.push(root);
  return root;
}
function project() {
  const fixture = businessFixtureContract();
  return {
    schemaVersion: 1 as const,
    definition: fixture.plan.definition,
    sources: fixture.plan.sources,
    tasks: [
      {
        id: "return",
        action: "complete_return",
        prompt: "Complete this return.",
        fixture: {},
        expected: {},
      },
    ],
  };
}
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
describe("business project workflow", () => {
  it("preserves revisions and refuses stale saves or builds", () => {
    const root = workspace(),
      first = saveBusinessProject(root, project(), null);
    const next = structuredClone(first.project);
    next.definition.actions[0]!.description = "Revised outcome";
    const second = saveBusinessProject(root, next, first.digest);
    expect(second.digest).not.toBe(first.digest);
    expect(readBusinessProject(root, next.definition.id, first.digest)).toEqual(first);
    expect(() => saveBusinessProject(root, next, first.digest)).toThrow(/changed/);
    expect(() => buildBusinessProject(root, next.definition.id, first.digest)).toThrow(/changed/);
    const built = buildBusinessProject(root, next.definition.id, second.digest);
    const publicAir = JSON.parse(readFileSync(join(root, built.bundleId, "air.json"), "utf8"));
    expect(publicAir.business.planDigest).toBe(
      compileBusiness(next.definition, next.sources).plan.digest,
    );
    expect(JSON.stringify(publicAir)).not.toContain("wire_order_id");
    expect(() => buildBusinessProject(root, next.definition.id, second.digest)).toThrow();
  });
  it("refuses traversal and symlinked project roots", () => {
    const root = workspace(),
      outside = workspace();
    symlinkSync(outside, join(root, ".anvil"));
    expect(() => saveBusinessProject(root, project(), null)).toThrow(/symlink/);
    expect(() => readBusinessProject(root, "../../outside")).toThrow(/Invalid/);
  });
  it("follows only dependent source operations and distinguishes authority from public inputs", () => {
    const before = project(),
      after = structuredClone(before);
    after.definition.actions[0]!.steps[0]!.authority = "New reviewed authority";
    const report = businessImpact(before, after);
    expect(report.find((r) => r.action === "complete_return")).toMatchObject({
      changes: expect.arrayContaining(["authority"]),
      approvalRenewal: true,
      evaluations: ["return"],
    });
    expect(report.find((r) => r.action === "grant_account_access")?.changes).toEqual([]);
    expect(report.find((r) => r.action === "complete_return")?.changes).not.toContain("input");
  });
  it("does not count agent claims as success and holds seed/configuration constant across lanes", async () => {
    const p = project(),
      seen: Array<{ seed: number; lane: string }> = [];
    const agent: AgentAdapter = {
      id: "scripted-test",
      metadata: { model: "no-model" },
      async execute(task, invoke) {
        await invoke(task.catalog[0]!.operation, {});
      },
    };
    const evaluator: BusinessEvaluator = {
      id: "independent-test",
      version: "1",
      agent,
      async fixture(_p, _task, seed, lane) {
        seen.push({ seed, lane });
        return {
          driver: {
            id: lane,
            async open() {
              return {
                async invoke() {
                  return {
                    status: "ok",
                    value: { claimed_success: true },
                    effects: { refunds: 0 },
                  };
                },
                async close() {},
              };
            },
          },
          properties: [
            () => [
              { id: "terminal-state", status: "failed", detail: "Backend refund did not happen." },
            ],
          ],
        };
      },
    };
    const report = await compareBusinessProject(
      { project: p, digest: hashCanonical(p) },
      evaluator,
      { repeats: 2, seed: 7 },
    );
    expect(report.trials).toHaveLength(6);
    expect(report.summary.every((s) => s.failed === 2 && s.passed === 0)).toBe(true);
    expect(seen.filter((s) => s.seed === 7)).toHaveLength(3);
    expect(seen.filter((s) => s.seed === 8)).toHaveLength(3);
    expect(report.tokens).toBeNull();
    expect(report.trials.every((t) => t.run.replay)).toBe(true);
  });
});
