import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type AirDocument, loadAirDocument } from "@anvil/air";
import { compile } from "@anvil/compiler";
import { beforeAll, describe, expect, it } from "vitest";
import { generateBundle } from "./bundle.js";
import { generateSdks, SDK_LANGUAGES } from "./sdk/index.js";
import {
  type SdkPublishPlan,
  sdkPublishPlan,
  sdkPublishPlanFiles,
  sdkPublishPlanReadme,
} from "./sdk-publish-plan.js";

const read = (rel: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../../examples/payments/${rel}`, import.meta.url)),
    "utf8",
  );

let files: Record<string, string>;

beforeAll(async () => {
  const air: AirDocument = await compile({
    spec: read("openapi.yaml"),
    manifest: read("anvil.yaml"),
    serviceId: "payments",
  });
  files = generateBundle(air).files;
});

function planOf(): SdkPublishPlan {
  const result = sdkPublishPlan(files);
  if (!result.ok) throw new Error(result.message);
  return result.plan;
}

describe("sdkPublishPlan", () => {
  it("reads every language's name and version from its own generated manifest", () => {
    const plan = planOf();
    const version = JSON.parse(files["sdk/manifest.json"] as string).service.version;
    expect(plan.service).toEqual({ id: "payments", version });
    expect(plan.languages.map((l) => l.language)).toEqual([...SDK_LANGUAGES]);
    const byLanguage = Object.fromEntries(plan.languages.map((l) => [l.language, l]));
    expect(byLanguage.typescript?.package).toMatchObject({
      name: JSON.parse(files["sdk/typescript/package.json"] as string).name,
      version,
      manifest: "sdk/typescript/package.json",
    });
    expect(byLanguage.python?.package).toMatchObject({
      name: "anvil-sdk-payments",
      version,
      manifest: "sdk/python/pyproject.toml",
    });
    expect(byLanguage.go?.package).toMatchObject({
      name: "github.com/anvil-sdk/payments",
      version: `v${version}`,
      manifest: "sdk/go/go.mod",
    });
    expect(byLanguage.java?.package).toMatchObject({
      name: "com.anvil.sdk:payments",
      version,
      manifest: "sdk/java/pom.xml",
    });
    expect(plan).toMatchSnapshot();
  });

  it("gives every language the exact rehearsal-then-publish commands, exactly one mutating step per registry", () => {
    const plan = planOf();
    const commands = Object.fromEntries(
      plan.languages.map((l) => [l.language, l.steps.map((s) => s.command).join("\n")]),
    );
    expect(commands.typescript).toContain("npm pack --dry-run");
    expect(commands.typescript).toContain("npm publish --dry-run");
    expect(commands.python).toContain("python3 -m build");
    expect(commands.python).toContain("twine upload");
    expect(commands.go).toContain("go mod tidy");
    expect(commands.go).toMatch(/git tag -a v\S+/);
    expect(commands.java).toContain("mvn -B deploy");
    for (const language of plan.languages) {
      const mutating = language.steps.filter((s) => s.mutates);
      expect(mutating.length, language.language).toBe(1);
      // Every rehearsal precedes the one real upload/tag.
      const firstMutating = language.steps.findIndex((s) => s.mutates);
      for (const [index, s] of language.steps.entries()) {
        if (!s.mutates && s.id !== "index")
          expect(index, `${language.language}/${s.id}`).toBeLessThan(firstMutating);
      }
      expect(language.networkCallsMadeByAnvil).toBe(false);
      expect(language.credentialEnv.length).toBeGreaterThan(0);
      expect(language.preconditions.length).toBeGreaterThan(2);
    }
  });

  it("names credentials by environment-variable name only", () => {
    const plan = planOf();
    const text = JSON.stringify(plan) + sdkPublishPlanReadme(plan);
    for (const language of plan.languages) {
      for (const name of language.credentialEnv) expect(name).toMatch(/^[A-Z][A-Z0-9_]+$/);
    }
    expect(text).not.toMatch(/npm_[A-Za-z0-9]{36}/);
    expect(text).not.toMatch(/pypi-[A-Za-z0-9]{20,}/);
    expect(text).not.toMatch(/ghp_[A-Za-z0-9]{20,}/);
    expect(text).not.toContain("--password ");
    expect(text).not.toContain("_authToken=");
  });

  it("writes one publish-plan.json per language plus one README with the commands", () => {
    const plan = planOf();
    const out = sdkPublishPlanFiles(plan);
    expect(Object.keys(out).sort()).toEqual([
      "sdk/PUBLISHING.md",
      "sdk/go/publish-plan.json",
      "sdk/java/publish-plan.json",
      "sdk/python/publish-plan.json",
      "sdk/typescript/publish-plan.json",
    ]);
    const python = JSON.parse(out["sdk/python/publish-plan.json"] as string);
    expect(python.language).toBe("python");
    expect(python.schemaVersion).toBe(1);
    const readme = out["sdk/PUBLISHING.md"] as string;
    expect(readme).toContain("npm publish --access public");
    expect(readme).toContain("python3 -m twine upload dist/*");
    expect(readme).toContain("go mod tidy");
    expect(readme).toContain("mvn -B deploy");
    expect(readme).toContain("MUTATES");
    expect(readme).toContain("does not\npublish anything");
  });

  it("honours a language subset", () => {
    const result = sdkPublishPlan(files, ["python", "go"]);
    expect(result.ok && result.plan.languages.map((l) => l.language)).toEqual(["python", "go"]);
    expect(
      Object.keys(sdkPublishPlanFiles((result as { plan: SdkPublishPlan }).plan)).sort(),
    ).toEqual(["sdk/PUBLISHING.md", "sdk/go/publish-plan.json", "sdk/python/publish-plan.json"]);
  });

  it("refuses a bundle whose SDK manifests are missing or disagree on the version", () => {
    expect(sdkPublishPlan({})).toMatchObject({ ok: false, code: "sdk_manifest_missing" });
    const pruned = { ...files };
    delete pruned["sdk/java/pom.xml"];
    expect(sdkPublishPlan(pruned)).toMatchObject({
      ok: false,
      code: "sdk_manifest_missing",
      message: expect.stringContaining("sdk/java/"),
    });
    const tampered = {
      ...files,
      "sdk/python/pyproject.toml": (files["sdk/python/pyproject.toml"] as string).replace(
        /^version = ".*"$/m,
        'version = "9.9.9"',
      ),
    };
    expect(sdkPublishPlan(tampered)).toMatchObject({
      ok: false,
      code: "sdk_version_mismatch",
      message: expect.stringContaining("9.9.9"),
    });
  });

  it("flags a non-semver service version as a Go precondition instead of inventing a tag", () => {
    const doc = JSON.parse(files["deploy/runtime/air.json"] as string);
    doc.service.version = "2026.09";
    const result = sdkPublishPlan(generateSdks(loadAirDocument(doc)));
    expect(result.ok).toBe(true);
    const go = result.ok ? result.plan.languages.find((l) => l.language === "go") : undefined;
    expect(go?.preconditions.join("\n")).toContain("not semantic-version shaped");
  });
});
