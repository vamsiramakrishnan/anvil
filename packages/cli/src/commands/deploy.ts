import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Command } from "commander";
import type { CliIO } from "../io.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";
import { loadAir } from "./shared.js";

/** `anvil deploy cloud-run <dir>` — print the Cloud Run deployment plan. */
export function registerDeploy(parent: Command, ctx: CommandContext): void {
  const deploy = annotate(
    parent
      .command("deploy")
      .summary("Print the Cloud Run deployment plan for a bundle.")
      .description(
        "Anvil generates the deploy artifacts (Dockerfile, Terraform, env/credential contracts); it does not hold cloud credentials.",
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

  deploy
    .command("credentials")
    .summary("The upstream (outbound) credential plan: exact env vars + copy-paste provisioning.")
    .description(
      "Prints, per auth shape, the exact ANVIL_<PROFILE>_* env vars the runtime resolver reads to reach the upstream — names only — with ready-to-run gcloud/terraform commands and a pre-assembled Secret Manager console link. Nothing here holds or echoes a secret value.",
    )
    .argument("<dir>", "bundle directory or air.yaml")
    .option("--env <env>", "auth profile / target environment", "prod")
    .requiredOption("--project <id>", "GCP project id for links and sm:// references")
    .option("--json", "emit one machine-readable credential plan")
    .option("--tfvars", "emit only Terraform auto-tfvars JSON for an external plan work directory")
    .action(
      async (
        dir: string,
        opts: { env: string; project: string; json?: boolean; tfvars?: boolean },
      ) => {
        ctx.code = await runDeployCredentials(dir, opts, ctx.io);
      },
    );
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
  io.out("Prereqs (shared, once per project): Artifact Registry repo and Terraform");
  io.out("  state bucket. When a durable ledger is needed, this bundle's Terraform");
  io.out("  creates its delete-protected named Firestore database. See deploy/README.md.");
  io.out("  1. Generate/review the external operator var-file (credentials + target");
  io.out("     settings), resolve every scaffold entry, then upload it to a private GCS URI.");
  io.out("  2. gcloud builds submit --config deploy/cloudbuild.yaml \\");
  io.out(
    `       --substitutions _REGION=<region>,_AR_REPO=<repo>,_ANVIL_ENV=${env},_TF_STATE_BUCKET=<state-bucket>,_TF_STATE_PREFIX=<state-prefix>,_TFVARS_URI=gs://<private-input-bucket>/operator.auto.tfvars.json`,
  );
  io.out("     → builds + pushes the image, then runs `terraform plan` (no auto-apply).");
  io.out("  3. Review the published plan; secrets are declared in");
  io.out("     deploy/credentials.required.yaml; secret values remain in operator-owned stores.");
  io.out("  4. terraform apply tfplan   (the exact reviewed plan, behind approval)");
  io.out("Upstream (outbound) credentials: deploy/credentials.required.yaml, or run");
  io.out(
    `     \`anvil deploy credentials <dir> --env ${env} --project <PROJECT_ID>\` for provisioning.`,
  );
  io.out("Anvil generates the artifacts; it does not hold your cloud credentials.");
}

/**
 * The upstream credential plan — the "give me the opportunity to configure this
 * properly" surface. It resolves the exact env-var contract from AIR and prints
 * ready-to-run provisioning. NAMES ONLY: it never asks for or echoes a secret
 * value (the `gcloud versions add` step reads it from your own $SECRET_VALUE).
 */
async function runDeployCredentials(
  dir: string,
  opts: { env: string; project: string; json?: boolean; tfvars?: boolean },
  io: CliIO,
): Promise<number> {
  if (!isGcpProjectId(opts.project)) {
    io.err(
      "Invalid --project: expected a lowercase GCP project id (6-30 characters, starting with a letter and ending with a letter or digit).",
    );
    return 1;
  }
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(opts.env)) {
    io.err(
      "Invalid --env: expected a lowercase profile slug (1-32 characters, letters, digits, and hyphens).",
    );
    return 1;
  }
  let air: ReturnType<typeof loadAir>;
  try {
    air = loadAir(dir);
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    return 1;
  }
  const { credentialContract } = await import("@anvil/generators");
  const contract = credentialContract(air, opts.env);
  const project = opts.project;
  const bundleRoot = resolveBundleRoot(dir);
  const requirements = contract.requirements.map((requirement) => ({
    ...requirement,
    secrets: [...new Set(requirement.required.filter(isSecretKey))].map((envKey) => {
      const secretId = secretIdFor(contract.service, envKey);
      return {
        env: envKey,
        secretId,
        secretResource: `projects/${project}/secrets/${secretId}`,
        versionRef: `sm://projects/${project}/secrets/${secretId}/versions/latest`,
      };
    }),
  }));
  const secrets = [
    ...new Map(
      requirements.flatMap((requirement) =>
        requirement.secrets.map((secret) => [secret.env, secret] as const),
      ),
    ).values(),
  ];
  const refs = Object.fromEntries(secrets.map((secret) => [secret.env, secret.versionRef]));
  const ids = secrets.map((secret) => secret.secretResource);
  const requiredConfig = [
    ...new Set(
      requirements.flatMap((requirement) =>
        requirement.required.filter((key) => !isSecretKey(key)),
      ),
    ),
  ].sort();
  const configAlternatives = [
    ...new Set(
      requirements.flatMap((requirement) =>
        (requirement.requiredOneOf ?? []).length > 0
          ? [(requirement.requiredOneOf ?? []).map((option) => option.join(" + ")).join(" OR ")]
          : [],
      ),
    ),
  ].sort();
  const envScaffold = Object.fromEntries(requiredConfig.map((key) => [key, `REPLACE_ME_${key}`]));
  const unresolvedConfig = Object.fromEntries([
    ...requiredConfig.map((key) => [key, `Set ${key} in env to the reviewed non-secret value.`]),
    ...configAlternatives.map((choice, index) => [
      `choice_${index + 1}`,
      `Choose and set one complete option in env: ${choice}.`,
    ]),
  ]);
  const tfvars = {
    credential_secret_refs: refs,
    credential_secret_ids: ids,
    env: envScaffold,
    anvil_unresolved_config: unresolvedConfig,
  };

  if (opts.json === true && opts.tfvars === true) {
    io.err("Choose either --json or --tfvars, not both.");
    return 1;
  }
  if (opts.tfvars === true) {
    io.out(JSON.stringify(tfvars, null, 2));
    return 0;
  }

  if (opts.json === true) {
    io.out(
      JSON.stringify(
        {
          schemaVersion: 1,
          project,
          bundleRoot,
          contract,
          requirements,
          terraform: {
            directory: join(bundleRoot, "deploy", "terraform"),
            credentialSecretRefs: tfvars.credential_secret_refs,
            credentialSecretIds: tfvars.credential_secret_ids,
          },
        },
        null,
        2,
      ),
    );
    return 0;
  }

  if (contract.requirements.length === 0) {
    io.out(
      `No upstream credentials required for '${contract.service}' — the approved surface is auth: none.`,
    );
    return 0;
  }

  const prefix = `ANVIL_${opts.env.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
  io.out(`Upstream credential plan for '${contract.service}'`);
  io.out(`  profile: ${contract.profileEnvVar}=${opts.env}  →  ${prefix}_*`);
  io.out("");
  io.out(contract.secretReferences);
  io.out(contract.coarseOverride);
  io.out("");
  io.out(
    `Secret Manager console: https://console.cloud.google.com/security/secret-manager?project=${encodeURIComponent(project)}`,
  );
  io.out("");

  for (const r of requirements) {
    io.out(`● ${r.auth}   [resolver: ${r.resolver}]`);
    io.out(`  credential profile: ${r.profile}`);
    io.out(`  operations: ${r.operations.join(", ")}`);
    if (r.note) io.out(`  note: ${r.note}`);
    io.out("  required:");
    for (const k of r.required) {
      io.out(
        `    ${k}${isSecretKey(k) ? "   ← secret (provision + reference)" : "   ← config value"}`,
      );
    }
    if (r.required.length === 0) io.out("    (none — the runtime service account is the identity)");
    if (r.requiredOneOf && r.requiredOneOf.length > 0) {
      io.out("  required configuration (choose one complete option):");
      for (const option of r.requiredOneOf) io.out(`    - ${option.join(" + ")}`);
    }
    if (r.optional.length > 0) io.out(`  optional: ${r.optional.join(", ")}`);

    for (const secret of r.secrets) {
      io.out(`  provision ${secret.env}:`);
      io.out(
        `    gcloud secrets create ${shellQuote(secret.secretId)} --replication-policy=automatic --project ${shellQuote(project)}`,
      );
      io.out(
        `    printf %s "$SECRET_VALUE" | gcloud secrets versions add ${shellQuote(secret.secretId)} --data-file=- --project ${shellQuote(project)}`,
      );
    }
    io.out("");
  }

  if (secrets.length > 0) {
    io.out("Create the reviewed Terraform input BEFORE planning (never add vars at apply time):");
    io.out(
      `  anvil deploy credentials ${shellQuote(dir)} --env ${shellQuote(opts.env)} --project ${shellQuote(project)} --tfvars > /EXTERNAL_TF_WORK/credentials.auto.tfvars.json`,
    );
    io.out(
      "  Include that file in the external plan directory, review tfplan, then apply that exact plan.",
    );
    io.out("");
  }
  io.out(
    "Config (non-secret) values are plain env. Replace every REPLACE_ME value and clear anvil_unresolved_config before planning; Terraform rejects an incomplete scaffold.",
  );
  io.out(
    "The runtime dereferences each sm:// reference at call time; 'latest' rotates with no redeploy.",
  );
  return 0;
}

/** True when an env key names a secret value (vs a config value like an endpoint). */
function isSecretKey(name: string): boolean {
  return /_(CLIENT_SECRET|CLIENT_ASSERTION_KEY|TOKEN|PASSWORD|API_KEY)$/.test(name);
}

/** A stable Secret Manager secret id for an env key: ANVIL_PROD_CLIENT_SECRET → svc-prod-client-secret. */
function secretIdFor(service: string, envKey: string): string {
  const suffix = envKey
    .replace(/^ANVIL_/, "")
    .toLowerCase()
    .replace(/_/g, "-");
  return `${service}-${suffix}`;
}

function isGcpProjectId(value: string): boolean {
  return /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(value);
}

function resolveBundleRoot(input: string): string {
  const absolute = resolve(input);
  return existsSync(absolute) && statSync(absolute).isDirectory() ? absolute : dirname(absolute);
}

/** POSIX shell single-quote escaping for commands printed for copy/paste. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
