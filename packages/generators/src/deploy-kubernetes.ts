import type { AirDocument } from "@anvil/air";
import { SERVING_ENV_CONTRACT } from "@anvil/mcp-runtime";
import { RUNTIME_ENV_CONTRACT } from "@anvil/runtime";
import { stringify as toYaml } from "yaml";
import {
  COMPILER_OWNED_RUNTIME_ENV_NAMES,
  credentialContract,
  googleResourcePrefix,
  idempotencyStoreContract,
  resolveDeploymentEnvironment,
  resolveDeploymentNamespace,
  safeHost,
} from "./deploy.js";
import type { ResourceOptions } from "./resources.js";

/**
 * Kubernetes deployment artifacts — the second deploy target, beside Cloud Run.
 *
 * Same runtime image (`deploy/Dockerfile`, distroless, prebuilt), same env
 * contract (`RUNTIME_ENV_CONTRACT` + `SERVING_ENV_CONTRACT`, the exact tables
 * `deploy/env.schema.json` is generated from), same fail-closed posture: a
 * bundle with a required-idempotency mutation is not Ready until `/readyz`
 * proves a durable ledger, exactly as Cloud Run's startup probe gates it.
 *
 * **One owner per concern**, projected onto kustomize:
 *
 *   - `configmap.yaml` (compiler-owned runtime env) is what Terraform's fixed
 *     `env {}` blocks are on Cloud Run. It is listed LAST in the container's
 *     `envFrom`, and Kubernetes gives the last source precedence, so an
 *     operator ConfigMap can never shadow a safety control — the kustomize
 *     equivalent of the Terraform precondition that refuses a `var.env` key
 *     duplicating a compiler-owned name.
 *   - `operator-env.yaml` is `var.env`: the non-secret settings only an
 *     operator can supply (the ledger URI, credential config, inbound auth).
 *   - `secrets.required.yaml` names the Secret and its keys (from the same
 *     credential contract `deploy/credentials.required.yaml` documents) and
 *     never a value; the Deployment references it by name, non-optional.
 *   - `kustomization.yaml` owns the image, the namespace, and the labels.
 *
 * Anvil emits these; it never talks to a cluster. `anvil deploy kubernetes`
 * prints the apply/rollout commands and can re-project this set with an
 * operator's image and namespace to an external directory.
 */

export const KUBERNETES_DEPLOY_PREFIX = "deploy/kubernetes/";
/** The image name the Deployment references; kustomize's `images` transformer rewrites it. */
export const KUBERNETES_IMAGE_PLACEHOLDER_NAME = "anvil-runtime";
export const KUBERNETES_DEFAULT_NAMESPACE = "anvil";
export const KUBERNETES_REPLACE_PREFIX = "REPLACE_WITH_";
export const KUBERNETES_DEPLOY_FILES = [
  "deploy/kubernetes/kustomization.yaml",
  "deploy/kubernetes/serviceaccount.yaml",
  "deploy/kubernetes/configmap.yaml",
  "deploy/kubernetes/operator-env.yaml",
  "deploy/kubernetes/deployment.yaml",
  "deploy/kubernetes/service.yaml",
  "deploy/kubernetes/secrets.required.yaml",
  "deploy/kubernetes/README.md",
] as const;

const CONTAINER_PORT = 8080;

export interface KubernetesDeployOptions {
  /** Kubernetes namespace the kustomization targets (a DNS label). Default `anvil`. */
  namespace?: string;
  /**
   * Full image reference (`registry/repo[:tag]`) kustomize rewrites the
   * Deployment to. Absent, a `REPLACE_WITH_*` scaffold is emitted, and every
   * plan step refuses a rendered manifest that still carries it.
   */
  image?: string;
  /** `deploymentArtifactHash` of the bundle's `deploy/runtime/`, stamped on the pod template. */
  runtimeArtifactHash?: string;
}

