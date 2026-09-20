import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  deploymentArtifactHash,
  GENERATION_METADATA_FILE,
  GITHUB_ACTIONS_WORKFLOW_FILE,
  generateGithubActionsWorkflow,
  generateKubernetesDeploy,
  KUBERNETES_DEPLOY_PREFIX,
  KUBERNETES_REPLACE_PREFIX,
  kubernetesWorkloadName,
  loadBundleAir,
  readBundleDir,
  resolveBundleDir,
  resourceOptionsFromGenerationMetadata,
} from "@anvil/generators";
import { type Command, Option } from "commander";
import type { CliIO } from "../io.js";
import type { CommandContext } from "./context.js";

/**
 * `anvil deploy kubernetes <bundle> [--out] [--namespace] [--image] [--ci]`.
 *
 * Without `--out`, prints the apply/rollout plan for the manifests the compile
 * already emitted under `deploy/kubernetes/`. With `--out`, re-projects that
 * same generator — with the operator's image and namespace applied — into an
 * external directory, because the compiled set is compiler-owned (certify
 * re-derives it byte for byte) and therefore cannot carry per-deployment
 * values. `--ci github-actions` writes the release-gates workflow beside it.
 * Nothing here contacts a cluster.
 */
export function registerDeployKubernetes(deploy: Command, ctx: CommandContext): void {
  deploy
    .command("kubernetes")
    .summary("The Kubernetes deployment plan (kustomize owns image/namespace; you apply).")
    .description(
      "Prints the kubectl plan for the compiled deploy/kubernetes/ manifests, or with --out re-emits them with your image and namespace to an external directory. Same runtime image, env contract, and fail-closed ledger gate as Cloud Run; a durable ledger is required outside dev and /readyz keeps an unready rollout from completing. Never applies anything.",
    )
    .argument("<dir>", "bundle directory containing deploy/kubernetes/ artifacts")
    .option("--out <dir>", "write the manifests (with --image/--namespace applied) here")
    .option("--namespace <name>", "Kubernetes namespace for the re-projected kustomization")
    .option(
      "--image <ref>",
      "image reference (registry/repo[:tag|@digest]) built from deploy/Dockerfile",
    )
    .addOption(
      new Option(
        "--ci <provider>",
        "also write the release-gates workflow (never applies)",
      ).choices(["github-actions"]),
    )
    .action((dir: string, opts: DeployKubernetesOptions) => {
      ctx.code = runDeployKubernetes(dir, opts, ctx.io);
    });
}

interface DeployKubernetesOptions {
  out?: string;
  namespace?: string;
  image?: string;
  ci?: "github-actions";
}

function runDeployKubernetes(path: string, opts: DeployKubernetesOptions, io: CliIO): number {
  const dir = resolveBundleDir(path);
  if (!existsSync(join(dir, "deploy", "kubernetes", "kustomization.yaml"))) {
    io.err(
      `No Kubernetes deploy artifacts at ${join(dir, "deploy", "kubernetes")}. Run \`anvil compile\` first.`,
    );
    return 1;
  }
  if (opts.out === undefined) {
    if (opts.namespace !== undefined || opts.image !== undefined || opts.ci !== undefined) {
      io.err(
        "--namespace, --image, and --ci re-project the manifests and need --out: the compiled deploy/kubernetes/ set is compiler-owned and cannot carry per-deployment values.",
      );
      return 1;
    }
    printKubernetesPlan(dir, io);
    return 0;
  }

  const files = readBundleDir(dir);
  const air = loadBundleAir(dir, files);
  const generationPath = join(dir, GENERATION_METADATA_FILE);
  const resourceOptions = existsSync(generationPath)
    ? resourceOptionsFromGenerationMetadata(readFileSync(generationPath, "utf8"))
    : {};
  if (!resourceOptions) {
    io.err(
      `${generationPath} is invalid; refusing to re-project deployment names from derived output.`,
    );
    return 1;
  }
  let emitted: Record<string, string>;
  try {
    emitted = generateKubernetesDeploy(air, resourceOptions, {
      namespace: opts.namespace,
      image: opts.image,
      runtimeArtifactHash: deploymentArtifactHash(files),
    });
  } catch (error) {
    io.err(`anvil deploy kubernetes: ${(error as Error).message}`);
    return 1;
  }
  if (opts.ci === "github-actions") {
    Object.assign(emitted, generateGithubActionsWorkflow(air, resourceOptions));
  }
  const root = resolve(opts.out);
  const written: string[] = [];
  for (const [rel, contents] of Object.entries(emitted)) {
    // deploy/kubernetes/<file> lands at <out>/<file>; the CI workflow keeps
    // its ci/ directory so the two never collide.
    const relative = rel.startsWith(KUBERNETES_DEPLOY_PREFIX)
      ? rel.slice(KUBERNETES_DEPLOY_PREFIX.length)
      : rel.slice("deploy/".length);
    const full = join(root, relative);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents, "utf8");
    written.push(relative);
  }
  io.out(
    `Wrote ${written.length} file(s) for ${kubernetesWorkloadName(air, resourceOptions)} to ${root}: ${written.join(", ")}.`,
  );
  const scaffolded = Object.values(emitted).some((text) =>
    text.includes(KUBERNETES_REPLACE_PREFIX),
  );
  if (scaffolded) {
    io.out(
      `Unfilled ${KUBERNETES_REPLACE_PREFIX}* values remain (pass --image, and fill the operator ConfigMap); the plan steps refuse a rendered manifest that still carries one.`,
    );
  }
  io.out(`Render and review: kubectl kustomize ${root} > rendered.yaml`);
  io.out(
    "No cluster call was made. Apply remains an operator action; see README.md in the output.",
  );
  return 0;
}

