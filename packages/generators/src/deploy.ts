import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AirDocument,
  type AuthRequirement,
  airToJson,
  MAX_RETRY_ATTEMPTS,
  MAX_RETRY_DELAY_MS,
} from "@anvil/air";
import {
  credentialProfileName,
  credentialRequirement,
  DEFAULT_FIRESTORE_TIMEOUT_MS,
  DEFAULT_LEDGER_RESULT_TTL_SECONDS,
  DEFAULT_UPSTREAM_TIMEOUT_MS,
  firestoreLedgerCollection,
  MAX_FIRESTORE_COMPLETE_SEGMENT_MS,
  MAX_FIRESTORE_RESERVE_SEGMENT_MS,
  MAX_LEDGER_RESULT_BYTES,
  MAX_UPSTREAM_TIMEOUT_MS,
  MIN_UPSTREAM_TIMEOUT_MS,
} from "@anvil/runtime";
import { buildSync } from "esbuild";
import { stringify as toYaml } from "yaml";
import { z } from "zod";
import { compiledOperations } from "./catalog.js";
import { generateRuntimeServer } from "./entrypoints.js";
import { buildToolResources, type ResourceOptions } from "./resources.js";

export const IDEMPOTENCY_STORE_CONTRACT_FILE = "deploy/idempotency-store.json";
export const DEPLOY_RUNTIME_PREFIX = "deploy/runtime/";
export const GOOGLE_PROVIDER_CONSTRAINT = ">= 7.33.0, < 8.0.0";
export const GENERATED_CLOUD_RUN_TIMEOUT_SECONDS = 600;
export const COMPILER_OWNED_RUNTIME_ENV_NAMES = [
  "ANVIL_ALLOWED_HOSTS",
  "ANVIL_AUTH_PROFILE",
  "ANVIL_CREDENTIALS",
  "ANVIL_ENV",
  "ANVIL_LEDGER",
  "ANVIL_LEDGER_RESULT_TTL_SECONDS",
  "ANVIL_OTEL_EXPORTER",
  "ANVIL_SECRET_PROJECT",
  "ANVIL_SERVICE_ID",
  "ANVIL_UPSTREAM_TIMEOUT_MS",
] as const;

const MAX_UPSTREAM_SEGMENT_MS =
  MAX_RETRY_ATTEMPTS * MAX_UPSTREAM_TIMEOUT_MS + (MAX_RETRY_ATTEMPTS - 1) * MAX_RETRY_DELAY_MS;
// The first ledger request may also mint one cached metadata token. Keep the
// whole known mutation path below Cloud Run's deadline, with explicit room for
// bounded credential acquisition, hooks, serialization, and response delivery.
export const MAX_GENERATED_WRITE_PATH_MS =
  DEFAULT_FIRESTORE_TIMEOUT_MS +
  MAX_FIRESTORE_RESERVE_SEGMENT_MS +
  MAX_UPSTREAM_SEGMENT_MS +
  MAX_FIRESTORE_COMPLETE_SEGMENT_MS;
export const GENERATED_WRITE_PATH_MARGIN_MS =
  GENERATED_CLOUD_RUN_TIMEOUT_SECONDS * 1000 - MAX_GENERATED_WRITE_PATH_MS;
if (GENERATED_WRITE_PATH_MARGIN_MS < 100_000) {
  throw new Error(
    "The generated Cloud Run request deadline must leave at least 100 seconds beyond the bounded ledger and upstream mutation path.",
  );
}

const FirestoreStoreContract = z.strictObject({
  schemaVersion: z.literal(1),
  serviceId: z.string().min(1),
  required: z.literal(true),
  requirement: z.strictObject({
    predicate: z.literal("approved_required_key_mutation_requires_durable_ledger"),
    operationIds: z.array(z.string().min(1)).min(1),
  }),
  backend: z.literal("firestore"),
  firestore: z.strictObject({
    projectTerraformExpression: z.literal("${var.project_id}"),
    database: z.strictObject({
      idTerraformVariable: z.literal("ledger_database_id"),
      provisioningModeTerraformVariable: z.literal("ledger_database_mode"),
      provisioningModeDefault: z.literal("shared"),
      supportedProvisioningModes: z.tuple([z.literal("shared"), z.literal("dedicated")]),
      required: z.literal(true),
      trustBoundary: z.literal("database"),
    }),
    databaseMode: z.literal("FIRESTORE_NATIVE"),
    location: z.strictObject({
      terraformVariable: z.literal("ledger_location"),
      requiredFor: z.literal("dedicated"),
      ignoredFor: z.literal("shared"),
      immutable: z.literal(true),
    }),
    provisioning: z.strictObject({
      databaseManagedByCapabilityTerraform: z.literal("dedicated_only"),
      sharedApiEnablementManagedByCapabilityTerraform: z.literal(false),
      requiredSharedApis: z.tuple([z.literal("firestore.googleapis.com")]),
      googleProviderConstraint: z.literal(GOOGLE_PROVIDER_CONSTRAINT),
      sharedIsolation: z.literal("deployment_namespace_hashed_collection_group"),
      dedicatedIsolation: z.literal("database"),
      databaseQuotaSlotsPerCapability: z.strictObject({
        shared: z.literal(0),
        dedicated: z.literal(1),
      }),
      sharedDatabaseQuotaSlots: z.literal(1),
      iamIsolation: z.literal("database_not_collection_group"),
      collectionMaterialization: z.literal("first_atomic_reservation"),
      decommissionPolicy: z.literal("abandon_service_field_policies_and_data"),
    }),
    namespace: z.string().min(1),
    collectionGroup: z.string().min(1),
    runtimeUri: z.strictObject({
      environmentVariable: z.literal("ANVIL_LEDGER"),
      terraformExpression: z.string().min(1),
      resolvedTemplate: z.string().min(1),
    }),
    indexing: z.strictObject({
      defaultSingleFieldIndexes: z.literal(false),
      wildcardFieldOverride: z.literal("*"),
      queryPattern: z.literal("document_id_only"),
    }),
    retention: z.strictObject({
      ttlField: z.literal("expires_at"),
      resultTtlSecondsTerraformVariable: z.literal("ledger_result_ttl_seconds"),
      resultTtlSecondsDefault: z.number().int().positive(),
      logicalExpiryBeforeReplay: z.literal(true),
      providerDeletionAsynchronous: z.literal(true),
      inProgressExpires: z.literal(false),
      ttlFieldIndexed: z.literal(false),
      maxReplayResultBytes: z.literal(MAX_LEDGER_RESULT_BYTES),
    }),
    consistency: z.strictObject({
      reserve: z.literal("atomic_create"),
      complete: z.literal("update_time_precondition"),
      release: z.literal("update_time_precondition"),
      requestFingerprintBound: z.literal(true),
    }),
    iam: z.strictObject({
      role: z.literal("roles/datastore.user"),
      scope: z.literal("database"),
      resourceTerraformExpression: z.string().min(1),
    }),
    readiness: z.strictObject({
      path: z.literal("/readyz"),
      method: z.literal("field_masked_list"),
      fieldMask: z.tuple([z.literal("status")]),
      mutates: z.literal(false),
      deploymentStartupGate: z.literal(true),
      livenessRestartOnProviderFailure: z.literal(false),
    }),
  }),
});

const NoStoreContract = z.strictObject({
  schemaVersion: z.literal(1),
  serviceId: z.string().min(1),
  required: z.literal(false),
  requirement: z.strictObject({
    predicate: z.literal("approved_required_key_mutation_requires_durable_ledger"),
    operationIds: z.tuple([]),
  }),
  backend: z.literal("none"),
  firestore: z.null(),
});

/** Stable operator contract consumed by the CLI instead of re-deriving deploy semantics. */
export const IdempotencyStoreContract = z.discriminatedUnion("backend", [
  FirestoreStoreContract,
  NoStoreContract,
]);
export type IdempotencyStoreContract = z.infer<typeof IdempotencyStoreContract>;

/** Parse a generated store contract and reject partial or stale schema shapes. */
export function parseIdempotencyStoreContract(text: string): IdempotencyStoreContract {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${IDEMPOTENCY_STORE_CONTRACT_FILE} is not valid JSON.`);
  }
  const parsed = IdempotencyStoreContract.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${IDEMPOTENCY_STORE_CONTRACT_FILE} does not match schema version 1.`);
  }
  return parsed.data;
}

