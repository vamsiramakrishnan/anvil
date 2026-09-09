import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { camelCase } from "@anvil/air";
import { Outcome, type ProcessSpec, runProcess, type Step } from "@anvil/fuzz";
import type { SdkLanguage, SdkOperation, SdkPlan } from "@anvil/generators";
import { goInvoke, javaInvoke, PYTHON_INVOKE, TYPESCRIPT_INVOKE } from "./sdk-sources.js";

export interface SdkToolchains {
  pythonCommand?: string;
  goCommand?: string;
  javaCommand?: string;
  javacCommand?: string;
}

function toolchains(language: SdkLanguage, options: SdkToolchains): ProcessSpec[] {
  switch (language) {
    case "python":
      return [{ command: options.pythonCommand ?? "python3", args: ["--version"] }];
    case "typescript":
      return [
        {
          command: process.execPath,
          args: [createRequire(import.meta.url).resolve("typescript/bin/tsc"), "--version"],
        },
      ];
    case "go":
      return [
        {
          command: options.goCommand ?? "go",
          args: ["version"],
          env: { GOTOOLCHAIN: "local", GOENV: "off", GOWORK: "off" },
        },
      ];
    case "java":
      return [
        { command: options.javacCommand ?? "javac", args: ["-version"] },
        { command: options.javaCommand ?? "java", args: ["-version"] },
      ];
  }
}

/** Used by both driver availability checks and the CLI's replay identity. */
export async function sdkToolchainIdentity(
  languages: readonly SdkLanguage[],
  options: SdkToolchains = {},
  signal: AbortSignal = AbortSignal.timeout(10000),
): Promise<Record<string, string>> {
  const identity: Record<string, string> = {};
  for (const language of languages) {
    try {
      const versions: string[] = [];
      for (const spec of toolchains(language, options)) {
        const result = await runProcess(spec, "", signal, 16384);
        if (result.exitCode !== 0) throw new Error("Toolchain unavailable");
        versions.push(`${spec.command}: ${(result.stdout + result.stderr).trim()}`);
      }
      identity[language] = versions.join("\n");
    } catch {
      if (signal.aborted) throw new Error("Toolchain check cancelled");
      identity[language] = "unavailable";
    }
  }
  return identity;
}

type Artifacts = Record<string, Buffer>;
// Bounded, process-local cache of immutable build OUTPUT bytes, never fixture
// state or client instances. A new source or compiler identity forces a build.
const builds = new Map<string, Artifacts>();
let goCache: string | undefined;
function goEnvironment(): Record<string, string> {
  if (!goCache) {
    goCache = mkdtempSync(join(tmpdir(), "anvil-fuzz-go-cache-"));
    const dir = goCache;
    process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  }
  return {
    GOCACHE: goCache,
    GOPATH: join(goCache, "path"),
    GOTOOLCHAIN: "local",
    GOPROXY: "off",
    GOSUMDB: "off",
    GOENV: "off",
    GOWORK: "off",
    CGO_ENABLED: "0",
  };
}

function snapshot(root: string, prefix = ""): Artifacts {
  const files: Artifacts = {};
  for (const item of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const path = join(prefix, item.name);
    if (item.isDirectory()) Object.assign(files, snapshot(root, path));
    else if (item.isFile()) files[path] = readFileSync(join(root, path));
  }
  return files;
}

export interface SdkInvocation {
  invoke(
    op: SdkOperation,
    step: Step,
    base: string,
    env: Record<string, string>,
    signal: AbortSignal,
  ): Promise<Outcome>;
}

