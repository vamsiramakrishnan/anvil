import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  bundleHash,
  PUBLICATION_FILE,
  type PublicationRecord,
  readBundleDir,
  verifyCertification,
} from "@anvil/generators";
import { loadBundleAir, resolveBundleDir } from "./cmd-certify.js";
import type { CliIO } from "./io.js";

/**
 * `anvil publish <dir> --target cloud-run [--env ENV] [--allow-uncertified]` —
 * the gated publish. Publication here holds no cloud credentials and makes no
 * API calls; it means exactly: a verified passing certification for the CURRENT
 * bundle bytes, the deploy plan emitted (the artifacts `anvil compile` already
 * generated), and a publication record written into the bundle.
 *
 * Gate policy: an uncertified/stale bundle refuses to publish. The
 * `--allow-uncertified` waiver applies to non-prod envs only — prod FAILS
 * CLOSED, always, so no flag combination can push unverified artifacts to prod.
 */
export function cmdPublish(
  args: string[],
  flags: Record<string, string | boolean>,
  io: CliIO,
  deps: { now?: () => string; env?: NodeJS.ProcessEnv } = {},
): number {
  const path = args[0];
  const target = flags.target as string | undefined;
  if (!path || target !== "cloud-run") {
    io.err("Usage: anvil publish <dir> --target cloud-run [--env ENV] [--allow-uncertified]");
    return 1;
  }
  const processEnv = deps.env ?? process.env;
  const env = typeof flags.env === "string" ? flags.env : (processEnv.ANVIL_ENV ?? "dev");
  const allowUncertified = flags["allow-uncertified"] === true;

  const dir = resolveBundleDir(path);
  const files = readBundleDir(dir);
  const air = loadBundleAir(dir, files);

  // The certification gate: passing status AND a hash match against the bytes
  // on disk right now. A cert for yesterday's bundle proves nothing about today's.
  const verdict = verifyCertification(files);
  let certification: PublicationRecord["certification"];
  if (verdict.ok) {
    certification = { status: "passed", certifiedAt: verdict.certification.certifiedAt };
  } else if (env === "prod") {
    // Fail closed: prod never accepts an uncertified publish, flag or no flag.
    io.err(
      JSON.stringify({
        error: {
          code: "uncertified_publish_refused",
          env,
          allowUncertified,
          reason: verdict.reason,
          remediation: "Run `anvil certify` on the bundle and re-publish; prod cannot be waived.",
        },
      }),
    );
    io.err(`anvil publish: refused — uncertified publish to prod (${verdict.reason}).`);
    return 1;
  } else if (allowUncertified) {
    io.err(
      `anvil publish: WARNING — publishing to '${env}' without certification (${verdict.reason}).`,
    );
    certification = { status: "waived", reason: verdict.reason };
  } else {
    io.err(`anvil publish: refused — ${verdict.reason}.`);
    io.err("Certify the bundle, or pass --allow-uncertified for a non-prod environment.");
    return 1;
  }

  // The deploy artifacts are the generator's output; publish only verifies and
  // presents them — the same plan `anvil deploy cloud-run` prints.
  const missing = DEPLOY_ARTIFACTS.filter((rel) => files[rel] === undefined);
  if (missing.length > 0) {
    io.err(
      `anvil publish: deploy artifacts missing (${missing.join(", ")}). Run \`anvil compile\` first.`,
    );
    return 1;
  }

  const record: PublicationRecord = {
    schemaVersion: 1,
    serviceId: air.service.id,
    target: "cloud-run",
    env,
    bundleHash: bundleHash(files),
    certification,
    publishedAt: (deps.now ?? (() => new Date().toISOString()))(),
    artifacts: [...DEPLOY_ARTIFACTS],
  };
  writeFileSync(join(dir, PUBLICATION_FILE), `${JSON.stringify(record, null, 2)}\n`, "utf8");

  if (flags.json === true) {
    io.out(JSON.stringify(record, null, 2));
    return 0;
  }
  io.out(
    `Published ${air.service.id} → cloud-run ('${env}')  bundle ${record.bundleHash.slice(0, 12)}…  ` +
      (certification.status === "passed"
        ? `certified ${certification.certifiedAt}`
        : "UNCERTIFIED (waived)"),
  );
  io.out(`Publication record: ${join(dir, PUBLICATION_FILE)}`);
  printCloudRunPlan(dir, env, io);
  return 0;
}

/** The deploy artifacts a publication points at (emitted by `anvil compile`). */
const DEPLOY_ARTIFACTS = [
  "deploy/Dockerfile",
  "deploy/cloudbuild.yaml",
  "deploy/terraform/main.tf",
  "deploy/terraform/variables.tf",
  "deploy/env.schema.json",
  "deploy/secrets.required.yaml",
  "deploy/README.md",
] as const;

/**
 * The Cloud Run deployment plan — the same steps `anvil deploy cloud-run`
 * prints (Terraform owns infra+config, Cloud Build owns the pipeline).
 */
function printCloudRunPlan(dir: string, env: string, io: CliIO): void {
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
