import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  generateSdks,
  SDK_LANGUAGES,
  type SdkLanguage,
  sdkManifest,
  sdkPlan,
} from "@anvil/generators";
import type { Command } from "commander";
import { emitRefusal } from "../envelope.js";
import type { CliIO } from "../io.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";
import { loadAir } from "./shared.js";

/**
 * `anvil sdk <dir|air.yaml>` — the client SDKs, as a first-class surface.
 *
 * `anvil compile` already writes them into the bundle; this command exists for
 * the two things that surface needs on its own: showing an operator what the
 * four languages expose (so a drift between them would be visible, not
 * inferred), and re-emitting them somewhere else — a monorepo's `clients/`
 * directory, a vendored copy — without dragging the whole bundle along.
 */
export function registerSdk(parent: Command, ctx: CommandContext): void {
  annotate(
    parent
      .command("sdk")
      .summary("Show or emit the generated client SDKs (TypeScript, Python, Go, Java).")
      .description(
        "Every approved operation becomes one method in each language, projected from the same AIR that produced the CLI, the MCP server, and the skill — same wire coordinates, same confirmation and idempotency gates, same retry posture, same error taxonomy. Without --out this prints the method table and the gates each call must satisfy; with --out it writes the SDK trees (the same bytes `anvil compile` puts under the bundle's sdk/). Only approved operations are ever emitted.",
      )
      .argument("<path>", "generated bundle directory or air.yaml")
      .option(
        "--lang <languages>",
        `comma-separated subset of ${SDK_LANGUAGES.join(", ")} (default: all)`,
      )
      .option("--out <dir>", "write the SDK trees here instead of printing the method table")
      .option("--json", "emit the SDK manifest as JSON")
      .action((path: string, opts: SdkOptions) => {
        ctx.code = runSdk(path, opts, ctx.io);
      }),
    // Writing only happens under --out; the default is a read-only report, and
    // annotating it as mutating would make every harness prompt for a listing.
    { mutates: false },
  );
}

interface SdkOptions {
  lang?: string;
  out?: string;
  json?: boolean;
}

/** Parse `--lang`, refusing an unknown language rather than silently dropping it. */
function selectedLanguages(raw: string | undefined): SdkLanguage[] | { error: string } {
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

function runSdk(path: string, opts: SdkOptions, io: CliIO): number {
  const air = loadAir(path);
  const languages = selectedLanguages(opts.lang);
  if (!Array.isArray(languages)) {
    return emitRefusal(io, opts.json, {
      reportType: "anvil.sdk-error",
      code: "sdk_language_unknown",
      message: `${languages.error}.`,
      details: { supported: [...SDK_LANGUAGES] },
    });
  }
  const plan = sdkPlan(air);
  const manifest = sdkManifest(plan);

  if (opts.json === true) {
    // The operator envelope, not the raw manifest: a script piping this to `jq`
    // must be able to tell a report from a refusal by its `reportType` alone.
    const { schemaVersion, ...rest } = manifest;
    io.out(
      JSON.stringify(
        { schemaVersion, reportType: "anvil.sdk-manifest", ...rest, languages },
        null,
        2,
      ),
    );
    return 0;
  }

  if (opts.out !== undefined) {
    const root = resolve(opts.out);
    const prefixes = languages.map((language) => `sdk/${language}/`);
    const written: string[] = [];
    for (const [rel, contents] of Object.entries(generateSdks(air))) {
      // `sdk/manifest.json` and `sdk/README.md` describe the whole set, so they
      // travel with any subset; the per-language trees are filtered.
      const shared = !rel.slice("sdk/".length).includes("/");
      if (!shared && !prefixes.some((prefix) => rel.startsWith(prefix))) continue;
      const full = join(root, rel.slice("sdk/".length));
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, contents, "utf8");
      written.push(rel);
    }
    io.out(
      `Wrote ${written.length} file(s) for ${languages.join(", ")} to ${root} (${manifest.methods.length} approved operation(s)).`,
    );
    io.out(
      "These are generated artifacts: change AIR or the Anvil manifest and re-run, never edit them in place.",
    );
    return 0;
  }

  io.out(
    `${plan.service.displayName} @ ${plan.service.version} — ${manifest.methods.length} approved operation(s) across ${languages.length} SDK(s)`,
  );
  io.out(`Base URL ${plan.service.baseUrl || "(none recorded — pass one at construction)"}`);
  io.out(
    plan.auth.carrier
      ? `Credential ${plan.auth.envVar} → ${plan.auth.carrier.in} '${plan.auth.carrier.name}'${plan.auth.carrier.scheme ? ` (${plan.auth.carrier.scheme})` : ""}`
      : "Credential: none required",
  );
  io.out("");
  if (manifest.methods.length === 0) {
    io.out("No approved operations, so every SDK is empty. Approve operations first.");
    return 0;
  }
  for (const method of manifest.methods) {
    const gates = [
      method.confirmationRequired
        ? method.humanApproval
          ? "confirm (human)"
          : "confirm"
        : undefined,
      method.idempotencyKeyRequired ? "idempotency key" : undefined,
      method.retrySafe ? undefined : "no auto-retry",
    ].filter(Boolean);
    io.out(`${method.operationId}  (${method.http})`);
    io.out(
      `  ${languages.map((language) => `${language}: ${method.methods[language]}`).join("  ")}`,
    );
    io.out(
      `  effect ${method.effect} · idempotency ${method.idempotency}${gates.length > 0 ? ` · gates: ${gates.join(", ")}` : ""}`,
    );
    if (method.paginated || method.awaitable) {
      io.out(
        `  helpers: ${[method.paginated ? "pagination" : undefined, method.awaitable ? "wait-for-completion" : undefined].filter(Boolean).join(", ")}`,
      );
    }
  }
  return 0;
}
