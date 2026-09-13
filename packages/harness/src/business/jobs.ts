import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import {
  type BusinessComparisonReport,
  type BusinessComparisonTrial,
  type BusinessEvaluator,
  compareBusinessProject,
} from "./comparison.js";
import {
  atomicBusinessJson,
  businessProjectPath,
  projectDirectory,
  readBusinessProject,
} from "./project.js";

export interface BusinessJob {
  id: string;
  project: string;
  projectDigest: string;
  owner: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
  startedAt: string;
  finishedAt?: string;
  completedTrials: number;
  trials: BusinessComparisonTrial[];
  report?: BusinessComparisonReport;
  message?: string;
}
/** Bounded local evaluation worker. Operator-supplied adapter; requests cannot choose executable code. */
export class BusinessJobs {
  private readonly owner = randomUUID();
  private readonly active = new Map<string, AbortController>();
  constructor(
    private readonly root: string,
    private readonly evaluator?: BusinessEvaluator,
  ) {}
  get enabled(): boolean {
    return this.evaluator !== undefined;
  }
  private path(project: string, id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid evaluation job id.");
    return businessProjectPath(this.root, projectDirectory(this.root, project), `jobs/${id}.json`);
  }
  list(project: string): BusinessJob[] {
    const dir = businessProjectPath(this.root, projectDirectory(this.root, project), "jobs");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((n) => /^[a-f0-9-]{36}\.json$/.test(n))
      .map((n) => this.get(project, n.slice(0, -5)))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
  get(project: string, id: string): BusinessJob {
    const job = JSON.parse(readFileSync(this.path(project, id), "utf8")) as BusinessJob;
    if (job.project !== project || job.id !== id)
      throw new Error("Evaluation job identity mismatch.");
    if (["queued", "running"].includes(job.status) && job.owner !== this.owner)
      return {
        ...job,
        status: "interrupted",
        message:
          "This process does not own the worker. Inspect the prior process before starting another evaluation.",
      };
    return job;
  }
  submit(project: string, digest: string, repeats = 3): BusinessJob {
    if (!this.evaluator)
      throw new Error("Start the console with an operator-owned business evaluator module.");
    if (this.active.size >= 1)
      throw new Error("An evaluation is already running. Wait or cancel it first.");
    if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20)
      throw new Error("Use 1 to 20 evaluation repetitions.");
    const revision = readBusinessProject(this.root, project);
    if (revision.digest !== digest) throw new Error("Project changed. Reload before evaluating.");
    const job: BusinessJob = {
      id: randomUUID(),
      project,
      projectDigest: digest,
      owner: this.owner,
      status: "queued",
      startedAt: new Date().toISOString(),
      completedTrials: 0,
      trials: [],
    };
    const controller = new AbortController();
    const path = this.path(project, job.id);
    atomicBusinessJson(path, job);
    this.active.set(job.id, controller);
    const evaluator = this.evaluator;
    void Promise.resolve()
      .then(async () => {
        job.status = "running";
        atomicBusinessJson(path, job);
        try {
          job.report = await compareBusinessProject(revision, evaluator, {
            repeats,
            signal: controller.signal,
            onTrial: (trial) => {
              job.trials.push(trial);
              job.completedTrials++;
              atomicBusinessJson(path, job);
            },
          });
          job.status = controller.signal.aborted ? "cancelled" : "completed";
        } catch {
          job.status = controller.signal.aborted ? "cancelled" : "failed";
          job.message =
            "Evaluation could not complete. Check the adapter, approved actions, and held-out tasks.";
        } finally {
          job.finishedAt = new Date().toISOString();
          try {
            atomicBusinessJson(path, job);
          } finally {
            this.active.delete(job.id);
          }
        }
      })
      .catch(() => {
        this.active.delete(job.id);
      });
    return { ...job };
  }
  cancel(project: string, id: string): BusinessJob {
    const job = this.get(project, id);
    const active = this.active.get(id);
    if (!active) throw new Error("This process does not own an active job with that id.");
    active.abort();
    return { ...job, message: "Cancellation requested; waiting for fixture cleanup." };
  }
  close(): void {
    for (const controller of this.active.values()) controller.abort();
  }
}