/** True when an env key names a secret value rather than a config value (an endpoint, a scope). */
export function isSecretCredentialEnvName(name: string): boolean {
  return /_(CLIENT_SECRET|CLIENT_ASSERTION_KEY|TOKEN|PASSWORD|API_KEY)$/.test(name);
}

interface KubernetesNames {
  serviceId: string;
  name: string;
  namespace: string;
  environment: string;
  runtimeEnvConfigMap: string;
  operatorEnvConfigMap: string;
  credentialsSecret: string;
}

function resolveNames(
  air: AirDocument,
  resourceOptions: ResourceOptions,
  options: KubernetesDeployOptions,
): KubernetesNames {
  const namespace = options.namespace ?? KUBERNETES_DEFAULT_NAMESPACE;
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(namespace)) {
    throw new Error(
      "Kubernetes namespace must be a DNS label: 1-63 lowercase alphanumerics or hyphens, starting and ending alphanumeric.",
    );
  }
  const name = `${googleResourcePrefix(resolveDeploymentNamespace(air, resourceOptions))}-tools`;
  return {
    serviceId: air.service.id,
    name,
    namespace,
    environment: resolveDeploymentEnvironment(air),
    runtimeEnvConfigMap: `${name}-runtime-env`,
    operatorEnvConfigMap: `${name}-operator-env`,
    credentialsSecret: `${name}-credentials`,
  };
}

/** `registry/repo[:tag]` → kustomize `images` entry; a digest reference keeps its digest. */
export function splitImageReference(image: string): {
  newName: string;
  newTag?: string;
  digest?: string;
} {
  const at = image.indexOf("@");
  if (at >= 0) return { newName: image.slice(0, at), digest: image.slice(at + 1) };
  const lastSlash = image.lastIndexOf("/");
  const colon = image.lastIndexOf(":");
  if (colon > lastSlash) return { newName: image.slice(0, colon), newTag: image.slice(colon + 1) };
  return { newName: image };
}

/**
 * The compiler-owned runtime environment: every contract variable with a
 * declared default, plus the per-bundle facts Terraform fixes on Cloud Run.
 * Derived from the same tables as `deploy/env.schema.json`, so the drift guard
 * that keeps the schema honest keeps this ConfigMap honest too.
 */
export function kubernetesRuntimeEnv(
  air: AirDocument,
  resourceOptions: Pick<ResourceOptions, "deploymentNamespace"> = {},
): Record<string, string> {
  const store = idempotencyStoreContract(air, resourceOptions);
  const environment = resolveDeploymentEnvironment(air);
  const data: Record<string, string> = {};
  for (const variable of [...RUNTIME_ENV_CONTRACT, ...SERVING_ENV_CONTRACT]) {
    if (variable.default !== undefined) data[variable.name] = variable.default;
  }
  Object.assign(data, {
    ANVIL_SERVICE_ID: air.service.id,
    ANVIL_ENV: environment,
    ANVIL_ALLOWED_HOSTS: safeHost(air.service.servers[0]?.url) ?? "",
    ANVIL_AUTH_PROFILE: environment,
    // Structured records on stdout: the cluster's log pipeline collects them.
    // An OTLP collector is an operator choice made in the operator ConfigMap
    // only if this key is removed from the compiler-owned one — it is not.
    ANVIL_OTEL_EXPORTER: "stdout",
    // Static credentials arrive as Secret-backed env, never as sm:// references.
    ANVIL_CREDENTIALS: "env",
    ANVIL_SECRET_PROJECT: "",
    PORT: String(CONTAINER_PORT),
  });
  // A required ledger is the ONE compiler-owned setting only the operator can
  // supply on Kubernetes (there is no Terraform to compute a firestore:// URI
  // from reviewed inputs). It moves to the operator ConfigMap as a scaffold
  // the runtime fails closed on until it is set; a surface with no required
  // ledger pins it empty here, as Terraform does.
  if (!store.required) data.ANVIL_LEDGER = "";
  return data;
}

