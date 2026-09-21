import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type AirDocument, loadAirDocument, Operation } from "@anvil/air";
import { compile } from "@anvil/compiler";
import { SERVING_ENV_CONTRACT } from "@anvil/mcp-runtime";
import { RUNTIME_ENV_CONTRACT } from "@anvil/runtime";
import { beforeAll, describe, expect, it } from "vitest";
import { parseAllDocuments, parse as parseYaml } from "yaml";
import { generateBundle } from "./bundle.js";
import { COMPILER_OWNED_RUNTIME_ENV_NAMES, envSchema, generateDeploy } from "./deploy.js";
import {
  generateKubernetesDeploy,
  KUBERNETES_DEPLOY_FILES,
  KUBERNETES_REPLACE_PREFIX,
  kubernetesRuntimeEnv,
  kubernetesSecretKeys,
  kubernetesWorkloadName,
  splitImageReference,
} from "./deploy-kubernetes.js";

/**
 * The Kubernetes target is a second projection of the SAME deployable the
 * Cloud Run target ships: same image, same env contract, same fail-closed
 * ledger rule. These tests hold it to that — every ConfigMap key is a declared
 * contract variable, the compiler-owned set is complete, the secret keys are
 * names only, and the ledger gate is a probe the rollout cannot pass without.
 */

