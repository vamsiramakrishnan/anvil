import { type Dirent, existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type RefinementPack, readPackDir, refinementPackHash } from "@anvil/refinement";
import { notFound, pathOutsideRoot } from "./errors.js";

/**
 * The workspace: a root directory beneath which compiled bundles and
 * refinement packs are DISCOVERED, never registered. A bundle is any
 * directory carrying a canonical `air.yaml`/`air.json`; a pack is any
 * directory carrying a `pack.json`. Both are read fresh on every request —
 * there is no index to go stale — and a bundle's id is its workspace-relative
 * path, which is the one stable name the filesystem already gave it (the
 * root itself, when it is a bundle, is named by its directory name).
 *
 * Every path a request body names is resolved through `resolveInsideRoot`:
 * the console has the reviewer's filesystem authority, so the workspace root
 * is the boundary of what it may read or write on their behalf.
 */

const AIR_FILES = ["air.yaml", "air.json"] as const;
const SKIPPED_DIRS = new Set(["node_modules", ".git", "dist"]);
const MAX_DEPTH = 8;

export interface WorkspaceBundle {
  id: string;
  /** Absolute bundle directory. */
  dir: string;
}

function isBundleDir(dir: string): boolean {
  return AIR_FILES.some((name) => existsSync(join(dir, name)));
}

/** Directories worth descending into: real (non-symlink), not an install or VCS tree. */
function childDirs(dir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .filter((name) => !SKIPPED_DIRS.has(name) && (!name.startsWith(".") || name === ".anvil"))
    .sort()
    .map((name) => join(dir, name));
}

/** Every bundle beneath the root (or the root itself), sorted by id. */
export function discoverBundles(root: string): WorkspaceBundle[] {
  if (isBundleDir(root)) return [{ id: basename(root), dir: root }];
  const found: WorkspaceBundle[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    for (const child of childDirs(dir)) {
      if (isBundleDir(child)) {
        found.push({ id: relative(root, child).split(sep).join("/"), dir: child });
      } else {
        walk(child, depth + 1);
      }
    }
  };
  walk(root, 0);
  return found.sort((a, b) => a.id.localeCompare(b.id));
}

export function findBundle(root: string, id: string): WorkspaceBundle {
  const bundle = discoverBundles(root).find((candidate) => candidate.id === id);
  if (!bundle) throw notFound(`No bundle '${id}' in workspace ${root}.`);
  return bundle;
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
    if (depth > MAX_DEPTH) return;
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
    for (const child of childDirs(dir)) walk(child, depth + 1);
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
