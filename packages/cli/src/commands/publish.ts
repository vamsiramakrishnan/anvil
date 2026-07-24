import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  bundleHash,
  type ExecutableEvidenceStatuses,
  executableEvidenceReady,
  executableEvidenceStatuses,
  PUBLICATION_FILE,
  type PublicationExecutableEvidence,
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
 * `anvil publish <dir> [--target cloud-run] [--env ENV]` prepares a gated
 * deployment plan. The compatibility verb "publish" does not publish or deploy
 * anything: it makes no cloud API calls.
 *
 * Gate policy: fresh static assurance plus fresh passing selftest, conformance,
 * and simulation reports are required. Static or executable evidence can be
 * explicitly waived for non-prod plans only; prod always fails closed.
 */
export function registerPublish(parent: Command, ctx: CommandContext): void {
  annotate(
    parent
      .command("publish")
      .summary("Prepare a gated deployment plan; make no cloud API calls.")
      .description(
        "Compatibility note: `publish` prepares a deployment plan; it does not publish, apply, deploy, or contact a cloud API. Fresh static assurance and fresh passing selftest, conformance, and simulation reports must all match the current bundle content. On success it prints the Cloud Run operator plan and writes publication.json with the evidence snapshot. `--allow-uncertified` and `--allow-incomplete-evidence` are explicit non-prod-only waivers; prod always fails closed. Cloud Run is the sole target and therefore the default.",
      )
      .argument("<dir>", "bundle directory")
      .addOption(
        new Option("--target <target>", "publish target")
          .choices(["cloud-run"])
          .default("cloud-run"),
      )
      .addOption(
        new Option("--env <env>", "target environment (default from ANVIL_ENV, else dev)").choices([
          "dev",
          "staging",
          "prod",
        ]),
      )
      .option("--allow-uncertified", "waive static assurance for this plan (non-prod only)")
      .option(
        "--allow-incomplete-evidence",
        "waive missing, stale, corrupt, or failing executable evidence (non-prod only)",
      )
      .option("--json", "emit the publication record as JSON")
      .action((dir: string, opts: PublishOptions) => {
        ctx.code = runPublish(dir, opts, ctx.io);
      }),
    { mutates: true },
  );
}

export interface PublishOptions {
  target?: "cloud-run";
  env?: string;
  allowUncertified?: boolean;
  allowIncompleteEvidence?: boolean;
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
  const requestedEnv = opts.env ?? processEnv.ANVIL_ENV ?? "dev";
  if (!isPublicationEnvironment(requestedEnv)) {
    io.err(
      JSON.stringify({
        error: {
          code: "invalid_deployment_environment",
          env: requestedEnv,
          allowed: ["dev", "staging", "prod"],
          remediation: "Set --env or ANVIL_ENV to dev, staging, or prod.",
        },
      }),
    );
    io.err(
      `anvil publish: refused — invalid deployment environment '${requestedEnv}'; expected dev, staging, or prod.`,
    );
    return 1;
  }
  const env = requestedEnv;
  const allowUncertified = opts.allowUncertified === true;
  const allowIncompleteEvidence = opts.allowIncompleteEvidence === true;

  const dir = resolveBundleDir(path);
  const files = readBundleDir(dir);
  const air = loadBundleAir(dir, files);
  const currentBundleHash = bundleHash(files);

  // Static assurance must pass and match the bytes on disk right now. A record
  // for yesterday's bundle proves nothing about today's deployment plan.
  const verdict = verifyCertification(files);
  let certification: PublicationRecord["certification"];
  if (verdict.ok) {
    certification = {
      status: "passed",
      certifiedAt: verdict.certification.certifiedAt,
      assuranceLevel: "static",
    };
  } else if (env === "prod") {
    // Fail closed: prod never accepts a plan without current assurance.
    io.err(
      JSON.stringify({
        error: {
          code: "uncertified_publish_refused",
          env,
          allowUncertified,
          reason: verdict.reason,
          remediation:
            "Run `anvil certify` on the bundle and prepare the plan again; prod cannot be waived.",
        },
      }),
    );
    io.err(`anvil publish: refused — prod deployment plan lacks assurance (${verdict.reason}).`);
    return 1;
  } else if (allowUncertified) {
    io.err(
      `anvil publish: WARNING — preparing a '${env}' plan without static assurance (${verdict.reason}).`,
    );
    certification = { status: "waived", reason: verdict.reason };
  } else {
    io.err(`anvil publish: plan refused — ${verdict.reason}.`);
    io.err("Certify the bundle, or pass --allow-uncertified for a non-prod environment.");
    return 1;
  }