interface OperatorEnvScaffold {
  data: Record<string, string>;
  ledgerRequired: boolean;
  ledgerOperationIds: string[];
  requiredConfig: string[];
  configAlternatives: string[][];
}

function operatorEnvScaffold(
  air: AirDocument,
  resourceOptions: Pick<ResourceOptions, "deploymentNamespace">,
): OperatorEnvScaffold {
  const store = idempotencyStoreContract(air, resourceOptions);
  const contract = credentialContract(air, resolveDeploymentEnvironment(air));
  const requiredConfig = [
    ...new Set(
      contract.requirements.flatMap((requirement) =>
        requirement.required.filter((key) => !isSecretCredentialEnvName(key)),
      ),
    ),
  ].sort();
  const configAlternatives = contract.requirements.flatMap(
    (requirement) => requirement.requiredOneOf ?? [],
  );
  const data: Record<string, string> = {};
  if (store.required) data.ANVIL_LEDGER = "";
  for (const key of requiredConfig) data[key] = `${KUBERNETES_REPLACE_PREFIX}${key}`;
  return {
    data,
    ledgerRequired: store.required,
    ledgerOperationIds: store.requirement.operationIds,
    requiredConfig,
    configAlternatives,
  };
}

/** The Secret keys (env names) this surface's upstream credentials need — names only. */
export function kubernetesSecretKeys(air: AirDocument): string[] {
  const contract = credentialContract(air, resolveDeploymentEnvironment(air));
  return [
    ...new Set(
      contract.requirements.flatMap((requirement) =>
        requirement.required.filter(isSecretCredentialEnvName),
      ),
    ),
  ].sort();
}

function header(names: KubernetesNames, what: string): string {
  return `# Generated by Anvil — ${what} for "${names.serviceId}" (${names.name}).\n# Anvil emits this manifest; it never applies it. Regenerate with anvil, never hand-edit.\n`;
}

function labels(names: KubernetesNames): Record<string, string> {
  return {
    "app.kubernetes.io/name": names.name,
    "app.kubernetes.io/part-of": "anvil",
    "app.kubernetes.io/component": "mcp-runtime",
  };
}

function annotations(names: KubernetesNames, options: KubernetesDeployOptions) {
  return {
    "anvil.dev/service-id": names.serviceId,
    "anvil.dev/deployment-environment": names.environment,
    ...(options.runtimeArtifactHash
      ? { "anvil.dev/runtime-artifact-hash": options.runtimeArtifactHash }
      : {}),
  };
}

function serviceAccount(names: KubernetesNames): string {
  return (
    header(names, "runtime ServiceAccount") +
    toYaml({
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: { name: names.name, labels: labels(names) },
      // The runtime never calls the Kubernetes API; no token is mounted.
      automountServiceAccountToken: false,
    })
  );
}

function runtimeEnvConfigMap(
  names: KubernetesNames,
  air: AirDocument,
  resourceOptions: ResourceOptions,
): string {
  return (
    header(names, "compiler-owned runtime environment") +
    "# Listed LAST in the Deployment's envFrom so it takes precedence: an operator\n" +
    "# ConfigMap cannot shadow a safety control (ANVIL_ENV, the egress allowlist,\n" +
    "# timeouts, retention). Every key is declared in deploy/env.schema.json.\n" +
    toYaml({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: names.runtimeEnvConfigMap, labels: labels(names) },
      immutable: true,
      data: kubernetesRuntimeEnv(air, resourceOptions),
    })
  );
}

