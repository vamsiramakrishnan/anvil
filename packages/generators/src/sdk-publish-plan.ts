import { SDK_LANGUAGES, type SdkLanguage } from "./sdk/index.js";

/**
 * SDK publish plans — the exact registry commands and preconditions for each
 * generated client, read back from the generated package manifests
 * (`sdk/typescript/package.json`, `sdk/python/pyproject.toml`, `sdk/go/go.mod`,
 * `sdk/java/pom.xml`) rather than re-derived from AIR, so the plan can never
 * name a version the package itself does not carry.
 *
 * Anvil emits the plan; it never runs a publish, never holds a registry
 * credential, and names credentials by environment-variable NAME only. Every
 * step is marked `mutates` so a script can stop before the first real upload.
 */

export interface SdkPublishStep {
  id: string;
  description: string;
  command: string;
  /** True for the step that actually uploads or tags — everything before it is rehearsal. */
  mutates: boolean;
}

export interface SdkPublishLanguagePlan {
  schemaVersion: 1;
  language: SdkLanguage;
  service: { id: string; version: string };
  package: {
    name: string;
    version: string;
    /** Bundle-relative directory the commands run in. */
    directory: string;
    manifest: string;
  };
  registry: { kind: "npm" | "pypi" | "go-module-proxy" | "maven"; defaultUrl: string };
  /** Environment-variable NAMES the publish step reads. Never values. */
  credentialEnv: string[];
  preconditions: string[];
  steps: SdkPublishStep[];
  networkCallsMadeByAnvil: false;
}

export interface SdkPublishPlan {
  schemaVersion: 1;
  service: { id: string; version: string };
  languages: SdkPublishLanguagePlan[];
}

export type SdkPublishPlanResult =
  | { ok: true; plan: SdkPublishPlan }
  | { ok: false; code: "sdk_manifest_missing" | "sdk_version_mismatch"; message: string };

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