/**
 * Deployment artifacts for Cloud Run. Anvil emits these at build time; it holds
 * no cloud credentials and never applies them — a human/CI does.
 *
 * **One owner per concern** (this is the whole point of the file). Earlier Anvil
 * emitted five overlapping mechanisms — a knative `service.yaml`, an
 * `iam.plan.json`, per-env `overlays/`, a `gcloud run deploy` step, *and*
 * Terraform — that set the same image tag / env vars / IAM three different ways
 * and drifted. Now:
 *
 *   - **Terraform** owns all infrastructure *and* runtime configuration: the
 *     service account, Artifact Registry, Secret Manager + its IAM, the
 *     Firestore ledger field policies + IAM (and, only in dedicated mode, the
 *     database), the Cloud Run service (image, env vars, scaling, resources,
 *     ingress), and invoker IAM. It is the single source of truth for every
 *     deployable setting.
 *   - **Cloud Build** owns the pipeline: build the prebuilt image, push it, and
 *     produce a reviewable Terraform plan with the built image tag. It sets *no*
 *     runtime config and never applies the plan.
 *   - **Dockerfile** owns the container (prebuilt runtime, never rebuilds Anvil).
 *
 * No file contains literal `PROJECT`/`REGION` placeholders; everything flows
 * through Terraform variables, so the bundle is applyable as emitted.
 */
export function generateDeploy(
  air: AirDocument,
  resourceOptions: ResourceOptions = {},
): Record<string, string> {
  const deploymentNamespace = resolveDeploymentNamespace(air, resourceOptions);
  const deploymentEnvironment = resolveDeploymentEnvironment(air);
  const runtime = deployRuntime(air, resourceOptions);
  const store = idempotencyStoreContract(air, resourceOptions);
  const storeContractDigest = idempotencyStoreContractDigest(store);
  const runtimeArtifactHash = deploymentArtifactHash(runtime);
  return {
    "deploy/Dockerfile": dockerfile(),
    // Cloud Build uses the bundle root as context with `-f deploy/Dockerfile`.
    // Docker therefore discovers this Dockerfile-specific ignore file; a
    // `deploy/.dockerignore` would be ignored and upload the whole bundle.
    "deploy/Dockerfile.dockerignore": dockerignore(),
    ...runtime,
    "deploy/cloudbuild.yaml": cloudBuild(deploymentNamespace, deploymentEnvironment),
    "deploy/terraform/main.tf": terraformMain(air, resourceOptions, {
      runtimeArtifactHash,
      store,
      storeContractDigest,
    }),
    "deploy/terraform/variables.tf": terraformVariables(air),
    [IDEMPOTENCY_STORE_CONTRACT_FILE]: `${JSON.stringify(store, null, 2)}\n`,
    "deploy/env.schema.json": `${JSON.stringify(
      envSchema(safeHost(air.service.servers[0]?.url), deploymentEnvironment),
      null,
      2,
    )}\n`,
    "deploy/secrets.required.yaml": toYaml(secretsContract(air)),
    "deploy/credentials.required.yaml": toYaml(credentialContract(air)),
    "deploy/README.md": deployReadme(air, resourceOptions),
  };
}

/** Digest of the exact generated store-contract bytes consumed by the CLI. */
export function idempotencyStoreContractDigest(contract: IdempotencyStoreContract): string {
  return createHash("sha256")
    .update(`${JSON.stringify(contract, null, 2)}\n`)
    .digest("hex");
}

export interface LedgerDeploymentInput {
  bundleHash: string;
  databaseId: string;
  databaseMode: "shared" | "dedicated";
  expectedProjectId: string;
  location: string | null;
  namespace: string;
  resultTtlSeconds: number;
  runtimeArtifactHash: string;
  storeContractDigest: string;
}

/**
 * Canonical identity of the reviewed, non-secret ledger inputs. Terraform
 * independently recomputes this exact projection before it may plan Cloud Run.
 */
