import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  bundleHash,
  PUBLICATION_FILE,
  type PublicationRecord,
  readBundleDir,
  verifyCertification,
} from "@anvil/generators";
import { type Command, Option } from "commander";
import type { CliIO } from "../io.js";
import { loadBundleAir, resolveBundleDir } from "./certify.js";
import type { CommandContext } from "./context.js";
import { printCloudRunPlan } from "./deploy.js";
import { annotate } from "./meta.js";

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
export function registerPublish(parent: Command, ctx: CommandContext): void {
  annotate(
    parent
      .command("publish")
      .summary("Gated publish: verify the certification, then emit the deployment plan.")
      .description(
        "Publication requires a PASSING certification whose bundle hash matches the current bundle content — a stale certificate fails. On success it prints the Cloud Run deployment plan (same as `anvil deploy cloud-run`) and writes publication.json into the bundle. `--allow-uncertified` waives the gate for non-prod environments only; publishing to prod (via --env prod or ANVIL_ENV=prod) fails closed without a valid certification, flag or no flag. No cloud credentials are held and no API calls are made.",
      )
      .argument("<dir>", "bundle directory")
      .addOption(
        new Option("--target <target>", "publish target")
          .choices(["cloud-run"])
          .makeOptionMandatory(),
      )
      .addOption(
        new Option("--env <env>", "target environment (default from ANVIL_ENV, else dev)").choices([
          "dev",
          "staging",
          "prod",
        ]),
      )
      .option("--allow-uncertified", "waive the certification gate (non-prod only)")
      .option("--json", "emit the publication record as JSON")
      .action((dir: string, opts: PublishOptions) => {
        ctx.code = runPublish(dir, opts, ctx.io);
      }),
    { mutates: true },
  );
}

export interface PublishOptions {
  target: "cloud-run";
  env?: string;
  allowUncertified?: boolean;
  json?: boolean;
}

/** The publish action, exported with injectable clock/env so tests can pin both. */
export function runPublish(
  path: string,
  opts: PublishOptions,
  io: CliIO,
  deps: { now?: () => string; env?: NodeJS.ProcessEnv } = {},
): number {
  const processEnv = deps.env ?? process.env;
  const env = opts.env ?? processEnv.ANVIL_ENV ?? "dev";
  const allowUncertified = opts.allowUncertified === true;

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

  if (opts.json === true) {
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