function operatorEnvConfigMap(names: KubernetesNames, scaffold: OperatorEnvScaffold): string {
  const lines = [
    header(names, "operator-supplied environment (non-secret)"),
    "# The Kubernetes form of Terraform's var.env: settings only an operator can\n",
    "# decide. Replace every REPLACE_WITH_ value in an overlay before applying;\n",
    "# the plan steps in README.md refuse a rendered manifest that still has one.\n",
  ];
  if (scaffold.ledgerRequired) {
    lines.push(
      "# ANVIL_LEDGER is REQUIRED outside dev: set it to a durable ledger URI\n",
      "# (firestore://PROJECT/DATABASE/NAMESPACE, or a scheme an ANVIL_EXTENSIONS\n",
      "# module registers). Left empty, /readyz answers 503 and the rollout never\n",
      "# becomes Ready — the runtime refuses required-idempotency mutations without it.\n",
    );
  }
  if (scaffold.configAlternatives.length > 0) {
    lines.push(
      "# Choose one complete option per credential shape and add its keys here:\n",
      ...scaffold.configAlternatives.map((option) => `#   - ${option.join(" + ")}\n`),
    );
  }
  return (
    lines.join("") +
    toYaml({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: names.operatorEnvConfigMap, labels: labels(names) },
      data: scaffold.data,
    })
  );
}

function deployment(
  names: KubernetesNames,
  options: KubernetesDeployOptions,
  scaffold: OperatorEnvScaffold,
  secretKeys: string[],
): string {
  const probe = (path: string) => ({ httpGet: { path, port: CONTAINER_PORT, scheme: "HTTP" } });
  return (
    header(names, "runtime Deployment") +
    toYaml({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: {
        name: names.name,
        labels: labels(names),
        annotations: annotations(names, options),
      },
      spec: {
        replicas: names.environment === "prod" ? 2 : 1,
        revisionHistoryLimit: 5,
        selector: { matchLabels: { "app.kubernetes.io/name": names.name } },
        strategy: { type: "RollingUpdate", rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } },
        template: {
          metadata: { labels: labels(names), annotations: annotations(names, options) },
          spec: {
            serviceAccountName: names.name,
            automountServiceAccountToken: false,
            securityContext: {
              runAsNonRoot: true,
              // gcr.io/distroless nonroot user.
              runAsUser: 65532,
              runAsGroup: 65532,
              seccompProfile: { type: "RuntimeDefault" },
            },
            containers: [
              {
                name: "runtime",
                // Rewritten by kustomization.yaml's `images` transformer: the
                // image built from deploy/Dockerfile with the bundle root as context.
                image: KUBERNETES_IMAGE_PLACEHOLDER_NAME,
                imagePullPolicy: "IfNotPresent",
                ports: [{ name: "http", containerPort: CONTAINER_PORT, protocol: "TCP" }],
                // Order matters: Kubernetes gives the LAST envFrom source
                // precedence, and the compiler-owned ConfigMap is last.
                envFrom: [
                  { configMapRef: { name: names.operatorEnvConfigMap, optional: false } },
                  {
                    secretRef: {
                      name: names.credentialsSecret,
                      // A surface that needs no static credential still boots
                      // without the Secret; one that does refuses to start
                      // without it (no silent anonymous upstream).
                      optional: secretKeys.length === 0,
                    },
                  },
                  { configMapRef: { name: names.runtimeEnvConfigMap, optional: false } },
                ],
                resources: {
                  requests: { cpu: "250m", memory: "256Mi" },
                  limits: { cpu: "1", memory: "512Mi" },
                },
                ...(scaffold.ledgerRequired
                  ? {
                      // Same numbers as the Cloud Run startup probe: a new pod
                      // is not admitted before the exact ledger path works.
                      startupProbe: {
                        ...probe("/readyz"),
                        timeoutSeconds: 12,
                        periodSeconds: 15,
                        failureThreshold: 16,
                      },
                    }
                  : {}),
                // Readiness proves the ledger (503 → out of the Service); a
                // later provider outage removes the pod from rotation and fails
                // writes closed without a restart storm — liveness is /healthz.
                readinessProbe: { ...probe("/readyz"), periodSeconds: 10, timeoutSeconds: 5 },
                livenessProbe: {
                  ...probe("/healthz"),
                  periodSeconds: 20,
                  timeoutSeconds: 5,
                  failureThreshold: 3,
                },
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ["ALL"] },
                },
              },
            ],
          },
        },
      },
    })
  );
}