export function ledgerDeploymentInputDigest(input: LedgerDeploymentInput): string {
  const canonical = {
    bundle_hash: input.bundleHash,
    database_id: input.databaseId,
    database_mode: input.databaseMode,
    expected_project_id: input.expectedProjectId,
    location: input.location,
    namespace: input.namespace,
    result_ttl_seconds: input.resultTtlSeconds,
    runtime_artifact_hash: input.runtimeArtifactHash,
    schema_version: 1,
    store_contract_digest: input.storeContractDigest,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function ledgerOperationIds(air: AirDocument): string[] {
  return air.operations
    .filter(
      (operation) =>
        operation.state === "approved" &&
        operation.effect.kind === "mutation" &&
        operation.idempotency.mode === "required",
    )
    .map((operation) => operation.id)
    .sort();
}

/** True when the surface has a required-idempotency mutation → needs Firestore. */
function needsLedger(air: AirDocument): boolean {
  return ledgerOperationIds(air).length > 0;
}

/**
 * Exact managed-store projection. Firestore is the single production backend:
 * its atomic document create and update-time preconditions fit the ledger
 * protocol without a SQL schema or connection pool. Shared-database mode is
 * the estate-scale default; dedicated mode spends one database quota slot for
 * a stronger IAM boundary. Firebase is a client/product surface over
 * Firestore, not a separate Cloud Run persistence backend.
 */
export function idempotencyStoreContract(
  air: AirDocument,
  resourceOptions: Pick<ResourceOptions, "deploymentNamespace"> = {},
): IdempotencyStoreContract {
  const operationIds = ledgerOperationIds(air);
  const requirement = {
    predicate: "approved_required_key_mutation_requires_durable_ledger" as const,
    operationIds,
  };
  if (operationIds.length === 0) {
    return {
      schemaVersion: 1,
      serviceId: air.service.id,
      required: false,
      requirement: { ...requirement, operationIds: [] },
      backend: "none",
      firestore: null,
    };
  }

  const namespace = resolveDeploymentNamespace(air, resourceOptions);
  return {
    schemaVersion: 1,
    serviceId: air.service.id,
    required: true,
    requirement,
    backend: "firestore",
    firestore: {
      projectTerraformExpression: "${var.project_id}",
      database: {
        idTerraformVariable: "ledger_database_id",
        provisioningModeTerraformVariable: "ledger_database_mode",
        provisioningModeDefault: "shared",
        supportedProvisioningModes: ["shared", "dedicated"],
        required: true,
        trustBoundary: "database",
      },
      databaseMode: "FIRESTORE_NATIVE",
      location: {
        terraformVariable: "ledger_location",
        requiredFor: "dedicated",
        ignoredFor: "shared",
        immutable: true,
      },
      provisioning: {
        databaseManagedByCapabilityTerraform: "dedicated_only",
        sharedApiEnablementManagedByCapabilityTerraform: false,
        requiredSharedApis: ["firestore.googleapis.com"],
        googleProviderConstraint: GOOGLE_PROVIDER_CONSTRAINT,
        sharedIsolation: "deployment_namespace_hashed_collection_group",
        dedicatedIsolation: "database",
        databaseQuotaSlotsPerCapability: { shared: 0, dedicated: 1 },
        sharedDatabaseQuotaSlots: 1,
        iamIsolation: "database_not_collection_group",
        collectionMaterialization: "first_atomic_reservation",
        decommissionPolicy: "abandon_service_field_policies_and_data",
      },
      namespace,
      collectionGroup: firestoreLedgerCollection(namespace),
      runtimeUri: {
        environmentVariable: "ANVIL_LEDGER",
        terraformExpression: `firestore://\${var.project_id}/\${local.ledger_database_id}/${namespace}`,
        resolvedTemplate: `firestore://{project_id}/{database_id}/${namespace}`,
      },
      indexing: {
        defaultSingleFieldIndexes: false,
        wildcardFieldOverride: "*",
        queryPattern: "document_id_only",
      },
      retention: {
        ttlField: "expires_at",
        resultTtlSecondsTerraformVariable: "ledger_result_ttl_seconds",
        resultTtlSecondsDefault: DEFAULT_LEDGER_RESULT_TTL_SECONDS,
        logicalExpiryBeforeReplay: true,
        providerDeletionAsynchronous: true,
        inProgressExpires: false,
        ttlFieldIndexed: false,
        maxReplayResultBytes: MAX_LEDGER_RESULT_BYTES,
      },
      consistency: {
        reserve: "atomic_create",
        complete: "update_time_precondition",
        release: "update_time_precondition",
        requestFingerprintBound: true,
      },
      iam: {
        role: "roles/datastore.user",
        scope: "database",
        resourceTerraformExpression:
          "projects/${var.project_id}/databases/${local.ledger_database_id}",
      },
      readiness: {
        path: "/readyz",
        method: "field_masked_list",
        fieldMask: ["status"],
        mutates: false,
        deploymentStartupGate: true,
        livenessRestartOnProviderFailure: false,
      },
    },
  };
}

/**
 * A *prebuilt* runtime image: the bundle is already compiled JS (generated by
 * Anvil), so the container installs production deps and copies the runtime — it
 * never rebuilds Anvil packages inside the image. Distroless, non-root.
 */
function dockerfile(): string {
  return `# Generated by Anvil — hermetic, prebundled Cloud Run runtime.
# deploy/runtime/server.js already contains its exact Anvil + MCP dependencies.
# The image performs no registry access or dependency resolution.
FROM gcr.io/distroless/nodejs22-debian12
WORKDIR /app
ENV NODE_ENV=production
COPY deploy/runtime ./runtime
EXPOSE 8080
USER nonroot
CMD ["runtime/server.js"]
`;
}

function dockerignore(): string {
  // `deploy/runtime` is the only application payload copied by the hermetic
  // Dockerfile, so never exclude the deploy tree from the build context.
  return ["cli", "mcp", "mock", "skill", "docs", "tests", "*.test.*", "src"].join("\n");
}

/**
 * Content identity of the exact directory copied into the production image.
 *
 * Paths are relative to `/app/runtime`, matching the runtime's boot-time
 * computation. This is deliberately narrower than `bundleHash`: live
 * conformance needs to prove which executable artifact is deployed, while the
 * release record continues to bind the complete generated bundle.
 */
export function deploymentArtifactHash(files: Record<string, string>): string {
  const entries = Object.keys(files)
    .filter((path) => path.startsWith(DEPLOY_RUNTIME_PREFIX))
    .map((path) => [path.slice(DEPLOY_RUNTIME_PREFIX.length), files[path] ?? ""] as const)
    .filter(([relative]) => relative.length > 0)
    .sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) {
    throw new Error(`Bundle has no files under ${DEPLOY_RUNTIME_PREFIX}`);
  }
  const hash = createHash("sha256");
  for (const [relative, content] of entries) {
    const contentHash = createHash("sha256").update(content).digest("hex");
    hash.update(`${relative}\0${contentHash}\0`);
  }
  return hash.digest("hex");
}

function deployRuntime(air: AirDocument, resourceOptions: ResourceOptions): Record<string, string> {
  const source = generateRuntimeServer(air);
  const result = buildSync({
    stdin: {
      contents: source,
      sourcefile: "runtime/server.js",
      resolveDir: dirname(fileURLToPath(import.meta.url)),
      loader: "js",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    treeShaking: true,
    minify: true,
    legalComments: "none",
    // A few transitive CommonJS modules use dynamic require for Node built-ins.
    // ESM has no ambient require, so provide a local createRequire seam while
    // keeping every third-party package bundled into this single file.
    banner: {
      js: 'import{createRequire as __anvilCreateRequire}from"node:module";const require=__anvilCreateRequire(import.meta.url);',
    },
    sourcemap: false,
    write: false,
    logLevel: "silent",
  });
  const server = result.outputFiles[0]?.text;
  if (!server) throw new Error("Failed to bundle the deploy runtime.");
  return {
    "deploy/runtime/package.json": `${JSON.stringify(
      { name: `${air.service.id}-anvil-runtime`, private: true, type: "module" },
      null,
      2,
    )}\n`,
    "deploy/runtime/server.js": server,
    "deploy/runtime/air.json": airToJson(air),
    "deploy/runtime/resources.json": `${JSON.stringify(
      buildToolResources(air, resourceOptions),
      null,
      2,
    )}\n`,
    "deploy/runtime/operations.manifest.json": `${JSON.stringify(compiledOperations(air), null, 2)}\n`,
  };
}

/**
 * Cloud Build owns the pipeline only: build → push → `terraform plan`. It sets
 * no runtime config; it passes Terraform the immutable build id (`$BUILD_ID`) and
 * project/region. Terraform is the single owner of the deployed service, so the
 * image tag has exactly one source of truth.
 */
function cloudBuild(deploymentNamespace: string, deploymentEnvironment: string): string {
  const cloudId = googleResourcePrefix(deploymentNamespace);
  // The ${...} tokens are Cloud Build substitution variables (expanded by
  // Cloud Build at runtime), NOT JS interpolation — so they stay in a plain
  // string; only `id` is a real JS value, concatenated in.
  const image = `\${_REGION}-docker.pkg.dev/\${PROJECT_ID}/\${_AR_REPO}/${cloudId}-tools:$BUILD_ID`;
  return toYaml({
    steps: [
      {
        id: "build",
        name: "gcr.io/cloud-builders/docker",
        args: ["build", "-f", "deploy/Dockerfile", "-t", image, "."],
      },
      // Push targets the Artifact Registry repo, which is a **platform prereq**
      // (created out of band), so there is no bootstrap cycle where push would
      // need a repo a later Terraform step has not created yet.
      { id: "push", name: "gcr.io/cloud-builders/docker", args: ["push", image] },
      {
        id: "terraform-workdir",
        name: "ubuntu",
        entrypoint: "bash",
        args: [
          "-ceu",
          "test ! -e /workspace/tf-work; mkdir /workspace/tf-work; cp deploy/terraform/*.tf /workspace/tf-work/",
        ],
      },
      {
        id: "operator-inputs",
        name: "gcr.io/cloud-builders/gcloud",
        args: ["storage", "cp", "${_TFVARS_URI}", "/workspace/tf-work/operator.auto.tfvars.json"],
      },
      {
        id: "plan",
        name: "hashicorp/terraform",
        entrypoint: "sh",
        args: [
          "-c",
          [
            // Durable remote state (GCS) is mandatory: an ephemeral build container
            // has no local state, so init MUST bind the shared backend or every
            // build would try to recreate existing resources.
            'terraform -chdir=/workspace/tf-work init -input=false -backend-config="bucket=${_TF_STATE_BUCKET}"' +
              ' -backend-config="prefix=${_TF_STATE_PREFIX}"',
            // Cloud Build produces a **plan**, never an auto-approved apply — a
            // capability deploy can change IAM, ingress, and secrets, which must
            // pass a review/approval gate. Apply is a separate, promoted step.
            "terraform -chdir=/workspace/tf-work plan -input=false -out=tfplan" +
              ' -var project_id="$PROJECT_ID"' +
              ' -var region="${_REGION}"' +
              ' -var ar_repo="${_AR_REPO}"' +
              ' -var image_tag="$BUILD_ID"' +
              ' -var anvil_env="${_ANVIL_ENV}"',
            // Human-readable plan artifact for the review pack.
            "terraform -chdir=/workspace/tf-work show -no-color tfplan > /workspace/tf-work/tfplan.txt",
          ].join(" && "),
        ],
      },
    ],
    images: [image],
    // Publish the plan so a promotion step (or a human) can review, then
    // `terraform apply tfplan` behind an approval — see deploy/README.md.
    artifacts: {
      objects: {
        location: "gs://${_TF_STATE_BUCKET}/plans/${BUILD_ID}",
        paths: ["tf-work/tfplan", "tf-work/tfplan.txt", "tf-work/.terraform.lock.hcl"],
      },
    },
    substitutions: {
      _REGION: "us-central1",
      _AR_REPO: "anvil",
      _ANVIL_ENV: deploymentEnvironment,
      // Names/references and connector settings only; no secret values. Build
      // fails until the operator supplies this reviewed external input.
      _TFVARS_URI: "gs://REPLACE_WITH_INPUT_BUCKET/anvil/operator.auto.tfvars.json",
      // Durable Terraform state — a GCS bucket that must already exist (prereq).
      _TF_STATE_BUCKET: "REPLACE_WITH_TF_STATE_BUCKET",
      _TF_STATE_PREFIX: `anvil/${deploymentNamespace}-tools`,
    },
    options: { logging: "CLOUD_LOGGING_ONLY" },
  });
}

/**
 * Terraform is the single owner of every *per-capability* deployed setting —
 * SA, Secret + IAM, ledger field policies and IAM, the Cloud Run service
 * (image, env vars, scaling, resources, ingress), and invoker IAM. A dedicated
 * ledger database is capability-owned only when explicitly selected. Shared
 * project-level foundations (including a shared ledger database), Artifact
 * Registry repo, and Terraform state bucket are prerequisites, not owned here.
 */
function terraformMain(
  air: AirDocument,
  resourceOptions: ResourceOptions,
  binding: {
    runtimeArtifactHash: string;
    store: IdempotencyStoreContract;
    storeContractDigest: string;
  },
): string {
  const id = air.service.id;
  const deploymentNamespace = resolveDeploymentNamespace(air, resourceOptions);
  const cloudId = googleResourcePrefix(deploymentNamespace);
  const { runtimeArtifactHash, store, storeContractDigest } = binding;
  const ledger = store.backend === "firestore";
  const ledgerCollection = store.firestore?.collectionGroup;
  const ledgerNamespace = store.firestore?.namespace;
  const host = safeHost(air.service.servers[0]?.url) ?? "";
  return `# Generated by Anvil — Cloud Run runtime for "${id}" (one tool surface).
# Anvil emits this plan; it does not apply it (no cloud credentials held). This
# file is the single owner of every *per-capability* setting for this service.
#
# Platform prerequisites (shared, project-level; NOT owned here — Anvil must not
# pretend each capability owns the customer's foundation):
#   - the Artifact Registry repo "\${var.ar_repo}" (images are pushed to it)
#   - the GCS bucket backing Terraform state (bound at 'terraform init' below)
# Bootstrap these once per project before applying this module.

terraform {
  # Durable remote state — required. 'terraform init' binds bucket/prefix via
  # -backend-config so an ephemeral CI container never starts from empty state.
  backend "gcs" {}
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "${GOOGLE_PROVIDER_CONSTRAINT}"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

locals {
  # These settings have exactly one compiler-owned source below. External target
  # and credential maps may add their own names, but may never shadow a safety
  # control by creating a duplicate Cloud Run environment variable.
  anvil_compiler_owned_runtime_env_names = toset(${JSON.stringify(COMPILER_OWNED_RUNTIME_ENV_NAMES).replaceAll(",", ", ")})
}
${
  ledger
    ? `
locals {
  # Shared mode uses the existing platform-owned database verbatim. Dedicated
  # mode creates one delete-protected database for this capability.
  ledger_database_id = var.ledger_database_mode == "dedicated" ? google_firestore_database.ledger[0].name : var.ledger_database_id
  ledger_deployment_input_digest = sha256(jsonencode({
    bundle_hash           = var.anvil_bundle_hash
    database_id           = var.ledger_database_id
    database_mode         = var.ledger_database_mode
    expected_project_id   = var.anvil_expected_project_id
    location              = var.ledger_location
    namespace             = "${ledgerNamespace}"
    result_ttl_seconds    = var.ledger_result_ttl_seconds
    runtime_artifact_hash = "${runtimeArtifactHash}"
    schema_version        = 1
    store_contract_digest = "${storeContractDigest}"
  }))
}
`
    : ""
}

resource "google_service_account" "runtime" {
  account_id   = "${cloudId}-tools"
  display_name = "Anvil runtime for ${id}"
  project      = var.project_id
}

# Least privilege: logging / trace / metrics only, scoped to this SA.
resource "google_project_iam_member" "logging" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:\${google_service_account.runtime.email}"
}

resource "google_project_iam_member" "trace" {
  project = var.project_id
  role    = "roles/cloudtrace.agent"
  member  = "serviceAccount:\${google_service_account.runtime.email}"
}

resource "google_project_iam_member" "metrics" {
  project = var.project_id
  role    = "roles/monitoring.metricWriter"
  member  = "serviceAccount:\${google_service_account.runtime.email}"
}
${
  ledger
    ? `
# Shared mode (the estate-scale default) treats var.ledger_database_id as a
# platform-owned prerequisite. Capability states must not each import or manage
# that singleton. Dedicated mode creates one isolated database when the stronger
# IAM boundary justifies one quota slot per capability.
resource "google_firestore_database" "ledger" {
  count                   = var.ledger_database_mode == "dedicated" ? 1 : 0
  project                 = var.project_id
  name                    = var.ledger_database_id
  location_id             = var.ledger_location
  type                    = "FIRESTORE_NATIVE"
  delete_protection_state = "DELETE_PROTECTION_ENABLED"
  deletion_policy         = "ABANDON"

  lifecycle {
    prevent_destroy = true
    precondition {
      condition     = var.ledger_location != null
      error_message = "ledger_location is required when ledger_database_mode is dedicated."
    }
    precondition {
      condition     = var.ledger_database_id != "(default)"
      error_message = "dedicated ledger mode requires a named database id, not (default)."
    }
  }
}
#
# Firestore deletes completed replay results after their expires_at timestamp.
# In-progress reservations deliberately omit that field and are never
# auto-reclaimed, because expiry cannot prove an upstream mutation stopped.
# The runtime addresses exact document ids (and readiness lists one masked row);
# it never queries a ledger field. Disable inherited single-field indexes for
# the collection group so status/fingerprint/result payloads are not indexed.
resource "google_firestore_field" "ledger_no_single_field_indexes" {
  project    = var.project_id
  database   = local.ledger_database_id
  collection = "${ledgerCollection}"
  field      = "*"

  deletion_policy = "ABANDON"

  index_config {}
}

resource "google_firestore_field" "ledger_result_expiry" {
  project    = var.project_id
  database   = local.ledger_database_id
  collection = "${ledgerCollection}"
  field      = "expires_at"

  deletion_policy = "ABANDON"

  depends_on = [google_firestore_field.ledger_no_single_field_indexes]

  # expires_at is never queried or sorted. Exempting its monotonically
  # increasing timestamps avoids an unnecessary write hotspot and index cost.
  index_config {}
  ttl_config {}
}

# roles/datastore.user is a project IAM binding, but its condition limits this
# runtime SA to the selected database. In shared mode Firestore IAM does not
# isolate collection groups: the database is the security boundary. Use
# dedicated mode or separate shared databases for trust/regulatory domains that
# must not read one another.
resource "google_project_iam_member" "runtime_ledger" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:\${google_service_account.runtime.email}"
  condition {
    title       = "anvil-${cloudId}-ledger-only"
    description = "Restrict the Anvil runtime to its isolated idempotency database."
    expression  = "resource.name == 'projects/\${var.project_id}/databases/\${local.ledger_database_id}'"
  }
}
`
    : ""
}
resource "google_cloud_run_v2_service" "tools" {
  name     = "${cloudId}-tools"
  location = var.region
  project  = var.project_id
  # Defaults to internal-only. A connector target (e.g. Gemini Enterprise) that
  # is reached over the public internet sets var.ingress = "INGRESS_TRAFFIC_ALL"
  # and relies on the server's own inbound OAuth check (see var.env below), never
  # on network reachability alone.
  ingress${ledger ? "   " : ""} = var.ingress
${ledger ? "  depends_on = [google_project_iam_member.runtime_ledger, google_firestore_field.ledger_result_expiry]" : ""}

  lifecycle {
    precondition {
      condition = length(setintersection(
        toset(keys(var.env)),
        local.anvil_compiler_owned_runtime_env_names,
      )) == 0
      error_message = "var.env may not redefine compiler-owned ANVIL runtime settings."
    }
    precondition {
      condition = length(setintersection(
        toset(keys(var.credential_secret_refs)),
        local.anvil_compiler_owned_runtime_env_names,
      )) == 0
      error_message = "credential_secret_refs may not redefine compiler-owned ANVIL runtime settings."
    }
    precondition {
      condition = length(setintersection(
        toset(keys(var.env)),
        toset(keys(var.credential_secret_refs)),
      )) == 0
      error_message = "One runtime environment variable may not be supplied by both var.env and credential_secret_refs."
    }
${
  ledger
    ? `    precondition {
      condition     = var.anvil_expected_project_id == var.project_id
      error_message = "The reviewed ledger project does not match Cloud Build's deployment project."
    }
    precondition {
      condition     = var.anvil_ledger_input_digest == local.ledger_deployment_input_digest
      error_message = "Ledger deployment inputs do not match the reviewed bundle/input digest; regenerate them with anvil deploy ledger --tfvars."
    }
    precondition {
      condition     = var.ledger_database_mode == "dedicated" ? var.ledger_location != null : var.ledger_location == null
      error_message = "ledger_location is required for dedicated mode and must be null for shared mode."
    }
`
    : ""
}
  }

  template {
    service_account = google_service_account.runtime.email
    # The known worst path includes Firestore reservation/reconciliation,
    # metadata auth, and at most 230s of upstream attempts/backoff. The 600s
    # deadline retains more than 100s for credential acquisition, hooks,
    # serialization, and response delivery.
    timeout = "${GENERATED_CLOUD_RUN_TIMEOUT_SECONDS}s"
    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }
    containers {
      image = "\${var.region}-docker.pkg.dev/\${var.project_id}/\${var.ar_repo}/${cloudId}-tools:\${var.image_tag}"
      resources { limits = { cpu = "1", memory = "512Mi" } }
      ports { container_port = 8080 }
${
  ledger
    ? `
      # Gate a new instance on the exact Firestore data-plane permission check.
      # This is intentionally startup-only: a later provider outage must make
      # /readyz and writes fail closed, not create a liveness restart storm.
      startup_probe {
        initial_delay_seconds = 0
        timeout_seconds       = 12
        period_seconds        = 15
        failure_threshold     = 16
        http_get {
          path = "/readyz"
          port = 8080
        }
      }
`
    : ""
}

      env {
        name  = "ANVIL_SERVICE_ID"
        value = "${id}"
      }
      env {
        name  = "ANVIL_ENV"
        value = var.anvil_env
      }
      env {
        name  = "ANVIL_ALLOWED_HOSTS"
        value = "${host}"
      }
      env {
        name  = "ANVIL_AUTH_PROFILE"
        value = var.anvil_env
      }
      env {
        name  = "ANVIL_OTEL_EXPORTER"
        value = "cloud_trace"
      }
      env {
        name  = "ANVIL_LEDGER"
        value = ${ledger ? `"firestore://\${var.project_id}/\${local.ledger_database_id}/${ledgerNamespace}"` : '""'}
      }
      env {
        name  = "ANVIL_LEDGER_RESULT_TTL_SECONDS"
        value = tostring(var.ledger_result_ttl_seconds)
      }
      env {
        name  = "ANVIL_UPSTREAM_TIMEOUT_MS"
        value = tostring(var.upstream_timeout_ms)
      }
      # Outbound (upstream) credential resolution. ANVIL_CREDENTIALS chooses
      # storage only for static values; grants still route per operation.
      # ANVIL_SECRET_PROJECT resolves shorthand sm://<secret> references.
      env {
        name  = "ANVIL_CREDENTIALS"
        value = var.credentials
      }
      env {
        name  = "ANVIL_SECRET_PROJECT"
        value = coalesce(var.secret_project, var.project_id)
      }
      # Additional plain env — a connector target injects its inbound-auth
      # contract (ANVIL_INBOUND_*) here so the server self-enforces the platform's
      # token. Empty by default.
      dynamic "env" {
        for_each = var.env
        content {
          name  = env.key
          value = env.value
        }
      }
      # Upstream credential *references* as PLAIN env: the VALUE is a Secret
      # Manager resource name (sm://…), which the runtime dereferences at call
      # time and TTL-caches — so 'latest' rotates without a new revision. Grant
      # this SA access via var.credential_secret_ids below. See
      # deploy/credentials.required.yaml for exactly which keys this surface reads.
      dynamic "env" {
        for_each = var.credential_secret_refs
        content {
          name  = env.key
          value = env.value
        }
      }
    }
  }
}

# Least privilege: only named callers may invoke this internal service.
resource "google_cloud_run_v2_service_iam_member" "invokers" {
  for_each = toset(var.invoker_members)
  name     = google_cloud_run_v2_service.tools.name
  location = var.region
  project  = var.project_id
  role     = "roles/run.invoker"
  member   = each.value
}

# Scoped read access to each upstream credential secret referenced by
# var.credential_secret_refs (client secrets, assertion keys, bearer tokens).
# One binding per secret — never a project-wide secret role. Pass the secret IDs
# (projects/P/secrets/S) so the binding is explicit and least-privilege.
resource "google_secret_manager_secret_iam_member" "runtime_reads_credential" {
  for_each  = toset(var.credential_secret_ids)
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:\${google_service_account.runtime.email}"
}

# A connector reached by an external platform (Gemini Enterprise calls the /mcp
# URL over the internet) sets allow_unauthenticated = true. Cloud Run then admits
# the request at the network edge, and the SERVER enforces the OAuth token — the
# resource-server check is the real gate, not IAM. Defaults to false.
resource "google_cloud_run_v2_service_iam_member" "public" {
  count    = var.allow_unauthenticated ? 1 : 0
  name     = google_cloud_run_v2_service.tools.name
  location = var.region
  project  = var.project_id
  role     = "roles/run.invoker"
  member   = "allUsers"
}
${
  ledger
    ? `
# Non-secret coordinates of the exact managed ledger applied for this runtime.
output "idempotency_store" {
  description = "Reviewed managed-store plan identity and coordinates (no document data or credentials; not apply proof)."
  value = {
    backend                  = "firestore"
    bundle_hash              = var.anvil_bundle_hash
    collection_group         = "${ledgerCollection}"
    database                 = local.ledger_database_id
    database_mode            = var.ledger_database_mode
    deployment_artifact_hash = "${runtimeArtifactHash}"
    expected_project_id      = var.anvil_expected_project_id
    input_digest             = var.anvil_ledger_input_digest
    location                 = var.ledger_location
    namespace                = "${ledgerNamespace}"
    project_id               = var.project_id
    result_ttl_seconds       = var.ledger_result_ttl_seconds
    runtime_env              = "ANVIL_LEDGER"
    runtime_uri              = "firestore://\${var.project_id}/\${local.ledger_database_id}/${ledgerNamespace}"
    store_contract_digest    = "${storeContractDigest}"
  }
}
`
    : ""
}
`;
}

function terraformVariables(air: AirDocument): string {
  const environment = resolveDeploymentEnvironment(air);
  const prod = environment === "prod";
  const ledgerCoordinates = needsLedger(air)
    ? `variable "anvil_bundle_hash" {
  type        = string
  description = "Exact Anvil bundle hash recorded by the reviewed ledger input receipt."
  validation {
    condition     = can(regex("^[0-9a-f]{64}$", var.anvil_bundle_hash))
    error_message = "anvil_bundle_hash must be a lowercase SHA-256 digest."
  }
}
variable "anvil_expected_project_id" {
  type        = string
  description = "Reviewed deployment project assertion. Cloud Build's project is authoritative and must match exactly."
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.anvil_expected_project_id))
    error_message = "anvil_expected_project_id must be a valid lowercase GCP project id."
  }
}
variable "anvil_ledger_input_digest" {
  type        = string
  description = "Canonical digest of bundle identity plus the reviewed non-secret ledger inputs."
  validation {
    condition     = can(regex("^[0-9a-f]{64}$", var.anvil_ledger_input_digest))
    error_message = "anvil_ledger_input_digest must be a lowercase SHA-256 digest."
  }
}
variable "ledger_database_mode" {
  type        = string
  default     = "shared"
  description = "shared uses an existing trust-domain database; dedicated creates one delete-protected database for this capability."
  validation {
    condition     = contains(["shared", "dedicated"], var.ledger_database_mode)
    error_message = "ledger_database_mode must be shared or dedicated."
  }
}
variable "ledger_database_id" {
  type        = string
  description = "Exact Firestore Native database id. In shared mode it must already exist; in dedicated mode this module creates it."
  validation {
    condition     = var.ledger_database_id == "(default)" || can(regex("^[a-z][a-z0-9-]{2,61}[a-z0-9]$", var.ledger_database_id))
    error_message = "ledger_database_id must be (default) or a 4-63 character Firestore database id."
  }
}
variable "ledger_location" {
  type        = string
  default     = null
  nullable    = true
  description = "Immutable Firestore location required only when ledger_database_mode is dedicated; ignored in shared mode because the platform owns the existing database."
  validation {
    condition     = var.ledger_location == null || can(regex("^[a-z][a-z0-9-]{1,31}[a-z0-9]$", var.ledger_location))
    error_message = "ledger_location must be null or a Firestore regional/multi-region location id."
  }
}
`
    : "";
  return `variable "project_id" { type = string }
variable "region" {
  type    = string
  default = "us-central1"
}
${ledgerCoordinates}variable "ar_repo" {
  type    = string
  default = "anvil"
}
variable "image_tag" { type = string }
variable "anvil_env" {
  type    = string
  default = "${environment}"
}
variable "min_instances" {
  type    = number
  default = ${prod ? 1 : 0}
}
variable "max_instances" {
  type    = number
  default = 10
}
variable "ledger_result_ttl_seconds" {
  type        = number
  default     = ${DEFAULT_LEDGER_RESULT_TTL_SECONDS}
  description = "Completed idempotency result retention. In-progress reservations never expire automatically."
  validation {
    condition     = var.ledger_result_ttl_seconds >= 60 && var.ledger_result_ttl_seconds <= 31536000 && floor(var.ledger_result_ttl_seconds) == var.ledger_result_ttl_seconds
    error_message = "ledger_result_ttl_seconds must be an integer from 60 to 31536000."
  }
}
variable "upstream_timeout_ms" {
  type        = number
  default     = ${DEFAULT_UPSTREAM_TIMEOUT_MS}
  description = "Bounded per-attempt upstream request timeout in milliseconds."
  validation {
    condition     = var.upstream_timeout_ms >= ${MIN_UPSTREAM_TIMEOUT_MS} && var.upstream_timeout_ms <= ${MAX_UPSTREAM_TIMEOUT_MS} && floor(var.upstream_timeout_ms) == var.upstream_timeout_ms
    error_message = "upstream_timeout_ms must be an integer from ${MIN_UPSTREAM_TIMEOUT_MS} to ${MAX_UPSTREAM_TIMEOUT_MS}."
  }
}
variable "invoker_members" {
  type    = list(string)
  default = []
}
# Ingress posture. Internal-only by default; a public connector target overrides
# this to "INGRESS_TRAFFIC_ALL" (its own inbound OAuth check is the real gate).
variable "ingress" {
  type    = string
  default = "INGRESS_TRAFFIC_INTERNAL_ONLY"
}
# When true, bind allUsers as run.invoker (public reach). Only safe when the
# server self-enforces auth — a connector target sets this alongside var.env.
variable "allow_unauthenticated" {
  type    = bool
  default = false
}
# Extra plain env for the runtime container — a connector target injects its
# ANVIL_INBOUND_* inbound-auth contract here. Secrets never go here.
variable "env" {
  type    = map(string)
  default = {}
  validation {
    condition     = alltrue([for value in values(var.env) : !can(regex("^REPLACE_ME", value))])
    error_message = "Replace every REPLACE_ME env scaffold value before planning."
  }
}
# Generated by anvil deploy credentials --tfvars to make incomplete non-secret
# OAuth configuration fail at plan time. Resolve each entry into var.env, then
# remove it; a non-empty map is deliberately invalid.
variable "anvil_unresolved_config" {
  type    = map(string)
  default = {}
  validation {
    condition     = length(var.anvil_unresolved_config) == 0
    error_message = "Resolve every anvil_unresolved_config entry into var.env before planning."
  }
}
# Static credential storage override (env | secret_manager). OAuth grants and
# delegated identity always route per operation and cannot be overridden here.
variable "credentials" {
  type    = string
  default = ""
  validation {
    condition     = contains(["", "env", "secret_manager"], var.credentials)
    error_message = "credentials must be empty, env, or secret_manager."
  }
}
# Default GCP project for shorthand sm://<secret> credential references. Empty ⇒
# falls back to project_id.
variable "secret_project" {
  type    = string
  default = ""
}
# Upstream credential references as PLAIN env: ENV_NAME → Secret Manager resource
# name (sm://projects/P/secrets/S/versions/latest). The runtime dereferences and
# TTL-caches them, so 'latest' rotates without a redeploy. Names, never values.
variable "credential_secret_refs" {
  type    = map(string)
  default = {}
}
# Secret IDs (projects/P/secrets/S) this SA may read — one scoped secretAccessor
# binding each. Provide the secrets backing credential_secret_refs here.
variable "credential_secret_ids" {
  type    = list(string)
  default = []
}
`;
}

function secretsContract(air: AirDocument): unknown {
  return {
    service: air.service.id,
    secrets: [],
    note: "The legacy one-token contract is intentionally empty. Upstream auth is per operation; use credentials.required.yaml with credential_secret_refs and credential_secret_ids.",
  };
}

/* -------------------------------------------------------------------------- */
/* Upstream (outbound) credential contract                                     */
/* -------------------------------------------------------------------------- */

/** How the runtime will resolve a given auth requirement — one row per shape. */
export interface CredentialRequirement {
  /** The operations this shape covers (canonical names), for the operator. */
  operations: string[];
  /** Concrete runtime profile after applying the source security-scheme suffix. */
  profile: string;
  /** The AuthRequirement discriminator, human-readable. */
  auth: string;
  /** Which resolver runs it: `env` (static), `delegated` (token exchange), `workload_identity`. */
  resolver: "env" | "delegated" | "workload_identity" | "unsupported";
  /** Env vars the resolver MUST find (names only — never values). */
  required: string[];
  /** Alternative complete config groups; at least one group must be supplied. */
  requiredOneOf?: string[][];
  /** Env vars it will use if present (carrier overrides, scopes, actor token). */
  optional: string[];
  /** Any human note (e.g. OBO needs a validated inbound caller token). */
  note?: string;
}

/**
 * The outbound credential contract: for every distinct auth shape across the
 * surface, the exact env vars the runtime resolver reads to reach the upstream.
 * This is the deploy-time companion to the runtime resolvers in
 * `@anvil/runtime/credentials.ts` — names only, so an operator (or `anvil deploy
 * credentials`) knows precisely what to provision, and never has to guess.
 *
 * `profile` is the auth-profile name (uppercased into the `ANVIL_<PROFILE>_*`
 * prefix). At deploy Terraform sets `ANVIL_AUTH_PROFILE` to the environment
 * (e.g. `prod`), so keys read `ANVIL_PROD_*`. Any value may be a Secret Manager
 * reference (`sm://…`), dereferenced at call time so `latest` rotates without a
 * redeploy — see the header note.
 */
export function credentialContract(
  air: AirDocument,
  profile: string = air.service.environment ?? "prod",
): {
  service: string;
  profileEnvVar: string;
  profileDefault: string;
  secretReferences: string;
  coarseOverride: string;
  requirements: CredentialRequirement[];
} {
  // Union every operation's auth (fall back to the service default), keyed by
  // classification so we emit one row per shape, not one per operation.
  const byShape = new Map<string, CredentialRequirement>();
  for (const o of air.operations.filter((operation) => operation.state === "approved")) {
    const auth: AuthRequirement = o.auth ?? air.service.auth;
    if (auth.type === "none") continue;
    const concreteProfile = credentialProfileName(profile, auth);
    const req = credentialRow(auth, concreteProfile);
    const shapeKey = `${concreteProfile}\0${req.auth}`;
    const existing = byShape.get(shapeKey);
    if (existing) existing.operations.push(o.canonicalName);
    else {
      byShape.set(shapeKey, {
        ...req,
        profile: concreteProfile,
        operations: [o.canonicalName],
      });
    }
  }
  return {
    service: air.service.id,
    profileEnvVar: "ANVIL_AUTH_PROFILE",
    profileDefault: profile,
    secretReferences:
      "Any value below may be a Secret Manager reference — `sm://projects/P/secrets/S/versions/V`, " +
      "a bare `projects/*/secrets/*/versions/*`, or shorthand `sm://<secret>` (needs ANVIL_SECRET_PROJECT). " +
      "The runtime dereferences it at call time and TTL-caches it, so `latest` rotates without a redeploy.",
    coarseOverride:
      "ANVIL_CREDENTIALS selects storage for static api-key/basic/bearer values only (env | secret_manager). " +
      "OAuth grants and delegated identity always route per operation. Unset defaults static values to Secret Manager references; an unsupported value fails closed.",
    requirements: [...byShape.values()],
  };
}

/** Classify one auth requirement into the env-var contract the runtime will read. */
function credentialRow(
  auth: AuthRequirement,
  profile: string,
): Omit<CredentialRequirement, "operations" | "profile"> {
  return credentialRequirement(profile, auth);
}

function deployReadme(air: AirDocument, resourceOptions: ResourceOptions): string {
  const id = air.service.id;
  const deploymentNamespace = resolveDeploymentNamespace(air, resourceOptions);
  const deploymentEnvironment = resolveDeploymentEnvironment(air);
  const cloudId = googleResourcePrefix(deploymentNamespace);
  return `# Deploying \`${cloudId}-tools\` to Cloud Run

Anvil emits these artifacts; you (or CI) apply them. Cloud Run is the canonical
runtime target, generated from AIR service \`${id}\` — nothing here is hand-written.

**One owner per concern.** Terraform owns every *per-capability* deployed setting
(service account, ${needsLedger(air) ? "the ledger IAM binding, " : ""}the Cloud Run service, its env
vars, scaling, and IAM). Cloud Build only builds/pushes the image and produces a
Terraform **plan** — it sets no image tag, env var, or IAM binding of its own, so
nothing can drift.

## Platform prerequisites (once per project)
These are **shared, project-level** foundations. Anvil does not own them — a
capability module must not fight another over a singleton:
- an **Artifact Registry** Docker repo named \`${"$"}{ar_repo}\` (images are pushed here);
- a **GCS bucket** for Terraform remote state;${
    needsLedger(air)
      ? `
- an existing **Firestore Native database** selected by
  \`ledger_database_id\`. The default \`ledger_database_mode = "shared"\` treats
  this as a platform-owned trust-domain singleton: each capability uses a
  collision-resistant hashed collection group and consumes **zero** additional
  database quota slots. Capability Terraform must not create or import that
  shared database. Choose \`"dedicated"\` only when the capability needs a
  separate database IAM boundary; Terraform then creates and delete-protects
  the named database and consumes one database quota slot. Dedicated mode
  requires a reviewed immutable \`ledger_location\` before the first apply
  (verify choices with
  \`gcloud firestore locations list --project YOUR_PROJECT\`).`
      : ""
  }
- required APIs enabled (run, artifactregistry, ${needsLedger(air) ? "firestore, " : ""}secretmanager, iam).

## Build & plan (Cloud Build)
\`operator.auto.tfvars.json\` is an external, reviewed input containing resource
names/references and connector settings—never secret values. Generate the
credential portion with:
\`\`\`bash
anvil deploy credentials . --env ${deploymentEnvironment} --project YOUR_PROJECT --tfvars \\
  > /SAFE_EXTERNAL_DIR/operator.auto.tfvars.json
# Edit the file: replace every REPLACE_ME value, satisfy each listed choice,${
    needsLedger(air)
      ? `
# merge the exact output of:
anvil deploy ledger . --project YOUR_PROJECT --database YOUR_DATABASE --tfvars \\
  > /SAFE_EXTERNAL_DIR/ledger.auto.tfvars.json
# The ledger input carries an expected-project assertion, bundle/runtime/store
# hashes, and a canonical input digest. Merge it without renaming fields; the
# Terraform plan fails if any value drifts or the build project differs.`
      : ""
  }
