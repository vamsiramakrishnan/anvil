import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type BusinessEvaluator,
  BusinessJobs,
  buildBusinessProject,
  businessProjectView,
  listBusinessProjects,
  readBusinessProject,
  saveBusinessProject,
} from "@anvil/harness";
import type { Command } from "commander";
import type { CommandContext } from "../context.js";
import { annotate } from "../meta.js";

export async function loadBusinessEvaluator(path: string): Promise<BusinessEvaluator> {
  const module = await import(pathToFileURL(resolve(path)).href);
  const evaluator = module.default as BusinessEvaluator;
  if (
    !evaluator ||
    typeof evaluator.fixture !== "function" ||
    typeof evaluator.agent?.execute !== "function"
  )
    throw new Error("Evaluator module must default-export a BusinessEvaluator.");
  return evaluator;
}
export function registerBusinessProject(parent: Command, ctx: CommandContext): void {
  const command = annotate(
    parent
      .command("project")
      .summary("Author, build, and evaluate versioned business capability projects."),
    { mutates: false },
  );
  const output = (value: unknown) => ctx.io.out(JSON.stringify(value, null, 2));
  const run = (work: () => unknown) => {
    try {
      output(work());
    } catch (e) {
      ctx.io.err(e instanceof Error ? e.message : String(e));
      ctx.code = 1;
    }
  };
  annotate(
    command
      .command("list")
      .argument("<workspace>")
      .summary("List business projects in a workspace."),
    { mutates: false },
  ).action((root: string) => run(() => listBusinessProjects(resolve(root))));
  annotate(
    command
      .command("show")
      .argument("<workspace>")
      .argument("<id>")
      .option("--against <digest>", "compare with a saved revision")
      .summary("Inspect the public contract, private bindings, and semantic change impact."),
    { mutates: false },
  ).action((root: string, id: string, opts: { against?: string }) =>
    run(() =>
      businessProjectView(
        readBusinessProject(resolve(root), id),
        opts.against ? readBusinessProject(resolve(root), id, opts.against) : undefined,
      ),
    ),
  );
  annotate(
    command
      .command("save")
      .argument("<workspace>")
      .argument("<file>", "project JSON: definition, source AIR snapshots, held-out tasks")
      .option("--expected <digest>", "current revision digest; omit only for a new project")
      .summary(
        "Validate and save an immutable project revision without replacing concurrent edits.",
      ),
    { mutates: true },
  ).action((root: string, file: string, opts: { expected?: string }) =>
    run(() =>
      saveBusinessProject(
        resolve(root),
        JSON.parse(readFileSync(resolve(file), "utf8")),
        opts.expected ?? null,
      ),
    ),
  );
  annotate(
    command
      .command("build")
      .argument("<workspace>")
      .argument("<id>")
      .requiredOption("--expected <digest>", "reviewed project revision")
      .summary("Build all agent surfaces from one exact business project revision."),
    { mutates: true },
  ).action((root: string, id: string, opts: { expected: string }) =>
    run(() => buildBusinessProject(resolve(root), id, opts.expected)),
  );
  annotate(
    command
      .command("evaluate")
      .argument("<workspace>")
      .argument("<id>")
      .requiredOption("--expected <digest>", "reviewed project revision")
      .requiredOption(
        "--adapter <module>",
        "trusted operator-owned evaluator module; executed locally",
      )
      .option("--repeats <count>", "repeated trials per task and lane", "3")
      .summary(
        "Compare raw tools, business MCP, and business MCP with a skill using independent fixture oracles.",
      ),
    { mutates: true },
  ).action(
    async (
      root: string,
      id: string,
      opts: { expected: string; adapter: string; repeats: string },
    ) => {
      let jobs: BusinessJobs | undefined;
      const cancel = () => jobs?.close();
      try {
        jobs = new BusinessJobs(resolve(root), await loadBusinessEvaluator(opts.adapter));
        const submitted = jobs.submit(id, opts.expected, Number(opts.repeats));
        process.once("SIGINT", cancel);
        process.once("SIGTERM", cancel);
        let job = jobs.get(id, submitted.id);
        while (["queued", "running"].includes(job.status)) {
          await new Promise((r) => setTimeout(r, 100));
          job = jobs.get(id, submitted.id);
        }
        output(job);
        if (job.status !== "completed" || job.report?.trials.some((t) => t.run.status !== "passed"))
          ctx.code = 1;
      } catch (e) {
        ctx.io.err(e instanceof Error ? e.message : String(e));
        ctx.code = 1;
      } finally {
        jobs?.close();
        process.off("SIGINT", cancel);
        process.off("SIGTERM", cancel);
      }
    },
  );
  annotate(
    command
      .command("jobs")
      .argument("<workspace>")
      .argument("<id>")
      .summary("Inspect persisted evaluation jobs and replayable failure traces."),
    { mutates: false },
  ).action((root: string, id: string) => run(() => new BusinessJobs(resolve(root)).list(id)));
}
