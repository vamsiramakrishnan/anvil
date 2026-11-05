import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import type { CliIO } from "../io.js";
import { VERSION } from "../program.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";

/**
 * `anvil install --prefix DIR [--from DIR] [--prune]` — the per-host toolchain
 * (Branchyard contract v2, item 4).
 *
 * ```text
 * <prefix>/
 *   current -> versions/<digest>      switched last, by rename
 *   versions/<digest>/
 *     manifest.json                   every file's digest, the source, the version
 *     bin/anvil  python/  typescript/  compose/  env.sh
 *   connectors/<bundle_hash>/         untouched here; the host pulls packages into it
 * ```
 *
 * A toolchain source is a directory with a `manifest.json` whose `files` maps
 * each relative path to its SHA-256. Every file is hashed before anything is
 * written, so a tampered file is refused with its path and the prefix is left
 * as it was. The version directory is named by the digest of that map, so the
 * same toolchain is the same directory: a second install writes nothing, and
 * an interrupted one leaves the old `current`.
 */
export function registerInstall(parent: Command, ctx: CommandContext): void {
  annotate(
    parent
      .command("install")
      .summary("Install the Anvil toolchain once per host, under a prefix.")
      .description(
        "Installs the CLI launcher, the Python SDK, the TypeScript SDK and the compose SDK into <prefix>/versions/<digest>/ and points <prefix>/current at it by an atomic rename. Without --from the toolchain is the one this Anvil carries (the launcher runs this installation's CLI). With --from <dir> it is the directory's manifest.json and the files it lists; every digest is checked before a file is written. Running the same digest again changes nothing. A registry reference for --from is not supported: pull the image first and pass the directory.",
      )
      .requiredOption("--prefix <dir>", "the host toolchain directory, such as /opt/anvil")
      .option("--from <dir>", "a toolchain directory (manifest.json plus the files it lists)")
      .option("--prune", "remove versions that `current` does not name")
      .action(async (opts: { prefix: string; from?: string; prune?: boolean }) => {
        ctx.code = await runInstall(opts, ctx.io);
      }),
    { mutates: true },
  );
}