# then set anvil_unresolved_config to {}. Terraform refuses an incomplete file.
gcloud storage cp /SAFE_EXTERNAL_DIR/operator.auto.tfvars.json \\
  gs://YOUR_INPUT_BUCKET/anvil/operator.auto.tfvars.json
\`\`\`
If a target kit contributes settings, merge its documented tfvars into that
external input before upload. The reviewed plan is the point where all inputs
become immutable.

\`var.anvil_env\` and Cloud Build's \`_ANVIL_ENV\` default to
\`${deploymentEnvironment}\`, projected from AIR service environment (or
\`prod\` when AIR omits it). That value also selects the outbound credential
profile. An unknown runtime value behaves as production and emits a diagnostic;
fix AIR or the reviewed input instead of relying on that fallback.

\`\`\`bash
gcloud builds submit --project YOUR_PROJECT --config deploy/cloudbuild.yaml \\
  --substitutions _REGION=us-central1,_ANVIL_ENV=${deploymentEnvironment},_TF_STATE_BUCKET=YOUR_STATE_BUCKET,_TFVARS_URI=gs://YOUR_INPUT_BUCKET/anvil/operator.auto.tfvars.json
\`\`\`
Cloud Build builds the prebuilt image, pushes it, then runs \`terraform init\`
(binding the GCS backend) and \`terraform plan -out=tfplan\` in an external work
directory. The plan, rendered plan, and provider lock are uploaded below
\`gs://<state-bucket>/plans/<build-id>/tf-work/\`. **It does not apply** — a
capability deploy can change IAM, ingress, and scoped secret access.
The Cloud Build project is the one deployment project. For ledger-backed
bundles, Terraform requires it to equal the reviewed
\`anvil_expected_project_id\`; command-line precedence can never silently move
the store to another project. The planned \`idempotency_store\` output binds the
bundle hash, deployed-runtime hash, store-contract hash, canonical input digest,
and non-secret coordinates. Archive and compare that planned output with
\`anvil deploy ledger --json\`. It is plan evidence, not an apply receipt.

## Apply (promoted, after review)
\`\`\`bash
TF_WORK=/SAFE_EXTERNAL_DIR/apply-${deploymentNamespace}
test ! -e "$TF_WORK"
mkdir -p "$TF_WORK"
cp deploy/terraform/*.tf "$TF_WORK/"
gcloud storage cp "gs://YOUR_STATE_BUCKET/plans/BUILD_ID/tf-work/tfplan" "$TF_WORK/tfplan"
gcloud storage cp "gs://YOUR_STATE_BUCKET/plans/BUILD_ID/tf-work/tfplan.txt" "$TF_WORK/tfplan.txt"
gcloud storage cp "gs://YOUR_STATE_BUCKET/plans/BUILD_ID/tf-work/.terraform.lock.hcl" "$TF_WORK/.terraform.lock.hcl"
terraform -chdir="$TF_WORK" init \\
  -backend-config="bucket=YOUR_STATE_BUCKET" \\
  -backend-config="prefix=anvil/${deploymentNamespace}-tools"
terraform -chdir="$TF_WORK" show -no-color tfplan  # compare to reviewed tfplan.txt
terraform -chdir="$TF_WORK" apply tfplan           # exact reviewed plan; no -var here
\`\`\`

## Upstream credentials (outbound)
How the runtime reaches the API it fronts. \`deploy/credentials.required.yaml\`
lists the exact env vars per auth shape (names only) — provision each secret in
Secret Manager, then either:

- **Reference (recommended, rotates live):** pass the secret's *resource name* as
  a PLAIN env var via \`var.credential_secret_refs\` (\`ANVIL_<PROFILE>_CLIENT_SECRET\`
  = \`sm://projects/…/secrets/…/versions/latest\`) and grant read with
  \`var.credential_secret_ids\`. The runtime dereferences it at call time and
  TTL-caches it, so \`latest\` rotates without a new revision.

Resolution is per-operation by the auth shape: static \`api_key\`/\`basic\`/bearer read
directly; \`oauth2_client_credentials\` (RFC 6749 §4.4), on-behalf-of (RFC 8693 token
exchange, using the validated inbound caller token as the subject), \`jwt_bearer\`
(RFC 7523), and \`workload_identity\` (GCP metadata) mint a token from
\`ANVIL_<PROFILE>_TOKEN_ENDPOINT\`. \`ANVIL_CREDENTIALS\` selects only where static
api-key/basic/bearer values are read; it never changes OAuth grant routing. Run
\`anvil deploy credentials <dir> --env <env> --project <PROJECT_ID>\` for the
provisioning plan, or add \`--tfvars\` for external Terraform input JSON.
Token endpoints imported from the API specification are untrusted until the
operator sets \`ANVIL_CREDENTIAL_HOSTS\` to their exact public host(s); alternatively,
set \`ANVIL_<PROFILE>_TOKEN_ENDPOINT\` explicitly. Put this non-secret setting in
\`var.env\` before planning.

## Safety notes${
    needsLedger(air)
      ? `