function service(names: KubernetesNames): string {
  return (
    header(names, "ClusterIP Service") +
    "# Cluster-internal by default — the Cloud Run 'internal ingress' posture. An\n" +
    "# Ingress or Gateway that exposes /mcp beyond the cluster must front a server\n" +
    "# that self-enforces inbound auth (ANVIL_INBOUND_* in the operator ConfigMap).\n" +
    toYaml({
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: names.name, labels: labels(names) },
      spec: {
        type: "ClusterIP",
        selector: { "app.kubernetes.io/name": names.name },
        ports: [{ name: "http", port: 80, targetPort: "http", protocol: "TCP" }],
      },
    })
  );
}

function kustomization(names: KubernetesNames, options: KubernetesDeployOptions): string {
  const image = splitImageReference(
    options.image ?? `${KUBERNETES_REPLACE_PREFIX}REGISTRY/${names.name}`,
  );
  return (
    header(names, "kustomization") +
    "# Single owner of the image, the namespace, and the labels. Render with\n" +
    "# `kubectl kustomize deploy/kubernetes`; apply only the reviewed render.\n" +
    toYaml({
      apiVersion: "kustomize.config.k8s.io/v1beta1",
      kind: "Kustomization",
      namespace: names.namespace,
      resources: [
        "serviceaccount.yaml",
        "configmap.yaml",
        "operator-env.yaml",
        "deployment.yaml",
        "service.yaml",
      ],
      images: [
        {
          name: KUBERNETES_IMAGE_PLACEHOLDER_NAME,
          newName: image.newName,
          ...(image.digest
            ? { digest: image.digest }
            : { newTag: image.newTag ?? `${KUBERNETES_REPLACE_PREFIX}IMAGE_TAG` }),
        },
      ],
    })
  );
}

function secretsRequired(names: KubernetesNames, secretKeys: string[]): string {
  return (
    header(names, "required Secret (names only)") +
    "# Not a Kubernetes manifest and not listed in kustomization.yaml: the contract\n" +
    "# for the Secret the Deployment references by name. Create it from your own\n" +
    "# store; Anvil never holds or echoes a value. Keys are the exact env names in\n" +
    "# deploy/credentials.required.yaml.\n" +
    toYaml({
      service: names.serviceId,
      secret: { name: names.credentialsSecret, namespace: names.namespace, type: "Opaque" },
      referencedBy: `deployment/${names.name} (envFrom.secretRef, optional: ${secretKeys.length === 0})`,
      keys: secretKeys,
      note:
        secretKeys.length === 0
          ? "The approved surface needs no static upstream credential; the Secret is optional."
          : "Every key is required. A missing Secret keeps the pod from starting (fail closed).",
    })
  );
}