function readJson(
  files: Record<string, string>,
  path: string,
): Record<string, unknown> | undefined {
  const text = files[path];
  if (text === undefined) return undefined;
  try {
    const value = JSON.parse(text);
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function tomlValue(text: string, key: string): string | undefined {
  return text.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m"))?.[1];
}

function xmlValue(text: string, tag: string): string | undefined {
  // The generated pom's first <tag> is the project's own (parent/dependency
  // blocks come later), so the first match is the one we want.
  return text.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1]?.trim();
}

interface PackageIdentity {
  name: string;
  version: string;
  manifest: string;
}

/** Each language's identity, read from its own generated manifest. */
function packageIdentity(
  files: Record<string, string>,
  language: SdkLanguage,
): PackageIdentity | undefined {
  switch (language) {
    case "typescript": {
      const manifest = "sdk/typescript/package.json";
      const pkg = readJson(files, manifest);
      if (!pkg || typeof pkg.name !== "string" || typeof pkg.version !== "string") return undefined;
      return { name: pkg.name, version: pkg.version, manifest };
    }
    case "python": {
      const manifest = "sdk/python/pyproject.toml";
      const text = files[manifest];
      if (text === undefined) return undefined;
      const name = tomlValue(text, "name");
      const version = tomlValue(text, "version");
      return name && version ? { name, version, manifest } : undefined;
    }
    case "go": {
      const manifest = "sdk/go/go.mod";
      const module = files[manifest]?.match(/^module\s+(\S+)/m)?.[1];
      return module ? { name: module, version: "", manifest } : undefined;
    }
    case "java": {
      const manifest = "sdk/java/pom.xml";
      const text = files[manifest];
      if (text === undefined) return undefined;
      const groupId = xmlValue(text, "groupId");
      const artifactId = xmlValue(text, "artifactId");
      const version = xmlValue(text, "version");
      return groupId && artifactId && version
        ? { name: `${groupId}:${artifactId}`, version, manifest }
        : undefined;
    }
  }
}

function languagePlan(
  language: SdkLanguage,
  identity: PackageIdentity,
  service: { id: string; version: string },
): SdkPublishLanguagePlan {
  const base = {
    schemaVersion: 1 as const,
    language,
    service,
    package: {
      name: identity.name,
      version: identity.version || service.version,
      directory: `sdk/${language}`,
      manifest: identity.manifest,
    },
    networkCallsMadeByAnvil: false as const,
  };
  switch (language) {
    case "typescript":
      return {
        ...base,
        registry: { kind: "npm", defaultUrl: "https://registry.npmjs.org/" },
        credentialEnv: ["NPM_TOKEN"],
        preconditions: [
          `The npm scope of \`${identity.name}\` is owned by the publishing account (create it, or rename the package in the Anvil manifest and recompile).`,
          "An `.npmrc` (or `npm config set`) points `//registry.npmjs.org/:_authToken` at `${NPM_TOKEN}` — the value lives only in the CI secret store.",
          "Node.js 20+ and npm are installed; `npm run build` succeeds.",
          `Version \`${identity.version}\` is not already published (npm refuses a republish; bump \`service.version\` and recompile).`,
        ],
        steps: [
          step("install", "Install dev dependencies", "cd sdk/typescript && npm install"),
          step("build", "Compile the client", "cd sdk/typescript && npm run build"),
          step("pack", "Rehearse the tarball contents", "cd sdk/typescript && npm pack --dry-run"),
          step(
            "publish-dry-run",
            "Rehearse the publish against the registry without uploading",
            "cd sdk/typescript && npm publish --dry-run --access public",
          ),
          step(
            "publish",
            "Upload to npm (the only mutating step)",
            "cd sdk/typescript && npm publish --access public",
            true,
          ),
        ],
      };
    case "python":
      return {
        ...base,
        registry: { kind: "pypi", defaultUrl: "https://upload.pypi.org/legacy/" },
        credentialEnv: ["TWINE_USERNAME", "TWINE_PASSWORD", "TWINE_REPOSITORY_URL"],
        preconditions: [
          `The PyPI project \`${identity.name}\` is owned by the publishing account, or a private index is named in \`TWINE_REPOSITORY_URL\`.`,
          "`TWINE_USERNAME=__token__` and `TWINE_PASSWORD` is an API token scoped to the project — the value lives only in the CI secret store.",
          "Python 3.9+ with `build` and `twine` installed.",
          `Version \`${identity.version}\` is not already on the index (PyPI refuses a re-upload of the same file name).`,
        ],
        steps: [
          step(
            "tooling",
            "Install the build front end and the uploader",
            "python3 -m pip install --upgrade build twine",
          ),
          step("build", "Build the sdist and wheel", "cd sdk/python && python3 -m build"),
          step(
            "check",
            "Validate the distribution metadata",
            "cd sdk/python && python3 -m twine check dist/*",
          ),
          step(
            "upload-rehearsal",
            "Upload to TestPyPI first (a separate index; the production index is untouched)",
            "cd sdk/python && python3 -m twine upload --repository testpypi dist/*",
          ),
          step(
            "upload",
            "Upload to the production index (the only mutating step on it)",
            "cd sdk/python && python3 -m twine upload dist/*",
            true,
          ),
        ],
      };
    case "go": {
      const version = `v${service.version}`;
      const semver = SEMVER.test(service.version);
      return {
        ...base,
        package: { ...base.package, version },
        registry: { kind: "go-module-proxy", defaultUrl: "https://proxy.golang.org/" },
        credentialEnv: ["GIT_SSH_COMMAND", "GOPROXY", "GOPRIVATE", "GONOSUMDB"],
        preconditions: [
          `The module path \`${identity.name}\` is a repository you control; the generated path is a placeholder until the Anvil manifest names your own (a Go module is published by tagging that repository, not by uploading).`,
          "`sdk/go/` sits at that repository's root (or the tag carries the subdirectory prefix, `sdk/go/v1.2.3`).",
          semver
            ? `\`${version}\` is a valid semantic version tag for Go modules.`
            : `Service version \`${service.version}\` is not semantic-version shaped; Go modules require \`vMAJOR.MINOR.PATCH\`. Set a semver \`service.version\` and recompile before tagging.`,
          "Push credentials for that repository come from the CI runner's git identity (an SSH key or token), never from the bundle.",
          "For a private module, `GOPRIVATE`/`GONOSUMDB` name it so the public proxy and checksum database are not consulted.",
        ],
        steps: [
          step("tidy", "Resolve the (empty) dependency set", "cd sdk/go && go mod tidy"),
          step("build", "Compile the client", "cd sdk/go && go build ./..."),
          step("vet", "Static checks", "cd sdk/go && go vet ./..."),
          step(
            "tag",
            "Tag the release in the module's repository (the mutating step)",
            `git tag -a ${version} -m "${identity.name} ${version}" && git push origin ${version}`,
            true,
          ),
          step(
            "index",
            "Ask the public proxy to index the tag (no-op for a private module)",
            `GOPROXY=https://proxy.golang.org GO111MODULE=on go list -m ${identity.name}@${version}`,
          ),
        ],
      };
    }
    case "java":
      return {
        ...base,
        registry: {
          kind: "maven",
          defaultUrl: "https://central.sonatype.com/ (or an internal Maven repository)",
        },
        credentialEnv: ["MAVEN_USERNAME", "MAVEN_PASSWORD", "MAVEN_GPG_PASSPHRASE"],
        preconditions: [
          `The groupId of \`${identity.name}\` is verified for the publishing account on the target repository.`,
          '`~/.m2/settings.xml` maps a `<server id="anvil-sdk">` to `${env.MAVEN_USERNAME}` / `${env.MAVEN_PASSWORD}`; the values live only in the CI secret store.',
          "Java 11+ and Maven 3.8+ installed; `mvn -B verify` succeeds.",
          "Maven Central additionally requires GPG-signed artifacts and sources/javadoc jars (`MAVEN_GPG_PASSPHRASE`); an internal repository may not.",
          `Version \`${identity.version}\` is not already deployed (a release repository refuses redeploys).`,
        ],
        steps: [
          step("verify", "Compile, test, and package", "cd sdk/java && mvn -B verify"),
          step(
            "deploy-rehearsal",
            "Deploy to a staging/snapshot repository of your own first",
            'cd sdk/java && mvn -B deploy -DskipTests -DaltDeploymentRepository="anvil-sdk::<STAGING_REPOSITORY_URL>"',
          ),
          step(
            "deploy",
            "Deploy to the release repository (the only mutating step on it)",
            'cd sdk/java && mvn -B deploy -DskipTests -DaltDeploymentRepository="anvil-sdk::<RELEASE_REPOSITORY_URL>"',
            true,
          ),
        ],
      };
  }
}

function step(id: string, description: string, command: string, mutates = false): SdkPublishStep {
  return { id, description, command, mutates };
}

/**
 * Build the publish plan from a bundle's files. Refuses when a language's
 * manifest is missing (the SDK was not generated, or the bundle was pruned) or
 * when a package's own version disagrees with `sdk/manifest.json` — a plan
 * must never name a version the package would not actually carry.
 */
export function sdkPublishPlan(
  files: Record<string, string>,
  languages: readonly SdkLanguage[] = SDK_LANGUAGES,
): SdkPublishPlanResult {
  const manifest = readJson(files, "sdk/manifest.json");
  const service = manifest?.service as { id?: unknown; version?: unknown } | undefined;
  if (!service || typeof service.id !== "string" || typeof service.version !== "string") {
    return {
      ok: false,
      code: "sdk_manifest_missing",
      message: "sdk/manifest.json is missing or unreadable; run `anvil compile` first.",
    };
  }
  const identity = { id: service.id, version: service.version };
  const plans: SdkPublishLanguagePlan[] = [];
  for (const language of languages) {
    const pkg = packageIdentity(files, language);
    if (!pkg) {
      return {
        ok: false,
        code: "sdk_manifest_missing",
        message: `sdk/${language}/ has no readable package manifest; run \`anvil compile\` (or \`anvil sdk --out\`) first.`,
      };
    }
    if (pkg.version !== "" && pkg.version !== identity.version) {
      return {
        ok: false,
        code: "sdk_version_mismatch",
        message: `${pkg.manifest} carries version ${pkg.version} but sdk/manifest.json says ${identity.version}; regenerate the SDKs instead of publishing a mixed set.`,
      };
    }
    plans.push(languagePlan(language, pkg, identity));
  }
  return { ok: true, plan: { schemaVersion: 1, service: identity, languages: plans } };
}

/** The bundle-relative files `anvil sdk publish-plan --out` writes. */
export function sdkPublishPlanFiles(plan: SdkPublishPlan): Record<string, string> {
  const files: Record<string, string> = { "sdk/PUBLISHING.md": sdkPublishPlanReadme(plan) };
  for (const language of plan.languages) {
    files[`sdk/${language.language}/publish-plan.json`] = `${JSON.stringify(language, null, 2)}\n`;
  }
  return files;
}

export function sdkPublishPlanReadme(plan: SdkPublishPlan): string {
  const sections = plan.languages.map(
    (
      language,
    ) => `## ${language.language} — \`${language.package.name}\` @ \`${language.package.version}\`

Registry: ${language.registry.kind} (${language.registry.defaultUrl}). Version read from
\`${language.package.manifest}\`. Commands run from the bundle root.

Credentials (environment-variable names only; values stay in your secret store):
${language.credentialEnv.map((name) => `- \`${name}\``).join("\n")}

Preconditions:
${language.preconditions.map((line) => `- ${line}`).join("\n")}

\`\`\`bash
${language.steps
  .map(
    (s) => `# ${s.id}: ${s.description}${s.mutates ? " — MUTATES the registry" : ""}\n${s.command}`,
  )
  .join("\n\n")}
\`\`\`
`,
  );
  return `# Publishing the generated SDKs for \`${plan.service.id}\` @ \`${plan.service.version}\`

Anvil generated these plans from the SDK manifests in this bundle; it does not
publish anything, holds no registry credential, and made no network call to
prepare them. Every step before the one marked **MUTATES** is a rehearsal you
can run without touching a registry. Regenerate the SDKs (change the Anvil
manifest, recompile) rather than editing a package by hand before publishing —
a hand-edited SDK is outside what \`anvil certify\` proves.

${sections.join("\n")}`;
}