- **Durable ledger is mandatory outside dev.** \`ANVIL_LEDGER\` points at Firestore
  (set by Terraform); the runtime refuses required-idempotency mutations if it is
  missing (fail closed). Shared mode uses the exact platform-owned database
  selected by \`ledger_database_id\`; dedicated mode creates a delete-protected
  named database. Terraform grants the runtime SA conditionally scoped access
  to the selected database. Firestore IAM conditions do **not** isolate
  collection groups, so the database—not the hashed collection name—is the
  security boundary. Put only capabilities in the same trust/regulatory domain
  in one shared database, or choose dedicated mode. Google Cloud console access
  does not enforce Firestore database IAM conditions; administer ledger data
  through condition-aware APIs/client libraries and separately restrict console
  users. \`/readyz\` performs a field-masked, non-mutating data-plane lookup
  and returns 503 if the database is missing, inaccessible, or unavailable.
  Cloud Run uses that endpoint as a bounded startup probe, so a new instance is
  not admitted before the exact database/IAM path works. It is not a liveness
  probe: later provider outages make readiness and writes fail closed without
  causing a container restart storm.
  The prebundled backend uses atomic create and update-time preconditions.
  Completed replay results carry \`expires_at\` and are subject to the generated
  Firestore TTL policy; \`var.ledger_result_ttl_seconds\` defaults to
  ${DEFAULT_LEDGER_RESULT_TTL_SECONDS} seconds (seven days). Expiry is also
  enforced logically before replay because provider TTL deletion is
  asynchronous. The TTL field's single-field indexes are disabled because the
  runtime never queries that monotonically increasing field. In-progress reservations never carry a TTL
  and are never auto-reclaimed: time passing cannot prove an upstream mutation stopped. Cached
  results can contain application response data, so set the shortest retention
  your retry window and data policy permit. One serialized replay result is
  capped at ${MAX_LEDGER_RESULT_BYTES} bytes; a larger successful response keeps
  its reservation in progress for reconciliation instead of risking a duplicate
  write. Shared mode consumes no per-capability database quota; one
  platform-owned database serves a reviewed trust domain. Dedicated mode uses
  one database quota slot per capability and requires \`ledger_location\`.
- **Provider compatibility is bounded.** The module requires Google provider
  \`${GOOGLE_PROVIDER_CONSTRAINT}\`: 7.33 is the first supported line with the
  universal \`deletion_policy\` used to abandon Firestore field policies, and the upper bound prevents an
  unreviewed future major upgrade. Cloud Build publishes
  \`.terraform.lock.hcl\` with the reviewed plan; apply that exact plan and lock.
- **Store contract is machine-readable.** \`idempotency-store.json\` records why
  the store is required, the exact database / collection group / runtime URI
  template, atomicity protocol, retention, IAM boundary, and readiness probe.
  \`anvil deploy ledger <dir>\` reads this artifact; it does not infer a second
  deployment model or call Google Cloud. Firestore has no empty-collection
  resource: Terraform configures the collection group's index/TTL policies, and
  the first atomic reservation materializes its first document.
- **External input cannot shadow runtime safety controls.** Terraform rejects
  any \`var.env\` or \`credential_secret_refs\` key that duplicates a
  compiler-owned setting such as \`ANVIL_ENV\`, \`ANVIL_LEDGER\`, the egress
  allowlist, or the timeout/retention controls. It also rejects a name supplied
  by both external maps. There is no last-write-wins path for safety settings.
- **Decommission is deliberate.** Both field policies use Terraform
  \`deletion_policy = "ABANDON"\`; a dedicated database also uses
  \`deletion_policy = "ABANDON"\` plus delete protection. If a later AIR revision
  no longer requires this ledger, Terraform removes runtime IAM/configuration
  but does not delete replay evidence or silently disable its TTL policy.
  Reintroducing the ledger requires importing both preserved field policies;
  dedicated mode also imports the database. A shared database remains owned by
  the platform state, never by this capability. Actual data deletion is a
  separate operator decision after reconciliation and retention review.
\`\`\`bash
# Only after recompiling AIR that requires the ledger and initializing the same backend:
# Dedicated mode only:
terraform -chdir="$TF_WORK" import 'google_firestore_database.ledger[0]' \\
  "projects/YOUR_PROJECT/databases/YOUR_LEDGER_DATABASE"
# Shared and dedicated modes:
terraform -chdir="$TF_WORK" import google_firestore_field.ledger_no_single_field_indexes \\
  "projects/YOUR_PROJECT/databases/YOUR_LEDGER_DATABASE/collectionGroups/${firestoreLedgerCollection(deploymentNamespace)}/fields/*"
terraform -chdir="$TF_WORK" import google_firestore_field.ledger_result_expiry \\
  "projects/YOUR_PROJECT/databases/YOUR_LEDGER_DATABASE/collectionGroups/${firestoreLedgerCollection(deploymentNamespace)}/fields/expires_at"
\`\`\`
`
      : `
- **No managed ledger is required by this surface.** No approved mutation has
  idempotency mode \`required\`, so Terraform emits no Firestore database input,
  database resource, field policy, ledger IAM, startup probe, or store output.
  This does not make a non-idempotent mutation safe: retries, confirmation, and
  approval continue to follow AIR.
`
  }