function readme(
  names: KubernetesNames,
  options: KubernetesDeployOptions,
  scaffold: OperatorEnvScaffold,
  secretKeys: string[],
): string {
  const image =
    options.image ??
    `${KUBERNETES_REPLACE_PREFIX}REGISTRY/${names.name}:${KUBERNETES_REPLACE_PREFIX}IMAGE_TAG`;
  const secretCommand =
    secretKeys.length > 0
      ? `kubectl -n ${names.namespace} create secret generic ${names.credentialsSecret} \\
${secretKeys.map((key) => `  --from-literal=${key}="$${key}"`).join(" \\\n")}
# each $${"<KEY>"} read from your own secret store — never typed into a shell history`
      : `# No static upstream credential is required; the Secret reference is optional.`;
  return `# Deploying \`${names.name}\` to Kubernetes

Anvil emits these manifests; you (or CI) apply them. They are generated from
AIR service \`${names.serviceId}\` and the same runtime image, env contract, and
fail-closed rules as the Cloud Run target (\`deploy/README.md\`). Anvil never
contacts a cluster.

**One owner per concern.** \`kustomization.yaml\` owns the image, namespace, and
labels. \`configmap.yaml\` is compiler-owned runtime environment and is listed
last in the container's \`envFrom\`, so it takes precedence over anything an
operator supplies — nothing can shadow \`ANVIL_ENV\`, the egress allowlist, the
timeouts, or retention. \`operator-env.yaml\` is what only you can decide.
\`secrets.required.yaml\` names the Secret and its keys; it never holds a value.

## Platform prerequisites (once per cluster)
- the namespace: \`kubectl create namespace ${names.namespace}\`;
- a registry the cluster can pull from, and push access for CI;
- an Ingress/Gateway only if \`/mcp\` must be reached from outside the cluster —
  then \`ANVIL_INBOUND_AUTH_MODE\` (and its \`ANVIL_INBOUND_*\` family) must be set
  in \`operator-env.yaml\`, because the server's own token check is the gate, not
  network reachability.

## Durable ledger${
    scaffold.ledgerRequired
      ? ` — REQUIRED outside dev
Approved mutation(s) with required idempotency keys: ${scaffold.ledgerOperationIds.map((id) => `\`${id}\``).join(", ")}.
Set \`ANVIL_LEDGER\` in \`operator-env.yaml\` to a durable ledger URI
(\`firestore://PROJECT/DATABASE/NAMESPACE\`, or a scheme an \`ANVIL_EXTENSIONS\`
module registers) before applying outside \`dev\`. This fails closed the same way
Cloud Run does: \`/readyz\` answers 503 until the ledger is reachable, the startup
probe never admits the pod, \`rollout status\` times out, and the runtime refuses
required-idempotency mutations. \`anvil deploy ledger <bundle>\` prints the exact
write/store contract.`
      : `
No approved mutation requires an idempotency key, so no durable ledger is
required and \`ANVIL_LEDGER\` is pinned empty by the compiler-owned ConfigMap.
This does not make a non-idempotent mutation safe: retries, confirmation, and
approval continue to follow AIR.`
  }

## Build the image
\`\`\`bash
docker build -f deploy/Dockerfile -t ${image} .
docker push ${image}
\`\`\`
The context is the bundle root; \`deploy/Dockerfile.dockerignore\` keeps the
image to \`deploy/runtime/\` (prebuilt, distroless, non-root).

## Provide the operator inputs
\`\`\`bash
${secretCommand}
\`\`\`
Then set every \`REPLACE_WITH_\` value${scaffold.ledgerRequired ? " and `ANVIL_LEDGER`" : ""} — with
\`anvil deploy kubernetes <bundle> --image ${options.image ?? "<registry>/<repo>:<tag>"} --namespace ${names.namespace} --out <dir>\`
(the same generator, re-projected outside the certified bundle), or with a
kustomize overlay that patches \`${names.operatorEnvConfigMap}\` and sets \`images\`.${
    scaffold.requiredConfig.length > 0
      ? `
