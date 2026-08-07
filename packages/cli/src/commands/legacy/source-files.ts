import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, relative, resolve, sep } from "node:path";

const LEGACY_SOURCE_MAX_FILES = 20_000;
const LEGACY_SOURCE_MAX_FILE_BYTES = 16 * 1024 * 1024;
const LEGACY_SOURCE_MAX_TOTAL_BYTES = 512 * 1024 * 1024;

interface LegacySourceMember {
  /** Safe POSIX path relative to the supplied collection root. */
  path: string;
  bytes: Uint8Array;
  sha256: string;
}

interface LegacySourceSet {
  /** Display-only label; no host-absolute path enters the inventory contract. */
  label: string;
  members: LegacySourceMember[];
  totalBytes: number;
}

function portablePath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Read one already-exported legacy source tree without following symlinks or
 * opening archives. Vendor collectors receive exact caller-supplied bytes; the
 * CLI never executes an assembly, deployment descriptor extension, or script.
 */
export function readLegacySourceSet(input: string): LegacySourceSet {
  const requested = resolve(input);
  const rootStat = lstatSync(requested);
  if (rootStat.isSymbolicLink()) {
    throw new Error("Legacy inventory refuses a symbolic-link collection root.");
  }
  if (!rootStat.isDirectory() && !rootStat.isFile()) {
    throw new Error("Legacy inventory accepts one regular file or directory.");
  }

  const root = rootStat.isDirectory() ? requested : resolve(requested, "..");
  const canonicalRoot = realpathSync(root);
  const files: string[] = [];
  const pending = rootStat.isDirectory() ? [requested] : [];
  if (rootStat.isFile()) files.push(requested);

  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) break;
    const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        throw new Error(`Legacy inventory refuses symbolic link '${portablePath(root, path)}'.`);
      }
      if (stat.isDirectory()) {
        pending.push(path);
      } else if (stat.isFile()) {
        files.push(path);
        if (files.length > LEGACY_SOURCE_MAX_FILES) {
          throw new Error(
            `Legacy inventory exceeds the ${LEGACY_SOURCE_MAX_FILES} file collection limit.`,
          );
        }
      } else {
        throw new Error(
          `Legacy inventory refuses non-regular member '${portablePath(root, path)}'.`,
        );
      }
    }
  }

  let totalBytes = 0;
  const members = files
    .map((path): LegacySourceMember => {
      const canonical = realpathSync(path);
      const rel = portablePath(canonicalRoot, canonical);
      if (!rel || rel === "." || rel.startsWith("../") || rel.includes("/../")) {
        throw new Error(`Legacy source member '${path}' escapes its collection root.`);
      }
      const stat = lstatSync(canonical);
      if (stat.size > LEGACY_SOURCE_MAX_FILE_BYTES) {
        throw new Error(
          `Legacy source member '${rel}' exceeds the ${LEGACY_SOURCE_MAX_FILE_BYTES} byte limit.`,
        );
      }
      totalBytes += stat.size;
      if (totalBytes > LEGACY_SOURCE_MAX_TOTAL_BYTES) {
        throw new Error(
          `Legacy inventory exceeds the ${LEGACY_SOURCE_MAX_TOTAL_BYTES} byte collection limit.`,
        );
      }
      const bytes = readFileSync(canonical);
      return { path: rel, bytes, sha256: digest(bytes) };
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  if (members.length === 0) throw new Error("Legacy inventory source contains no regular files.");
  return {
    label: basename(requested),
    members,
    totalBytes,
  };
}
