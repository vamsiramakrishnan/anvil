/**
 * What `anvil --version --json` reports: the version, the commit the CLI was
 * built at, and a content digest of the built Anvil packages it runs.
 *
 * The version is the same at every commit, so it cannot key a cache of
 * anything Anvil produced. The digest can: it is a SHA-256 over the files
 * each `@anvil/*` package ships (its `dist/`), for the CLI and every Anvil
 * package it depends on, so it changes exactly when the code that runs
 * changes. The commit is informational: the bundler records it in
 * `dist/build-info.json` (left out of the digest, so an unchanged build at a
 * new commit keeps its digest), a build restored from a cache names the
 * commit that produced it, and it is `null` when the bundle recorded none
 * (a build outside a git checkout).
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Written by the CLI's bundler beside its output; never part of a digest. */
const BUILD_INFO = "build-info.json";

export interface BuildIdentity {
  name: "anvil";
  version: string;
  /** The git commit the CLI was bundled at, or `null` when unknown. */
  commit: string | null;
  /** `sha256:<hex>` over every package's digest, in name order. */
  digest: string;
  /** Each Anvil package's digest over its shipped files (`dist/`), by name. */
  packages: Record<string, string>;
}

const SCOPE = "@anvil/";

/** The directory holding `package.json` above a path, with that manifest. */
function packageRoot(from: string): { dir: string; manifest: Record<string, unknown> } | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    const file = join(dir, "package.json");
    if (existsSync(file)) {
      return { dir, manifest: JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown> };
    }
    if (dirname(dir) === dir) return undefined;
  }
}

/** Where a dependency is installed, as Node resolves it: the nearest `node_modules/<name>`. */
function installedDir(from: string, name: string): string | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    if (dirname(dir) === dir) return undefined;
  }
}

/** Every file under a directory, as sorted `/`-separated relative paths. */
function filesUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() || (entry.isSymbolicLink() && statSync(path).isFile())) {
        out.push(relative(root, path).split(sep).join("/"));
      }
    }
  };
  walk(root);
  return out.sort();
}

/** A digest over a package's shipped files; a package with nothing built hashes as empty. */
function packageDigest(dir: string): string {
  const hash = createHash("sha256");
  const dist = join(dir, "dist");
  if (existsSync(dist)) {
    for (const file of filesUnder(dist)) {
      if (file === BUILD_INFO) continue;
      const bytes = readFileSync(join(dist, file));
      hash.update(`${file}\0${bytes.length}\0`);
      hash.update(bytes);
    }
  }
  return `sha256:${hash.digest("hex")}`;
}

/**
 * The build identity of the CLI whose module is at `moduleUrl`: its package,
 * then every `@anvil/*` package it depends on, transitively, where Node
 * would load them from.
 */
export function buildIdentity(version: string, moduleUrl: string = import.meta.url): BuildIdentity {
  const self = packageRoot(dirname(fileURLToPath(moduleUrl)));
  const packages: Record<string, string> = {};
  const queue: Array<{ name: string; dir: string; manifest: Record<string, unknown> }> = [];
  if (self) queue.push({ name: String(self.manifest.name ?? "@anvil/cli"), ...self });
  while (queue.length > 0) {
    const next = queue.shift() as (typeof queue)[number];
    if (packages[next.name] !== undefined) continue;
    packages[next.name] = packageDigest(next.dir);
    const deps = next.manifest.dependencies;
    for (const dep of Object.keys(typeof deps === "object" && deps !== null ? deps : {})) {
      if (!dep.startsWith(SCOPE) || packages[dep] !== undefined) continue;
      const dir = installedDir(next.dir, dep);
      const root = dir ? packageRoot(dir) : undefined;
      if (root) queue.push({ name: dep, ...root });
    }
  }
  const names = Object.keys(packages).sort();
  const sorted = Object.fromEntries(names.map((name) => [name, packages[name] as string]));
  const digest = createHash("sha256")
    .update(names.map((name) => `${name} ${sorted[name]}\n`).join(""))
    .digest("hex");
  const commit = self ? builtAt(join(self.dir, "dist", BUILD_INFO)) : null;
  return { name: "anvil", version, commit, digest: `sha256:${digest}`, packages: sorted };
}

function builtAt(file: string): string | null {
  try {
    const info = JSON.parse(readFileSync(file, "utf8")) as { commit?: unknown };
    return typeof info.commit === "string" ? info.commit : null;
  } catch {
    return null;
  }
}
