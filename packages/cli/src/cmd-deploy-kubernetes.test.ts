import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { KUBERNETES_DEPLOY_FILES } from "@anvil/generators";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { runAnvilCli } from "./anvil-cli.js";
import { bufferIO } from "./io.js";

/**
 * `anvil deploy kubernetes` and `anvil sdk publish-plan` — both plan-only
 * surfaces over a real compiled bundle. What these guard: the compiled
 * deploy/kubernetes/ set is compiler-owned (certify stays green with it in
 * the bundle), the re-projection carries the operator's image and namespace
 * OUTSIDE the bundle, and neither command ever leaves the machine.
 */

const payments = fileURLToPath(new URL("../../../examples/payments/", import.meta.url));
let root: string;
let bundle: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "anvil-deploy-kubernetes-"));
  bundle = join(root, "bundle");
  const io = bufferIO();
  const code = await runAnvilCli(
    [
      "compile",
      join(payments, "openapi.yaml"),
      "--manifest",
      join(payments, "anvil.yaml"),
      "--service",
      "payments",
      "--out",
      bundle,
      "--root",
      root,
    ],
    { io },
  );
  expect(code, io.text()).toBe(0);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

async function cli(args: string[]) {
  const io = bufferIO();
  const code = await runAnvilCli(args, { io });
  return { code, io, out: io.stdout.join("\n"), err: io.stderr.join("\n") };
}