- **Remote state is required.** Without the GCS backend an ephemeral build would
  start from empty state and try to recreate live resources.
- **Proof gates stay separate.** \`/readyz\` proves the generated runtime can
  reach its ledger; it does not prove live issuer/audience validation, delegated
  token exchange, or upstream idempotency semantics. Use opted-in live
  conformance reads for the separate identity gate. Conformance never performs
  a live mutation; production writes still require the ordinary approval,
  confirmation, dry-run/canary, and upstream-audit controls.
- **Lock down the state + plan bucket.** Terraform state and the published plan
  (\`tfplan\`, and the human-readable \`tfplan.txt\`) can contain sensitive values.
  The \`_TF_STATE_BUCKET\` must use uniform bucket-level access, restricted IAM (no
  broad developer/public read), a retention/lifecycle policy, and encryption per
  your policy. If \`tfplan.txt\` exposes more than you want in the review pack, drop
  the \`terraform show\` step / its artifact path from \`cloudbuild.yaml\`.
- **Internal ingress** keeps the surface pinned; the host allowlist
  (\`ANVIL_ALLOWED_HOSTS\`) pins upstream egress.
- **No keys are stored**: callers use their own service account + ID token; the
  runtime SA reads only its own secret.

See \`terraform/main.tf\` for the exact resources and \`env.schema.json\` for the
runtime env contract.
`;
}