Required non-secret config: ${scaffold.requiredConfig.map((key) => `\`${key}\``).join(", ")}.`
      : ""
  }

## Plan (render, review, dry-run — no apply)
\`\`\`bash
kubectl kustomize deploy/kubernetes > rendered.yaml
! grep -q ${KUBERNETES_REPLACE_PREFIX} rendered.yaml      # refuse an unfilled scaffold
kubectl apply -k deploy/kubernetes --dry-run=server
\`\`\`

## Apply and roll out (after review)
\`\`\`bash
kubectl apply -k deploy/kubernetes
kubectl -n ${names.namespace} rollout status deployment/${names.name} --timeout=300s
kubectl -n ${names.namespace} get pods -l app.kubernetes.io/name=${names.name}
\`\`\`
A rollout that never becomes Ready is the fail-closed answer: read
\`kubectl -n ${names.namespace} describe deployment/${names.name}\` and the pod's
\`/readyz\` body (\`code: ledger_unavailable\`) before touching anything else.

## Roll back
\`\`\`bash
kubectl -n ${names.namespace} rollout undo deployment/${names.name}
\`\`\`

## Safety notes
- **Probes.** \`/readyz\` is readiness${scaffold.ledgerRequired ? " and the startup gate" : ""}: it performs a non-mutating
  ledger lookup and answers 503 when the ledger is missing or unreachable.
  \`/healthz\` is liveness only — a provider outage takes the pod out of the
  Service and fails writes closed; it never causes a restart storm.
- **Env precedence is the safety boundary.** Kubernetes gives the last
  \`envFrom\` source precedence and \`${names.runtimeEnvConfigMap}\` is last. Do
  not reorder the list; do not add keys from \`deploy/env.schema.json\`'s
  compiler-owned set (\`${[...COMPILER_OWNED_RUNTIME_ENV_NAMES].join("`, `")}\`)
  to the operator ConfigMap.
- **Secrets by reference.** The Secret is referenced by name, non-optional when
  the surface needs one; the pod does not start without it. \`ANVIL_CREDENTIALS=env\`
  reads static values from that Secret-backed env; OAuth grants and delegated
  identity still route per operation.
- **Internal by default.** A ClusterIP Service is the Cloud Run "internal
  ingress" posture; \`ANVIL_ALLOWED_HOSTS\` pins upstream egress.
- **Records.** \`ANVIL_OTEL_EXPORTER=stdout\` emits one structured record per
  call for the cluster's log pipeline; \`/metrics\` serves OpenMetrics to a scraper.
- **Plan evidence, not apply proof.** A rendered manifest proves what would be
  applied, not that it was. \`anvil publish --target kubernetes\` gates the plan
  on fresh certification and executable evidence and records it in
  \`publication.json\`; the apply remains an operator action.
`;
}

/**
 * The Kubernetes deploy set for a bundle. `resourceOptions` are the compile's
 * own (so `anvil certify` re-projects this byte for byte from
 * `generation.json`); `options` are an operator's overrides, applied only
 * when `anvil deploy kubernetes --out` re-projects the set outside the bundle.
 */
export function generateKubernetesDeploy(
  air: AirDocument,
  resourceOptions: ResourceOptions = {},
  options: KubernetesDeployOptions = {},
): Record<string, string> {
  const names = resolveNames(air, resourceOptions, options);
  const scaffold = operatorEnvScaffold(air, resourceOptions);
  const secretKeys = kubernetesSecretKeys(air);
  return {
    "deploy/kubernetes/kustomization.yaml": kustomization(names, options),
    "deploy/kubernetes/serviceaccount.yaml": serviceAccount(names),
    "deploy/kubernetes/configmap.yaml": runtimeEnvConfigMap(names, air, resourceOptions),
    "deploy/kubernetes/operator-env.yaml": operatorEnvConfigMap(names, scaffold),
    "deploy/kubernetes/deployment.yaml": deployment(names, options, scaffold, secretKeys),
    "deploy/kubernetes/service.yaml": service(names),
    "deploy/kubernetes/secrets.required.yaml": secretsRequired(names, secretKeys),
    "deploy/kubernetes/README.md": readme(names, options, scaffold, secretKeys),
  };
}

/** The workload name `anvil deploy kubernetes` and `anvil publish` refer to. */
export function kubernetesWorkloadName(
  air: AirDocument,
  resourceOptions: Pick<ResourceOptions, "deploymentNamespace"> = {},
): string {
  return `${googleResourcePrefix(resolveDeploymentNamespace(air, resourceOptions))}-tools`;
}
