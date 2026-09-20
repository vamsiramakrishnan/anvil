import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  readBundleDir,
  resolveBundleDir,
  SDK_LANGUAGES,
  type SdkLanguage,
  sdkPublishPlan,
  sdkPublishPlanFiles,
  sdkPublishPlanReadme,
} from "@anvil/generators";
import type { Command } from "commander";
import { emitRefusal } from "../envelope.js";
import type { CliIO } from "../io.js";
import type { CommandContext } from "./context.js";

/**
 * `anvil sdk publish-plan <bundle> [--lang] [--out] [--json]` — the exact
 * registry commands and preconditions for each generated client, read from the
 * generated package manifests. Prints the README by default; `--out` writes
 * `<lang>/publish-plan.json` + `PUBLISHING.md` outside the certified bundle
 * (the `sdk/` root is compiler-owned, like `anvil sdk --out`). Anvil never
 * publishes, holds no registry credential, and makes no network call here.
 */
export function registerSdkPublishPlan(sdk: Command, ctx: CommandContext): void {
  sdk
    .command("publish-plan")
    .summary("The per-registry publish plan for the generated SDKs (commands + preconditions).")
    .description(
      "Reads each generated package's own manifest (package.json, pyproject.toml, go.mod, pom.xml) and emits the exact rehearsal-then-publish commands (npm pack/publish --dry-run, python -m build + twine, go mod tidy + tag, mvn deploy) with the registry and credential environment-variable NAMES each needs. Never runs a publish and never holds a credential.",
    )
    .argument("<path>", "generated bundle directory")
    .option(
      "--lang <languages>",
      `comma-separated subset of ${SDK_LANGUAGES.join(", ")} (default: all)`,
    )
    .option("--out <dir>", "write <lang>/publish-plan.json and PUBLISHING.md here")
    .option("--json", "emit the whole plan as JSON")
    .action((path: string, opts: SdkPublishPlanOptions) => {
      ctx.code = runSdkPublishPlan(path, opts, ctx.io);
    });
}

interface SdkPublishPlanOptions {
  lang?: string;
  out?: string;
  json?: boolean;
}

/** Parse `--lang`, refusing an unknown language rather than silently dropping it. */
export function selectedLanguages(raw: string | undefined): SdkLanguage[] | { error: string } {
  if (raw === undefined) return [...SDK_LANGUAGES];
  const requested = raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (requested.length === 0) return { error: "--lang was empty" };
  const unknown = requested.filter(
    (entry) => !(SDK_LANGUAGES as readonly string[]).includes(entry),
  );
  if (unknown.length > 0) {
    return {
      error: `unknown SDK language(s) ${unknown.join(", ")}; expected one of ${SDK_LANGUAGES.join(", ")}`,
    };
  }
  return SDK_LANGUAGES.filter((language) => requested.includes(language));
}

function runSdkPublishPlan(path: string, opts: SdkPublishPlanOptions, io: CliIO): number {
  const languages = selectedLanguages(opts.lang);
  if (!Array.isArray(languages)) {
    return emitRefusal(io, opts.json, {
      reportType: "anvil.sdk-publish-plan-error",
      code: "sdk_language_unknown",
      message: `${languages.error}.`,
      details: { supported: [...SDK_LANGUAGES] },
    });
  }
  let files: Record<string, string>;
  try {
    files = readBundleDir(resolveBundleDir(path));
  } catch (error) {
    return emitRefusal(io, opts.json, {
      reportType: "anvil.sdk-publish-plan-error",
      code: "bundle_unreadable",
      message: (error as Error).message,
    });
  }
  const result = sdkPublishPlan(files, languages);
  if (!result.ok) {
    return emitRefusal(io, opts.json, {
      reportType: "anvil.sdk-publish-plan-error",
      code: result.code,
      message: result.message,
    });
  }
  const { plan } = result;

  if (opts.json === true) {
    const { schemaVersion, ...rest } = plan;
    io.out(
      JSON.stringify({ schemaVersion, reportType: "anvil.sdk-publish-plan", ...rest }, null, 2),
    );
    return 0;
  }

  if (opts.out !== undefined) {
    const root = resolve(opts.out);
    const written: string[] = [];
    for (const [rel, contents] of Object.entries(sdkPublishPlanFiles(plan))) {
      const full = join(root, rel.slice("sdk/".length));
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, contents, "utf8");
      written.push(rel.slice("sdk/".length));
    }
    io.out(
      `Wrote ${written.length} file(s) for ${plan.service.id} @ ${plan.service.version} to ${root}: ${written.join(", ")}.`,
    );
    io.out("No registry was contacted. Every publish step remains an operator action.");
    return 0;
  }

  io.out(sdkPublishPlanReadme(plan));
  return 0;
}