function envSchema(host: string | undefined, deploymentEnvironment: string): unknown {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    required: ["ANVIL_SERVICE_ID", "ANVIL_ENV", "ANVIL_ALLOWED_HOSTS"],
    properties: {
      ANVIL_SERVICE_ID: { type: "string" },
      ANVIL_ARTIFACT_VERSION: { type: "string" },
      ANVIL_ENV: {
        type: "string",
        enum: [...new Set(["dev", "staging", "prod", deploymentEnvironment])],
        default: deploymentEnvironment,
      },
      ANVIL_ALLOWED_HOSTS: {
        type: "string",
        description: "Comma-separated egress allowlist.",
        examples: [host ?? "api.internal.example.com"],
      },
      ANVIL_BASE_URL: {
        type: "string",
        description:
          "Override the compiled-in upstream base URL (loopback self-test, staging smoke). When set without ANVIL_ALLOWED_HOSTS, egress pins to this URL's host.",
      },
      ANVIL_LEDGER: {
        type: "string",
        description:
          "Durable idempotency ledger backend URI (firestore://PROJECT/DATABASE/SERVICE_NAMESPACE). Required outside dev for required-idempotency mutations.",
      },
      ANVIL_LEDGER_RESULT_TTL_SECONDS: {
        type: "string",
        pattern: "^[1-9][0-9]*$",
        default: String(DEFAULT_LEDGER_RESULT_TTL_SECONDS),
        description:
          "Completed replay-result retention in seconds (60..31536000). In-progress reservations never expire automatically.",
      },
      ANVIL_UPSTREAM_TIMEOUT_MS: {
        type: "string",
        pattern: "^[1-9][0-9]*$",
        default: String(DEFAULT_UPSTREAM_TIMEOUT_MS),
        description:
          `Per-attempt upstream timeout in milliseconds ` +
          `(${MIN_UPSTREAM_TIMEOUT_MS}..${MAX_UPSTREAM_TIMEOUT_MS}).`,
      },
      ANVIL_AUTH_PROFILE: {
        type: "string",
        description:
          "Selects the upstream credential profile: the ANVIL_<PROFILE>_* prefix. Defaults per env (e.g. prod → ANVIL_PROD_*).",
      },
      ANVIL_POLICY_BUNDLE: { type: "string" },
      ANVIL_OTEL_EXPORTER: { type: "string", examples: ["cloud_trace"] },
      ANVIL_CREDENTIALS: {
        type: "string",
        enum: ["env", "secret_manager"],
        description:
          "Storage selector for static api-key/basic/bearer values. OAuth grants and delegated identity always route per operation. Unset defaults static values to Secret Manager references.",
      },
      ANVIL_SECRET_PROJECT: {
        type: "string",
        description:
          "Default GCP project for shorthand `sm://<secret>` credential references. Full `sm://projects/…` references do not need it.",
      },
      ANVIL_CREDENTIAL_HOSTS: {
        type: "string",
        description:
          "Comma-separated exact public host allowlist for token endpoints imported from API specifications. Not needed when ANVIL_<PROFILE>_TOKEN_ENDPOINT is explicitly operator-configured.",
      },
    },
    // Per-profile upstream credential env vars (names by convention). Any value
    // may be a Secret Manager reference (`sm://…`), dereferenced at call time.
    // See deploy/credentials.required.yaml for exactly which apply to this surface.
    patternProperties: {
      "^ANVIL_[A-Z0-9_]+_(TOKEN|API_KEY|API_KEY_HEADER|API_KEY_QUERY|USERNAME|PASSWORD|TOKEN_ENDPOINT|CLIENT_ID|CLIENT_SECRET|CLIENT_ASSERTION_KEY|AUDIENCE|RESOURCE|SCOPES|ACTOR_TOKEN)$":
        {
          type: "string",
          description:
            "Upstream credential (ANVIL_<PROFILE>_*). Static schemes (api_key/basic/bearer) read directly; OAuth grants (client_credentials, RFC 8693 OBO, RFC 7523 jwt-bearer) mint a token from *_TOKEN_ENDPOINT. Provision secrets as `sm://` references.",
        },
    },
  };
}