/** Python's `json.dumps(value, sort_keys=True)` for a string map, so one file set has one digest everywhere. */
function canonicalDigestInput(files: Record<string, string>): string {
  const ascii = (text: string) =>
    JSON.stringify(text).replace(
      /[\u007f-￿]/g,
      (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
  const entries = Object.keys(files)
    .sort()
    .map((name) => `${ascii(name)}: ${ascii(files[name] as string)}`);
  return `{${entries.join(", ")}}`;
}

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/** A relative path with no `..`, no backslash, and nothing that lands outside the version directory. */
function safeRelativePath(name: string): boolean {
  if (name === "" || isAbsolute(name) || name.includes("\\") || name.includes("\0")) return false;
  const reserved = name === "manifest.json" || name === "env.sh";
  return !reserved && name.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

interface Toolchain {
  /** Relative path to bytes. */
  files: Map<string, Buffer>;
  /** Relative path to the hex SHA-256 the manifest records. */
  recorded: Record<string, string>;
  source: string;
}

class Refusal extends Error {}

/** The toolchain in `dir`, every file checked against its recorded digest. Writes nothing. */
function readToolchain(dir: string): Toolchain {
  const base = resolve(dir);
  let recorded: Record<string, string>;
  try {
    const manifest = JSON.parse(readFileSync(join(base, "manifest.json"), "utf8")) as {
      files?: unknown;
    };
    if (!manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)) {
      throw new Error("'files' is not an object");
    }
    recorded = {};
    for (const [name, digest] of Object.entries(manifest.files)) {
      if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) {
        throw new Error(`'${name}' has no SHA-256 digest`);
      }
      recorded[name] = digest;
    }
  } catch (error) {
    throw new Refusal(
      `${dir} is not an Anvil toolchain (manifest.json): ${(error as Error).message}`,
    );
  }
  if (Object.keys(recorded).length === 0) {
    throw new Refusal(`${dir} is not an Anvil toolchain (manifest.json): it lists no files`);
  }
  const files = new Map<string, Buffer>();
  for (const name of Object.keys(recorded).sort()) {
    if (!safeRelativePath(name)) {
      throw new Refusal(
        `digest mismatch for ${name}; the path is not allowed. Nothing was written`,
      );
    }
    const path = join(base, name);
    let bytes: Buffer | undefined;
    try {
      if (lstatSync(path).isFile()) bytes = readFileSync(path);
    } catch {
      bytes = undefined;
    }
    if (bytes === undefined || sha256(bytes) !== recorded[name]) {
      throw new Refusal(`digest mismatch for ${name}; nothing was written`);
    }
    files.set(name, bytes);
  }
  return { files, recorded, source: base };
}

const POSIX_QUOTE = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

/** This installation's CLI entry: beside the bundled chunks, or one level up from `src/commands`. */
function cliEntry(): string {
  for (const candidate of ["./bin-anvil.js", "../bin-anvil.js"]) {
    const path = fileURLToPath(new URL(candidate, import.meta.url));
    if (existsSync(path)) return path;
  }
  return resolve(process.argv[1] ?? "anvil");
}

/** The toolchain this Anvil carries: a launcher over this installation, and the SDK modules. */
async function builtinToolchain(): Promise<Toolchain> {
  const { generateComposite } = await import("@anvil/generators");
  const entry = cliEntry();
  const text: Record<string, string> = {
    "bin/anvil": `#!/bin/sh
# The Anvil launcher for this host. It runs the CLI of the installation that wrote it.
here=$(cd "$(dirname "$0")/.." && pwd)
if [ "$1" = "--version" ]; then
  digest=$(sed -n 's/.*"digest": *"\\([0-9a-f]*\\)".*/\\1/p' "$here/manifest.json" | head -n 1)
  echo "anvil $digest"
  exit 0
fi
exec node ${POSIX_QUOTE(entry)} "$@"
`,
    "python/anvil_sdk/__init__.py": `"""Gateway settings shared by Anvil's Python clients (standard library only)."""
import os

VERSION = ${JSON.stringify(VERSION)}


def gateway_url():
    """The gateway the clients call: ANVIL_GATEWAY_URL, or None."""
    return os.environ.get("ANVIL_GATEWAY_URL") or None


def gateway_token():
    """This turn's token, read from ANVIL_GATEWAY_TOKEN_FILE on every call, or None."""
    path = os.environ.get("ANVIL_GATEWAY_TOKEN_FILE")
    if not path:
        return None
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read().strip() or None
`,
    "typescript/package.json": `${JSON.stringify({ name: "@anvil/sdk", version: VERSION, main: "index.js", type: "commonjs" }, null, 2)}\n`,
    "typescript/index.js": `"use strict";
const { readFileSync } = require("node:fs");
exports.VERSION = ${JSON.stringify(VERSION)};
exports.gatewayUrl = () => process.env.ANVIL_GATEWAY_URL || null;
exports.gatewayToken = () => {
  const path = process.env.ANVIL_GATEWAY_TOKEN_FILE;
  return path ? readFileSync(path, "utf8").trim() || null : null;
};
`,
  };
  for (const [path, body] of Object.entries(generateComposite([]))) text[`compose/${path}`] = body;
  const files = new Map<string, Buffer>();
  const recorded: Record<string, string> = {};
  for (const [name, body] of Object.entries(text)) {
    const bytes = Buffer.from(body, "utf8");
    files.set(name, bytes);
    recorded[name] = sha256(bytes);
  }
  return { files, recorded, source: "builtin" };
}

async function runInstall(
  opts: { prefix: string; from?: string; prune?: boolean },
  io: CliIO,
): Promise<number> {
  let toolchain: Toolchain;
  try {
    toolchain = opts.from === undefined ? await builtinToolchain() : readToolchain(opts.from);
  } catch (error) {
    io.err(`anvil: ${(error as Error).message}`);
    return 1;
  }
  const digest = sha256(canonicalDigestInput(toolchain.recorded));
  const prefix = resolve(opts.prefix);
  const versions = join(prefix, "versions");
  const destination = join(versions, digest);
  try {
    if (!existsSync(join(destination, "manifest.json"))) {
      mkdirSync(versions, { recursive: true });
      const stage = mkdtempSync(join(versions, ".install-"));
      try {
        for (const [name, bytes] of toolchain.files) {
          const path = join(stage, name);
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, bytes);
          if (name.startsWith("bin/")) chmodSync(path, 0o755);
        }
        writeFileSync(
          join(stage, "env.sh"),
          `export PATH="${destination}/bin:$PATH"\nexport PYTHONPATH="${destination}/python:${destination}/compose/python:\${PYTHONPATH:-}"\n`,
        );
        // The manifest goes in last: its presence is what says the version is whole.
        writeFileSync(
          join(stage, "manifest.json"),
          `${JSON.stringify({ digest, version: VERSION, source: toolchain.source, files: toolchain.recorded }, null, 2)}\n`,
        );
        try {
          renameSync(stage, destination);
        } catch (error) {
          // A concurrent install of the same digest got there first.
          if (!existsSync(join(destination, "manifest.json"))) throw error;
        }
      } finally {
        rmSync(stage, { recursive: true, force: true });
      }
    }
    switchCurrent(prefix, digest);
    if (opts.prune) {
      for (const entry of readdirSync(versions)) {
        if (entry !== digest) rmSync(join(versions, entry), { recursive: true, force: true });
      }
    }
  } catch (error) {
    io.err(`anvil: install under ${prefix} failed: ${(error as Error).message}`);
    return 1;
  }
  io.out(`anvil installed ${digest} under ${opts.prefix}`);
  return 0;
}

/** Point `current` at the version by renaming a fresh symlink over it; a no-op when it already does. */
function switchCurrent(prefix: string, digest: string): void {
  const current = join(prefix, "current");
  const target = `versions/${digest}`;
  try {
    if (lstatSync(current).isSymbolicLink() && readlinkSync(current) === target) return;
  } catch {
    // no `current` yet
  }
  const link = join(prefix, `.current-${process.pid}`);
  rmSync(link, { force: true });
  symlinkSync(target, link);
  renameSync(link, current);
}