/** Compile copied sources as supplied; never regenerate or trust prebuilt bundle artifacts. */
export async function prepareSdk(
  language: SdkLanguage,
  plan: SdkPlan,
  files: Record<string, string>,
  dir: string,
  options: SdkToolchains,
  signal: AbortSignal,
): Promise<SdkInvocation> {
  const unavailable = (
    status: "unsupported" | "inconclusive",
    errorCode: string,
  ): SdkInvocation => ({
    async invoke() {
      return { status, value: null, errorCode };
    },
  });
  const version = (await sdkToolchainIdentity([language], options, signal))[language];
  if (version === "unavailable") return unavailable("unsupported", `${language}_toolchain_missing`);
  const root = join(dir, "sdk", language);
  const output = join(root, language === "typescript" ? "dist" : ".anvil-fuzz-build");
  let spec: ProcessSpec;
  if (language === "python") {
    spec = {
      command: options.pythonCommand ?? "python3",
      args: ["-c", PYTHON_INVOKE],
      cwd: root,
      env: { PYTHONPATH: root, PYTHONDONTWRITEBYTECODE: "1" },
    };
  } else {
    const source = Object.entries(files)
      .filter(([path]) => path.startsWith(`sdk/${language}/`))
      .sort(([a], [b]) => a.localeCompare(b));
    if (!source.length) return unavailable("unsupported", "sdk_sources_missing");
    const key = createHash("sha256")
      .update(JSON.stringify({ language, version, source, plan }))
      .digest("hex");
    rmSync(output, { recursive: true, force: true });
    mkdirSync(output, { recursive: true });
    let build: ProcessSpec;
    if (language === "typescript") {
      writeFileSync(join(root, "anvil-fuzz-invoke.mjs"), TYPESCRIPT_INVOKE);
      spec = { command: process.execPath, args: ["anvil-fuzz-invoke.mjs"], cwd: root };
      const compiler = toolchains(language, options)[0];
      if (!compiler) throw new Error("No TypeScript compiler");
      build = {
        ...compiler,
        args: [
          compiler.args?.[0] as string,
          "-p",
          "tsconfig.json",
          "--outDir",
          output,
          "--incremental",
          "false",
          "--noEmit",
          "false",
          "--noEmitOnError",
        ],
        cwd: root,
      };
    } else if (language === "go") {
      mkdirSync(join(root, "anvilfuzz"), { recursive: true });
      writeFileSync(
        join(root, "anvilfuzz/main.go"),
        goInvoke(`github.com/anvil-sdk/${plan.service.id}`),
      );
      spec = { command: join(output, "invoke"), cwd: root };
      build = {
        command: options.goCommand ?? "go",
        args: ["build", "-trimpath", "-o", spec.command, "./anvilfuzz"],
        cwd: root,
        env: goEnvironment(),
      };
    } else {
      // Read the package from the copied public client rather than reconstructing its spelling.
      const path = source.find(([path]) =>
        path.endsWith(`/${plan.service.names.pascal}Client.java`),
      );
      const pkg = path?.[1].match(/^package ([\w.]+);/m)?.[1];
      if (!pkg) return unavailable("inconclusive", "java_client_package_missing");
      writeFileSync(
        join(root, "AnvilFuzzInvoke.java"),
        javaInvoke(pkg, `${plan.service.names.pascal}Client`),
      );
      spec = {
        command: options.javaCommand ?? "java",
        args: ["-cp", output, "AnvilFuzzInvoke"],
        cwd: root,
      };
      build = {
        command: options.javacCommand ?? "javac",
        args: [
          "-encoding",
          "UTF-8",
          "--release",
          "11",
          "-d",
          output,
          ...source
            .filter(([path]) => path.startsWith("sdk/java/src/") && path.endsWith(".java"))
            .map(([path]) => join(dir, path)),
          "AnvilFuzzInvoke.java",
        ],
        cwd: root,
      };
    }
    const cached = builds.get(key);
    if (cached) {
      for (const [path, bytes] of Object.entries(cached)) {
        mkdirSync(dirname(join(output, path)), { recursive: true });
        writeFileSync(join(output, path), bytes, { mode: language === "go" ? 0o700 : 0o600 });
      }
    } else {
      const result = await runProcess(build, "", signal);
      if (result.exitCode !== 0) return unavailable("inconclusive", `${language}_build_failed`);
      if (builds.size >= 8) builds.delete(builds.keys().next().value as string);
      builds.set(key, snapshot(output));
    }
  }
  return {
    async invoke(op, step, base, env, callSignal) {
      const input = { ...step.input };
      const callOptions = {
        confirm: input[op.safetyKeys.confirm] === true,
        idempotencyKey: input[op.safetyKeys.idempotencyKey],
      };
      if (language !== "python") {
        delete input[op.safetyKeys.confirm];
        delete input[op.safetyKeys.idempotencyKey];
      }
      const fields = [
        ...op.params,
        ...(op.body?.projection === "fields"
          ? op.body.fields
          : op.body
            ? [{ key: "body", required: op.body.required }]
            : []),
      ];
      // Go's JSON decoder would silently replace an omitted required scalar
      // with its zero value. That is a different call, not a faithful probe.
      if (
        (language === "go" || language === "java") &&
        fields.some((f) => f.required && input[f.key] === undefined)
      )
        return { status: "unsupported", value: null, errorCode: "sdk_input_unrepresentable" };
      const request = {
        package: `anvil_${plan.service.names.snake}`,
        client: `${plan.service.names.pascal}Client`,
        method:
          language === "go"
            ? op.names.pascal
            : language === "python"
              ? op.names.snake
              : op.names.camel,
        inputClass: `${op.names.pascal}Input`,
        required: fields.filter((f) => f.required).map((f) => f.key),
        optional: Object.fromEntries(
          fields.filter((f) => !f.required).map((f) => [f.key, camelCase(f.key)]),
        ),
        input,
        options: callOptions,
        base,
      };
      const raw = await runProcess(
        { ...spec, env: { ...env, ...spec.env } },
        JSON.stringify(request),
        callSignal,
      );
      if (raw.exitCode !== 0)
        return { status: "inconclusive", value: null, errorCode: `${language}_process_failed` };
      try {
        return Outcome.parse(JSON.parse(raw.stdout));
      } catch {
        return { status: "inconclusive", value: null, errorCode: "invalid_output_envelope" };
      }
    },
  };
}
