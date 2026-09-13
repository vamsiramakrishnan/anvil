import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { businessFixtureContract } from "./fixture.js";
import { BusinessJobs } from "./jobs.js";
import { saveBusinessProject } from "./project.js";

it("persists completed trials before finishing, bounds workers, and cancels with fixture cleanup", async () => {
  const root = mkdtempSync(join(tmpdir(), "anvil-business-jobs-"));
  const fixture = businessFixtureContract();
  const revision = saveBusinessProject(
    root,
    {
      schemaVersion: 1,
      definition: fixture.plan.definition,
      sources: fixture.plan.sources,
      tasks: [{ id: "return", action: "complete_return", prompt: "Complete the return." }],
    },
    null,
  );
  let calls = 0;
  const close = vi.fn(async () => {});
  const jobs = new BusinessJobs(root, {
    id: "job-test",
    version: "1",
    agent: {
      id: "scripted",
      metadata: { model: "none" },
      async execute(task, invoke, signal) {
        const operation = task.catalog[0]?.operation;
        if (!operation) throw new Error("Expected a tool");
        await invoke(operation, {});
        if (++calls === 2)
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
      },
    },
    async fixture() {
      return {
        driver: {
          id: "owned",
          async open() {
            return {
              async invoke() {
                return { status: "ok" as const, value: {}, effects: {} };
              },
              close,
            };
          },
        },
        properties: [
          () => [{ id: "terminal", status: "passed" as const, detail: "Fixture observed" }],
        ],
      };
    },
  });
  const id = revision.project.definition.id;
  try {
    const job = jobs.submit(id, revision.digest, 1);
    expect(() => jobs.submit(id, revision.digest, 1)).toThrow(/already running/);
    await vi.waitFor(() => expect(calls).toBe(2));
    expect(jobs.get(id, job.id)).toMatchObject({
      status: "running",
      completedTrials: 1,
      trials: [expect.objectContaining({ lane: "raw" })],
    });
    expect(new BusinessJobs(root).get(id, job.id)).toMatchObject({
      status: "interrupted",
      completedTrials: 1,
    });
    jobs.cancel(id, job.id);
    await vi.waitFor(() => expect(jobs.get(id, job.id).status).toBe("cancelled"));
    expect(close).toHaveBeenCalledTimes(2);
    expect(jobs.get(id, job.id).report?.trials).toHaveLength(2);
  } finally {
    jobs.close();
    rmSync(root, { recursive: true, force: true });
  }
});