describe("anvil deploy kubernetes", () => {
  it("compile emits the kustomize set under deploy/kubernetes/ and certify accepts it as compiler-owned", async () => {
    for (const rel of KUBERNETES_DEPLOY_FILES)
      expect(existsSync(join(bundle, rel)), rel).toBe(true);
    expect(existsSync(join(bundle, "deploy/ci/github-actions.yml"))).toBe(true);
    const certify = await cli(["certify", bundle]);
    expect(certify.code, certify.io.text()).toBe(0);
  });

  it("prints the apply/rollout plan without --out and makes no cluster call", async () => {
    const result = await cli(["deploy", "kubernetes", bundle]);
    expect(result.code, result.io.text()).toBe(0);
    expect(result.out).toContain("Kubernetes deployment plan only");
    expect(result.out).toContain("No cluster call is made by this command");
    expect(result.out).toContain("kubectl create namespace anvil");
    expect(result.out).toContain("A durable ledger is REQUIRED outside dev");
    expect(result.out).toContain("exactly as Cloud Run's startup probe");
    expect(result.out).toContain("kubectl apply -k <plan-dir> --dry-run=server");
    expect(result.out).toContain("rollout status deployment/payments-tools");
    expect(result.out).toContain("rollout undo deployment/payments-tools");
    expect(result.out).toContain("deploy/ci/github-actions.yml");
    expect(result.out).toContain("no cluster resource was changed");
  });

  it("refuses per-deployment overrides without --out, because the compiled set is compiler-owned", async () => {
    const result = await cli([
      "deploy",
      "kubernetes",
      bundle,
      "--image",
      "ghcr.io/acme/payments:1",
    ]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("need --out");
    const before = readFileSync(join(bundle, "deploy/kubernetes/kustomization.yaml"), "utf8");
    expect(before).toContain("REPLACE_WITH_REGISTRY");
  });

  it("re-projects the same manifests with --image/--namespace/--ci to an external directory, leaving the bundle certified", async () => {
    const out = join(root, "plan");
    const result = await cli([
      "deploy",
      "kubernetes",
      bundle,
      "--out",
      out,
      "--image",
      "ghcr.io/acme/payments-tools:sha-abc",
      "--namespace",
      "billing",
      "--ci",
      "github-actions",
    ]);
    expect(result.code, result.io.text()).toBe(0);
    expect(result.out).toContain("Wrote 9 file(s) for payments-tools");
    expect(result.out).toContain("No cluster call was made");
    expect(readdirSync(out).sort()).toEqual([
      "README.md",
      "ci",
      "configmap.yaml",
      "deployment.yaml",
      "kustomization.yaml",
      "operator-env.yaml",
      "secrets.required.yaml",
      "service.yaml",
      "serviceaccount.yaml",
    ]);
    const kustomization = parseYaml(readFileSync(join(out, "kustomization.yaml"), "utf8"));
    expect(kustomization.namespace).toBe("billing");
    expect(kustomization.images).toEqual([
      { name: "anvil-runtime", newName: "ghcr.io/acme/payments-tools", newTag: "sha-abc" },
    ]);
    const deployment = parseYaml(readFileSync(join(out, "deployment.yaml"), "utf8"));
    const container = deployment.spec.template.spec.containers[0];
    expect(container.startupProbe.httpGet.path).toBe("/readyz");
    expect(container.envFrom.at(-1).configMapRef.name).toBe("payments-tools-runtime-env");
    // The runtime artifact hash stamped here is the bundle's own, the one
    // Terraform binds too.
    const stamped =
      deployment.spec.template.metadata.annotations["anvil.dev/runtime-artifact-hash"];
    expect(readFileSync(join(bundle, "deploy/terraform/main.tf"), "utf8")).toContain(stamped);
    const workflow = parseYaml(readFileSync(join(out, "ci/github-actions.yml"), "utf8"));
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(JSON.stringify(workflow)).not.toContain("kubectl apply");
    // The operator ConfigMap still carries the ledger + credential scaffold
    // (values are the operator's), and the command says so.
    expect(result.out).toContain("Unfilled REPLACE_WITH_* values remain");
    // The bundle itself did not change.
    const certify = await cli(["certify", bundle]);
    expect(certify.code, certify.io.text()).toBe(0);
  });

  it("refuses a namespace that is not a DNS label and a bundle without the manifests", async () => {
    const bad = await cli([
      "deploy",
      "kubernetes",
      bundle,
      "--out",
      join(root, "x"),
      "--namespace",
      "Not_A_Label",
    ]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("DNS label");
    const missing = await cli(["deploy", "kubernetes", root]);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("Run `anvil compile` first");
  });
});

describe("anvil sdk publish-plan", () => {
  it("prints the per-registry commands and preconditions, names only, no network", async () => {
    const result = await cli(["sdk", "publish-plan", bundle]);
    expect(result.code, result.io.text()).toBe(0);
    expect(result.out).toContain("# Publishing the generated SDKs for `payments`");
    expect(result.out).toContain("npm publish --dry-run --access public");
    expect(result.out).toContain("python3 -m build");
    expect(result.out).toContain("twine upload");
    expect(result.out).toContain("go mod tidy");
    expect(result.out).toContain("mvn -B deploy");
    expect(result.out).toContain("`NPM_TOKEN`");
    expect(result.out).toContain("`TWINE_PASSWORD`");
    expect(result.out).toContain("MUTATES");
    expect(result.out).toContain("made no network call");
  });

  it("emits the machine-readable plan with --json and honours --lang", async () => {
    const result = await cli(["sdk", "publish-plan", bundle, "--json", "--lang", "typescript,go"]);
    expect(result.code, result.io.text()).toBe(0);
    const plan = JSON.parse(result.out);
    expect(plan.reportType).toBe("anvil.sdk-publish-plan");
    expect(plan.languages.map((l: { language: string }) => l.language)).toEqual([
      "typescript",
      "go",
    ]);
    const pkg = JSON.parse(readFileSync(join(bundle, "sdk/typescript/package.json"), "utf8"));
    expect(plan.languages[0].package).toMatchObject({ name: pkg.name, version: pkg.version });
    expect(plan.languages[1].steps.filter((s: { mutates: boolean }) => s.mutates)).toHaveLength(1);
  });

  it("writes <lang>/publish-plan.json and PUBLISHING.md outside the bundle with --out", async () => {
    const out = join(root, "sdk-plan");
    const result = await cli(["sdk", "publish-plan", bundle, "--out", out]);
    expect(result.code, result.io.text()).toBe(0);
    expect(result.out).toContain("Wrote 5 file(s)");
    expect(result.out).toContain("No registry was contacted");
    for (const lang of ["typescript", "python", "go", "java"]) {
      const plan = JSON.parse(readFileSync(join(out, lang, "publish-plan.json"), "utf8"));
      expect(plan.language).toBe(lang);
      expect(plan.networkCallsMadeByAnvil).toBe(false);
    }
    expect(readFileSync(join(out, "PUBLISHING.md"), "utf8")).toContain("npm pack --dry-run");
    expect(existsSync(join(bundle, "sdk/PUBLISHING.md"))).toBe(false);
  });

  it("refuses an unknown language as a structured envelope", async () => {
    const result = await cli(["sdk", "publish-plan", bundle, "--json", "--lang", "rust"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toMatchObject({
      reportType: "anvil.sdk-publish-plan-error",
      code: "sdk_language_unknown",
    });
  });
});