function safeHost(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function resolveDeploymentEnvironment(air: AirDocument): string {
  const environment = air.service.environment ?? "prod";
  if (!/^[A-Za-z0-9_.~-]{1,64}$/.test(environment)) {
    throw new Error(
      "service.environment must be 1-64 shell-safe profile characters before it can become a deployment default.",
    );
  }
  return environment;
}

function resolveDeploymentNamespace(
  air: AirDocument,
  options: Pick<ResourceOptions, "deploymentNamespace">,
): string {
  const namespace = options.deploymentNamespace ?? air.service.id;
  const valid =
    options.deploymentNamespace === undefined
      ? /^[a-zA-Z0-9_.~-]{1,128}$/.test(namespace)
      : /^[a-z][a-z0-9-]{0,127}$/.test(namespace);
  if (!valid) {
    throw new Error(
      "deploymentNamespace must be a 1-128 character lowercase provider-safe id starting with a letter.",
    );
  }
  return namespace;
}

/**
 * Provider-specific projection for GCP resource names. Service-account ids are
 * the tightest consumer (30 chars including Anvil's `-tools` suffix), so every
 * deployment resource shares one deterministic <=24-char prefix.
 */
export function googleResourcePrefix(serviceId: string): string {
  const slug = serviceId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length <= 24 && slug === serviceId) return slug;
  // A provider projection is not injective (`foo_bar` and `foo-bar` both slug
  // to `foo-bar`). Preserve the readable stem but bind every transformed or
  // truncated id to its canonical identity with a stable digest.
  const digest = createHash("sha256").update(serviceId).digest("hex").slice(0, 12);
  return `${slug.slice(0, 11).replace(/-+$/g, "")}-${digest}`;
}
