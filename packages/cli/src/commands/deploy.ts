import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import type { CliIO } from "../io.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";

/** `anvil deploy cloud-run <dir>` — print the Cloud Run deployment plan. */
export function registerDeploy(parent: Command, ctx: CommandContext): void {
  const deploy = annotate(
    parent
      .command("deploy")
      .summary("Print the Cloud Run deployment plan for a bundle.")
      .description(
        "Anvil generates the deploy artifacts (Dockerfile, service YAML, env/secret contracts); it does not hold cloud credentials.",
      ),
    { mutates: false },
  );

  deploy
    .command("cloud-run")
    .summary("The Cloud Run deployment plan (Terraform owns config, Cloud Build the pipeline).")
    .argument("<dir>", "bundle directory containing deploy/ artifacts")
    .option("--env <env>", "target environment", "prod")
    .action((dir: string, opts: { env: string }) => {
      ctx.code = runDeployCloudRun(dir, opts, ctx.io);
    });
}

function runDeployCloudRun(dir: string, opts: { env: string }, io: CliIO): number {
  const deployDir = join(dir, "deploy");
  if (!existsSync(join(deployDir, "Dockerfile"))) {
    io.err(`No deploy artifacts at ${deployDir}. Run \`anvil compile\` first.`);
    return 1;
  }
  printCloudRunPlan(dir, opts.env, io);
  return 0;
}

/**
 * The Cloud Run deployment plan — shared with the gated `anvil publish`, which
 * prints the same steps after verifying the certification.
 */
export function printCloudRunPlan(dir: string, env: string, io: CliIO): void {
  const deployDir = join(dir, "deploy");
  io.out(`Deployment plan for '${env}' (artifacts in ${deployDir}):`);
  io.out("Prereqs (shared, once per project): Artifact Registry repo, Terraform");
  io.out("  state bucket, and — when a durable ledger is needed — the Firestore");
  io.out("  (default) database. See deploy/README.md.");
  io.out("  1. gcloud builds submit --config deploy/cloudbuild.yaml \\");
  io.out(`       --substitutions _ANVIL_ENV=${env},_TF_STATE_BUCKET=<bucket>`);
  io.out("     → builds + pushes the image, then runs `terraform plan` (no auto-apply).");
  io.out("  2. Review the published plan; secrets are declared in");
  io.out("     deploy/secrets.required.yaml (Secret Manager, provisioned by Terraform).");
  io.out("  3. terraform apply tfplan   (promoted, behind review; dev may auto-apply)");
  io.out("Anvil generates the artifacts; it does not hold your cloud credentials.");
}
