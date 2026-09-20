import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AirDocument } from "@anvil/air";
import { compile } from "@anvil/compiler";
import { beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { generateBundle } from "./bundle.js";
import {
  GITHUB_ACTIONS_WORKFLOW_FILE,
  generateGithubActionsWorkflow,
} from "./deploy-github-actions.js";

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

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}

// Parsed YAML fixtures are navigated freely; the assertions are the type.
// biome-ignore lint/suspicious/noExplicitAny: test-only view of parsed YAML
type Yaml = Record<string, any>;

function workflow(): { text: string; doc: Yaml; steps: Step[] } {
  const text = generateGithubActionsWorkflow(payments)[GITHUB_ACTIONS_WORKFLOW_FILE] as string;
  const doc = parseYaml(text) as Yaml;
  return { text, doc, steps: doc.jobs.gates.steps as Step[] };
}

describe("generateGithubActionsWorkflow", () => {
  it("emits one parseable workflow, read-only, triggered on push/PR/dispatch, and matches the snapshot", () => {
    const { text, doc } = workflow();
    expect(Object.keys(generateGithubActionsWorkflow(payments))).toEqual([
      GITHUB_ACTIONS_WORKFLOW_FILE,
    ]);
    expect(doc.permissions).toEqual({ contents: "read" });
    expect(Object.keys(doc.on).sort()).toEqual(["pull_request", "push", "workflow_dispatch"]);
    expect(doc.name).toContain("payments");
    expect(text).toMatchSnapshot();
  });

  it("runs the certify, selftest, and conformance gates before any plan is rendered", () => {
    const { steps } = workflow();
    const runs = steps.map((step) => step.run ?? "");
    const index = (needle: string) => runs.findIndex((run) => run.includes(needle));
    expect(index("anvil certify .")).toBeGreaterThan(-1);
    expect(index("anvil selftest .")).toBeGreaterThan(index("anvil certify ."));
    expect(index("anvil conformance .")).toBeGreaterThan(index("anvil selftest ."));
    expect(index("docker build -f deploy/Dockerfile")).toBeGreaterThan(
      index("anvil conformance ."),
    );
    expect(index("anvil deploy kubernetes . --image")).toBeGreaterThan(index("docker build"));
    expect(index("kubectl kustomize plan/kubernetes")).toBeGreaterThan(-1);
    expect(index("anvil deploy cloud-run .")).toBeGreaterThan(-1);
  });

  it("never applies, never pushes, and holds no credential", () => {
    const { text, steps } = workflow();
    expect(text).not.toMatch(/kubectl apply(?! -k deploy\/kubernetes --dry-run)/);
    expect(text).not.toContain("kubectl apply");
    expect(text).not.toContain("docker push");
    expect(text).not.toContain("terraform apply");
    expect(text).not.toContain("gcloud run deploy");
    expect(text).not.toMatch(/secrets\./);
    expect(text).not.toContain("docker login");
    expect(text).not.toContain("kubeconfig");
    // The plan leaves as an artifact for a human; nothing here promotes it.
    const upload = steps.find((step) => step.uses?.startsWith("actions/upload-artifact"));
    expect(upload?.with?.path).toBe("plan");
    expect(upload?.with?.["if-no-files-found"]).toBe("error");
  });

  it("refuses an unpinned CLI, an unnamed image repository, and an unfilled scaffold", () => {
    const { text } = workflow();
    expect(text).toContain('test -n "$ANVIL_CLI_PACKAGE" ||');
    expect(text).toContain("${{ vars.ANVIL_CLI_PACKAGE }}");
    expect(text).toContain('test -n "$ANVIL_IMAGE_REPOSITORY" ||');
    expect(text).toContain("grep -q REPLACE_WITH_ plan/kubernetes.rendered.yaml");
  });

  it("ships in every compiled bundle under deploy/ci/", () => {
    const { files } = generateBundle(payments);
    expect(files[GITHUB_ACTIONS_WORKFLOW_FILE]).toBe(
      generateGithubActionsWorkflow(payments)[GITHUB_ACTIONS_WORKFLOW_FILE],
    );
  });
});
