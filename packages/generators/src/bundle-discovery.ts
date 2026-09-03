import { type Dirent, existsSync, readdirSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";

/**
 * Workspace bundle discovery — shared by `@anvil/console` (browsing a
 * workspace of bundles) and `@anvil/cli`'s `anvil serve --fleet` (mounting
 * every bundle beneath a workspace root onto one MCP surface). Lifted out of
 * the console so the two never independently reinvent what counts as "a
 * bundle" and risk disagreeing about it.
 *
 * A bundle is any directory carrying a canonical `air.yaml`/`air.json`,
 * discovered fresh on every call — there is no index to go stale. A bundle's
 * id is its workspace-relative path, the one stable name the filesystem
 * already gives it (the root itself, when it is a bundle, is named by its
 * own directory name).
 */

const AIR_FILES = ["air.yaml", "air.json"] as const;
const SKIPPED_DIRS = new Set(["node_modules", ".git", "dist"]);
const MAX_DEPTH = 8;

export interface WorkspaceBundle {
  id: string;
  /** Absolute bundle directory. */
  dir: string;
}

export function isBundleDir(dir: string): boolean {
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