const read = (rel: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../../examples/payments/${rel}`, import.meta.url)),
    "utf8",
  );

let payments: AirDocument;

beforeAll(async () => {
  payments = await compile({
    spec: read("openapi.yaml"),
    manifest: read("anvil.yaml"),
    serviceId: "payments",
  });
});

function readOnlyAir(): AirDocument {
  return loadAirDocument({
    service: {
      id: "catalog",
      version: "2.0.0",
      source: { kind: "openapi" },
      servers: [{ url: "https://catalog.example.com/v2" }],
    },
    operations: [
      Operation.parse({
        id: "catalog.items.list",
        canonicalName: "list_items",
        displayName: "List items",
        sourceRef: { kind: "openapi", path: "/items", method: "get" },
        effect: { kind: "read", action: "list", resource: "item", risk: "low", reversible: false },
        input: { params: [] },
        idempotency: { mode: "natural", mechanism: "none" },
        retries: { mode: "safe", maxAttempts: 3, backoff: "exponential", retryOn: ["timeout"] },
        confirmation: { required: false },
        auth: { type: "none", scopes: [] },
        cli: { command: "items list" },
        mcp: { toolName: "list_items" },
        skill: { intentExamples: [] },
        state: "approved",
      }),
    ],
    workflows: [],
  });
}

// Parsed YAML fixtures are navigated freely; the assertions are the type.
// biome-ignore lint/suspicious/noExplicitAny: test-only view of parsed YAML
type Yaml = Record<string, any>;
const parsed = (text: string) => parseYaml(text) as Yaml;

describe("generateKubernetesDeploy", () => {
  it("emits exactly the declared file set, every manifest parses as YAML, and the set is deterministic", () => {
    const files = generateKubernetesDeploy(payments);
    expect(Object.keys(files).sort()).toEqual([...KUBERNETES_DEPLOY_FILES].sort());
    for (const [path, text] of Object.entries(files)) {
      if (path.endsWith(".md")) continue;
      const docs = parseAllDocuments(text);
      expect(docs.length, path).toBe(1);
      expect(docs[0]?.errors ?? [], path).toEqual([]);
    }
    expect(generateKubernetesDeploy(payments)).toEqual(files);
  });

  it("matches the reviewed snapshot for the reference payments bundle", () => {
    const files = generateKubernetesDeploy(payments, {}, { runtimeArtifactHash: "a".repeat(64) });
    for (const path of KUBERNETES_DEPLOY_FILES) {
      expect(files[path], path).toMatchSnapshot();
    }
  });

  it("builds the compiler-owned ConfigMap from the env contract, and only from it", () => {
    const files = generateKubernetesDeploy(payments);
    const configMap = parsed(files["deploy/kubernetes/configmap.yaml"] as string);
    const operator = parsed(files["deploy/kubernetes/operator-env.yaml"] as string);
    const declared = new Set([...RUNTIME_ENV_CONTRACT, ...SERVING_ENV_CONTRACT].map((v) => v.name));
    const schema = envSchema("api.example.com", "prod") as { properties: Record<string, unknown> };

    expect(configMap.kind).toBe("ConfigMap");
    expect(configMap.immutable).toBe(true);
    const runtimeKeys = Object.keys(configMap.data);
    for (const key of runtimeKeys) {
      expect(declared.has(key), `${key} is not in the env contract`).toBe(true);
      expect(schema.properties[key], `${key} is not in deploy/env.schema.json`).toBeDefined();
    }
    // Every contract default is carried verbatim.
    for (const variable of [...RUNTIME_ENV_CONTRACT, ...SERVING_ENV_CONTRACT]) {
      if (variable.default === undefined) continue;
      expect(configMap.data[variable.name], variable.name).toBe(variable.default);
    }
    // The compiler-owned set is complete across the two ConfigMaps — the
    // ledger URI is the one key only an operator can supply on Kubernetes.
    const operatorKeys = Object.keys(operator.data);
    for (const name of COMPILER_OWNED_RUNTIME_ENV_NAMES) {
      expect(
        runtimeKeys.includes(name) || operatorKeys.includes(name),
        `${name} is set by neither ConfigMap`,
      ).toBe(true);
    }
    expect(runtimeKeys).not.toContain("ANVIL_LEDGER");
    expect(operator.data.ANVIL_LEDGER).toBe("");
    expect(configMap.data).toMatchObject({
      ANVIL_SERVICE_ID: "payments",
      ANVIL_ENV: "prod",
      ANVIL_AUTH_PROFILE: "prod",
      ANVIL_ALLOWED_HOSTS: "payments.internal.example.com",
      ANVIL_OTEL_EXPORTER: "stdout",
      ANVIL_CREDENTIALS: "env",
      PORT: "8080",
    });
    expect(kubernetesRuntimeEnv(payments)).toEqual(configMap.data);
  });

  it("pins the ledger empty in the compiler-owned ConfigMap when no mutation requires one", () => {
    const air = readOnlyAir();
    const files = generateKubernetesDeploy(air);
    const configMap = parsed(files["deploy/kubernetes/configmap.yaml"] as string);
    const operator = parsed(files["deploy/kubernetes/operator-env.yaml"] as string);
    expect(configMap.data.ANVIL_LEDGER).toBe("");
    expect(operator.data).toEqual({});
    const deployment = parsed(files["deploy/kubernetes/deployment.yaml"] as string);
    const container = deployment.spec.template.spec.containers[0];
    expect(container.startupProbe).toBeUndefined();
    expect(container.readinessProbe.httpGet.path).toBe("/readyz");
    expect(files["deploy/kubernetes/README.md"]).toContain("no durable ledger is\nrequired");
  });

  it("gates a ledger-backed rollout on /readyz exactly as Cloud Run's startup probe does", () => {
    const files = generateKubernetesDeploy(payments);
    const deployment = parsed(files["deploy/kubernetes/deployment.yaml"] as string);
    const container = deployment.spec.template.spec.containers[0];
    expect(container.startupProbe).toMatchObject({
      httpGet: { path: "/readyz", port: 8080 },
      timeoutSeconds: 12,
      periodSeconds: 15,
      failureThreshold: 16,
    });
    expect(container.readinessProbe.httpGet.path).toBe("/readyz");
    expect(container.livenessProbe.httpGet.path).toBe("/healthz");
    // The same numbers Terraform's startup_probe carries — one deployable, two targets.
    const tf = generateDeploy(payments)["deploy/terraform/main.tf"] as string;
    expect(tf).toContain("timeout_seconds       = 12");
    expect(tf).toContain("period_seconds        = 15");
    expect(tf).toContain("failure_threshold     = 16");
    const readme = files["deploy/kubernetes/README.md"] as string;
    expect(readme).toContain("REQUIRED outside dev");
    expect(readme).toContain("payments.refunds.create");
    expect(readme).toContain("rollout status");
    expect(readme).toContain("rollout undo");
    expect(readme).toContain("kubectl apply -k deploy/kubernetes");
  });

  it("lists the compiler-owned ConfigMap LAST in envFrom so an operator ConfigMap cannot shadow it", () => {
    const files = generateKubernetesDeploy(payments);
    const deployment = parsed(files["deploy/kubernetes/deployment.yaml"] as string);
    const envFrom = deployment.spec.template.spec.containers[0].envFrom as Array<
      Record<string, { name: string; optional: boolean }>
    >;
    expect(envFrom.map((source) => Object.keys(source)[0])).toEqual([
      "configMapRef",
      "secretRef",
      "configMapRef",
    ]);
    expect(envFrom[0]?.configMapRef?.name).toBe("payments-tools-operator-env");
    expect(envFrom[2]?.configMapRef?.name).toBe("payments-tools-runtime-env");
    expect(envFrom[2]?.configMapRef?.optional).toBe(false);
    expect(deployment.spec.template.spec.containers[0].env).toBeUndefined();
  });

  it("references the credential Secret by name, non-optional, with keys from the credential contract and never a value", () => {
    const files = generateKubernetesDeploy(payments);
    const deployment = parsed(files["deploy/kubernetes/deployment.yaml"] as string);
    const secretRef = deployment.spec.template.spec.containers[0].envFrom[1].secretRef;
    expect(secretRef).toEqual({ name: "payments-tools-credentials", optional: false });
    const contract = parsed(files["deploy/kubernetes/secrets.required.yaml"] as string);
    expect(contract.secret.name).toBe("payments-tools-credentials");
    expect(contract.keys).toEqual(kubernetesSecretKeys(payments));
    expect(contract.keys.length).toBeGreaterThan(0);
    for (const key of contract.keys)
      expect(key).toMatch(/^ANVIL_PROD_.*(SECRET|TOKEN|KEY|PASSWORD)$/);
    const everything = Object.values(files).join("\n");
    expect(everything).not.toMatch(/sk_(live|test)_/);
    expect(everything).not.toMatch(/-----BEGIN/);
    // The non-secret config goes to the operator ConfigMap as a refusable scaffold.
    const operator = parsed(files["deploy/kubernetes/operator-env.yaml"] as string);
    const scaffolded = Object.entries(operator.data).filter(([, value]) =>
      String(value).startsWith(KUBERNETES_REPLACE_PREFIX),
    );
    expect(scaffolded.length).toBeGreaterThan(0);
    for (const [key] of scaffolded) expect(contract.keys).not.toContain(key);
    // A surface with no credential makes the Secret optional rather than
    // demanding an empty one.
    const bare = generateKubernetesDeploy(readOnlyAir());
    const bareDeployment = parsed(bare["deploy/kubernetes/deployment.yaml"] as string);
    expect(bareDeployment.spec.template.spec.containers[0].envFrom[1].secretRef.optional).toBe(
      true,
    );
  });

  it("owns the image in kustomization.yaml and scaffolds it refusably unless an operator names one", () => {
    const scaffold = parsed(
      generateKubernetesDeploy(payments)["deploy/kubernetes/kustomization.yaml"] as string,
    );
    expect(scaffold.namespace).toBe("anvil");
    expect(scaffold.images).toEqual([
      {
        name: "anvil-runtime",
        newName: `${KUBERNETES_REPLACE_PREFIX}REGISTRY/payments-tools`,
        newTag: `${KUBERNETES_REPLACE_PREFIX}IMAGE_TAG`,
      },
    ]);
    const deployment = parsed(
      generateKubernetesDeploy(payments)["deploy/kubernetes/deployment.yaml"] as string,
    );
    expect(deployment.spec.template.spec.containers[0].image).toBe("anvil-runtime");

    const named = parsed(
      generateKubernetesDeploy(
        payments,
        {},
        { image: "europe-docker.pkg.dev/proj/anvil/payments-tools:abc123", namespace: "billing" },
      )["deploy/kubernetes/kustomization.yaml"] as string,
    );
    expect(named.namespace).toBe("billing");
    expect(named.images[0]).toEqual({
      name: "anvil-runtime",
      newName: "europe-docker.pkg.dev/proj/anvil/payments-tools",
      newTag: "abc123",
    });
    expect(splitImageReference("ghcr.io/org/app@sha256:deadbeef")).toEqual({
      newName: "ghcr.io/org/app",
      digest: "sha256:deadbeef",
    });
    expect(splitImageReference("localhost:5000/app")).toEqual({ newName: "localhost:5000/app" });
  });

  it("stamps the pod template with the runtime artifact hash and hardens the pod", () => {
    const files = generateKubernetesDeploy(payments, {}, { runtimeArtifactHash: "f".repeat(64) });
    const deployment = parsed(files["deploy/kubernetes/deployment.yaml"] as string);
    expect(deployment.spec.template.metadata.annotations["anvil.dev/runtime-artifact-hash"]).toBe(
      "f".repeat(64),
    );
    const spec = deployment.spec.template.spec;
    expect(spec.serviceAccountName).toBe("payments-tools");
    expect(spec.automountServiceAccountToken).toBe(false);
    expect(spec.securityContext.runAsNonRoot).toBe(true);
    expect(spec.containers[0].securityContext).toEqual({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"] },
    });
    const sa = parsed(files["deploy/kubernetes/serviceaccount.yaml"] as string);
    expect(sa.automountServiceAccountToken).toBe(false);
    const service = parsed(files["deploy/kubernetes/service.yaml"] as string);
    expect(service.spec.type).toBe("ClusterIP");
    expect(service.spec.selector).toEqual({ "app.kubernetes.io/name": "payments-tools" });
    expect(kubernetesWorkloadName(payments)).toBe("payments-tools");
  });

  it("refuses a namespace that is not a DNS label", () => {
    expect(() => generateKubernetesDeploy(payments, {}, { namespace: "Prod_Env" })).toThrow(
      /DNS label/,
    );
  });

  it("is part of every compiled bundle, byte-identical to a direct generation with the compile's options", () => {
    const { files } = generateBundle(payments);
    for (const path of KUBERNETES_DEPLOY_FILES) expect(files[path], path).toBeDefined();
    const deployment = parsed(files["deploy/kubernetes/deployment.yaml"] as string);
    const stamped =
      deployment.spec.template.metadata.annotations["anvil.dev/runtime-artifact-hash"];
    expect(stamped).toMatch(/^[0-9a-f]{64}$/);
    // Terraform binds the same runtime artifact hash: one deployable, two targets.
    expect(files["deploy/terraform/main.tf"]).toContain(`runtime_artifact_hash = "${stamped}"`);
    expect(files["deploy/ci/github-actions.yml"]).toBeDefined();
  });
});
