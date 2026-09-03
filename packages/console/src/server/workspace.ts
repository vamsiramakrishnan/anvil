import { type Dirent, existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { discoverBundles, type WorkspaceBundle } from "@anvil/generators";
import { type RefinementPack, readPackDir, refinementPackHash } from "@anvil/refinement";
import { notFound, pathOutsideRoot } from "./errors.js";

/**
 * The workspace: a root directory beneath which compiled bundles and
 * refinement packs are DISCOVERED, never registered. A pack is any directory
 * carrying a `pack.json`, read fresh on every request — there is no index to
 * go stale. Bundle discovery itself (`discoverBundles`/`WorkspaceBundle`)
 * lives in `@anvil/generators` and is re-exported here unchanged, so the
 * console and `anvil serve --fleet` can never disagree about what counts as
 * a bundle — this module only adds the console's own lookup-by-id error
 * shape (`ConsoleError` via `notFound`) on top of it.
 *
 * Every path a request body names is resolved through `resolveInsideRoot`:
 * the console has the reviewer's filesystem authority, so the workspace root
 * is the boundary of what it may read or write on their behalf.
 */

export { discoverBundles, type WorkspaceBundle } from "@anvil/generators";

export function findBundle(root: string, id: string): WorkspaceBundle {
  const bundle = discoverBundles(root).find((candidate) => candidate.id === id);
  if (!bundle) throw notFound(`No bundle '${id}' in workspace ${root}.`);
  return bundle;
}

/**
 * Pack discovery's own directory walk — separate from bundle discovery
 * (`@anvil/generators`'s `discoverBundles`), because a pack lives at
 * `pack.json`, not `air.yaml`/`air.json`, and the two walks stop at
 * different files. Kept private and duplicated in miniature rather than
 * shared: the only thing in common is "walk real, non-VCS/install
 * directories up to a depth", which is not worth a cross-package seam for
 * two call sites.
 */
const PACK_SKIPPED_DIRS = new Set(["node_modules", ".git", "dist"]);
const PACK_MAX_DEPTH = 8;

function packChildDirs(dir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .filter((name) => !PACK_SKIPPED_DIRS.has(name) && (!name.startsWith(".") || name === ".anvil"))
    .sort()
    .map((name) => join(dir, name));
}

export interface DiscoveredPack {
  dir: string;
  pack: RefinementPack;
  hash: string;
}

/** Every valid pack beneath the root whose service matches the bundle's. */
export function discoverPacks(root: string, serviceId: string): DiscoveredPack[] {
  const found: DiscoveredPack[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > PACK_MAX_DEPTH) return;
    if (existsSync(join(dir, "pack.json"))) {
      try {
        const pack = readPackDir(dir);
        if (pack.service.id === serviceId) {
          found.push({ dir, pack, hash: refinementPackHash(pack) });
        }
      } catch {
        // A malformed pack.json is not this bundle's pack; the reviewer sees
        // it through `anvil refine review`, which names the parse failure.
      }
      return;
    }
    for (const child of packChildDirs(dir)) walk(child, depth + 1);
  };
  walk(root, 0);
  return found.sort((a, b) => a.dir.localeCompare(b.dir));
}

export function findPack(root: string, serviceId: string, hash: string): DiscoveredPack {
  const pack = discoverPacks(root, serviceId).find((candidate) => candidate.hash === hash);
  if (!pack) throw notFound(`No refinement pack with hash '${hash}' for service '${serviceId}'.`);
  return pack;
}

/**
 * Resolve a request-supplied path against the root and refuse anything that
 * lands outside it — lexically, and through symlinks for the part that already
 * exists. The root itself is inside the root (a repository root defaults to it).
 */
export function resolveInsideRoot(root: string, path: string): string {
  const absolute = resolve(root, path);
  const escapes =
    !isInside(root, absolute) ||
    !isInside(realpathSync(root), realpathSync(nearestExisting(absolute)));
  if (escapes) throw pathOutsideRoot(path);
  return absolute;
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function nearestExisting(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = resolve(current, "..");
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

/** A filename-safe rendering of an id (bundle ids carry slashes; cluster ids are free text). */
export function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_") || "_";
}

/** Where the console puts files a request did not name a home for: `<root>/.anvil/console/...`. */
export function consoleScratchPath(root: string, ...parts: string[]): string {
  return join(root, ".anvil", "console", ...parts);
}

export function assertDirectory(path: string): void {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error(`No such workspace directory: ${path}`);
  }
}