  const evidenceStatuses = executableEvidenceStatuses(files, currentBundleHash);
  const evidenceReady = executableEvidenceReady(evidenceStatuses);
  const evidenceReason = Object.values(evidenceStatuses)
    .filter((status) => status.state !== "fresh" || status.passed !== true)
    .map((status) => `${status.lane}: ${status.detail}`)
    .join(" ");
  let executableEvidence: PublicationExecutableEvidence;
  if (evidenceReady) {
    executableEvidence = {
      status: "passed",
      records: {
        selftest: passingEvidenceSnapshot("selftest", evidenceStatuses.selftest),
        conformance: passingEvidenceSnapshot("conformance", evidenceStatuses.conformance),
        simulation: passingEvidenceSnapshot("simulation", evidenceStatuses.simulation),
      },
    };
  } else if (env === "prod") {
    io.err(
      JSON.stringify({
        error: {
          code: "incomplete_executable_evidence_refused",
          env,
          allowIncompleteEvidence,
          evidence: evidenceStatuses,
          remediation:
            "Run `anvil selftest`, `anvil conformance`, and `anvil simulate` on the current bundle; prod cannot be waived.",
        },
      }),
    );
    io.err(`anvil publish: refused — prod deployment plan lacks executable proof.`);
    return 1;
  } else if (allowIncompleteEvidence) {
    io.err(
      `anvil publish: WARNING — preparing a '${env}' plan with incomplete executable evidence (${evidenceReason}).`,
    );
    executableEvidence = {
      status: "waived",
      records: evidenceStatuses,
      waiver: {
        flag: "--allow-incomplete-evidence",
        reason: evidenceReason,
      },
    };
  } else {
    io.err(`anvil publish: plan refused — executable evidence is incomplete.`);
    for (const status of Object.values(evidenceStatuses)) {
      if (status.state === "fresh" && status.passed === true) continue;
      io.err(`  ${status.lane}: ${status.detail}`);
    }
    io.err(
      "Run `anvil selftest`, `anvil conformance`, and `anvil simulate`, or pass --allow-incomplete-evidence for a non-prod environment.",
    );
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
    schemaVersion: 2,
    serviceId: air.service.id,
    target: "cloud-run",
    env,
    bundleHash: currentBundleHash,
    certification,
    executableEvidence,
    recordKind: "deployment_plan",
    plannedAt: (deps.now ?? (() => new Date().toISOString()))(),
    cloudCallsMade: false,
    operatorActionRequired: true,
    artifacts: [...DEPLOY_ARTIFACTS],
  };
  writeFileSync(join(dir, PUBLICATION_FILE), `${JSON.stringify(record, null, 2)}\n`, "utf8");

  if (opts.json === true) {
    io.out(JSON.stringify(record, null, 2));
    return 0;
  }
  io.out(
    `Deployment plan prepared for ${air.service.id} → cloud-run ('${env}')  bundle ${record.bundleHash.slice(0, 12)}…  ` +
      (certification.status === "passed"
        ? `static assurance ${certification.certifiedAt}`
        : "UNCERTIFIED (waived)") +
      (executableEvidence.status === "passed"
        ? " · executable evidence passed"
        : " · EXECUTABLE EVIDENCE WAIVED"),
  );
  io.out(`Plan record: ${join(dir, PUBLICATION_FILE)}`);
  io.out("No cloud call was made. Operator review and apply are still required.");
  printCloudRunPlan(dir, env, io);
  return 0;
}

type PassingEvidenceRecords = Extract<
  PublicationExecutableEvidence,
  { status: "passed" }
>["records"];

function passingEvidenceSnapshot<Lane extends keyof PassingEvidenceRecords>(
  _lane: Lane,
  status: ExecutableEvidenceStatuses[Lane],
): PassingEvidenceRecords[Lane] {
  if (status.state !== "fresh" || !status.fresh || status.passed !== true || !status.bundleHash) {
    throw new Error(`Internal error: ${status.lane} is not fresh passing evidence.`);
  }
  return {
    ...status,
    state: "fresh",
    fresh: true,
    passed: true,
    bundleHash: status.bundleHash,
  } as PassingEvidenceRecords[Lane];
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

type PublicationEnvironment = "dev" | "staging" | "prod";

function isPublicationEnvironment(value: string): value is PublicationEnvironment {
  return value === "dev" || value === "staging" || value === "prod";
}