/**
 * The Kubernetes plan — shared with the gated `anvil publish --target
 * kubernetes`, which prints the same steps after verifying assurance.
 */
export function printKubernetesPlan(dir: string, io: CliIO): void {
  const manifests = join(dir, "deploy", "kubernetes");
  const readme = existsSync(join(manifests, "README.md"))
    ? readFileSync(join(manifests, "README.md"), "utf8")
    : "";
  const ledgerRequired = readme.includes("REQUIRED outside dev");
  const workload = readme.match(/^# Deploying `([^`]+)` to Kubernetes/m)?.[1] ?? "<workload>";
  const namespace = readme.match(/kubectl create namespace (\S+)/)?.[1] ?? "<namespace>";
  io.out(`Kubernetes deployment plan only (manifests in ${manifests}):`);
  io.out("No cluster call is made by this command; the operator must review and apply the plan.");
  io.out(`Prereqs (once per cluster): the namespace (kubectl create namespace ${namespace}), a`);
  io.out("  registry the cluster pulls from, and the credential Secret named in");
  io.out(
    "  deploy/kubernetes/secrets.required.yaml (keys are names; values come from your store).",
  );
  if (ledgerRequired) {
    io.out(
      "  A durable ledger is REQUIRED outside dev: set ANVIL_LEDGER in the operator ConfigMap.",
    );
    io.out(
      "  Until it is reachable, /readyz answers 503 and the rollout never becomes Ready (fail closed,",
    );
    io.out(
      "  exactly as Cloud Run's startup probe). Inspect the store contract with `anvil deploy ledger <dir>`.",
    );
  } else {
    io.out("  No approved mutation requires an idempotency key, so no durable ledger is required.");
  }
  io.out(
    "  1. docker build -f deploy/Dockerfile -t <registry>/<repo>:<tag> . && docker push <registry>/<repo>:<tag>",
  );
  io.out(
    "  2. anvil deploy kubernetes <dir> --image <registry>/<repo>:<tag> --namespace <namespace> --out <plan-dir>",
  );
  io.out(
    "     → the same manifests with your image and namespace; fill every REPLACE_WITH_ value.",
  );
  io.out(
    "  3. kubectl kustomize <plan-dir> > rendered.yaml && ! grep -q REPLACE_WITH_ rendered.yaml",
  );
  io.out("     kubectl apply -k <plan-dir> --dry-run=server   (plan; nothing changes)");
  io.out("  4. kubectl apply -k <plan-dir>                    (after review)");
  io.out(`     kubectl -n ${namespace} rollout status deployment/${workload} --timeout=300s`);
  io.out(`  Roll back: kubectl -n ${namespace} rollout undo deployment/${workload}`);
  io.out(`CI gates and plan artifact: ${GITHUB_ACTIONS_WORKFLOW_FILE} (never applies).`);
  io.out("Plan prepared. Deployment remains operator action; no cluster resource was changed.");
}
