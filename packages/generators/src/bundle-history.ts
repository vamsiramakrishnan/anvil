import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { bundleHash, readBundleDir } from "./certify.js";

/**
 * Bundle history: the prior generations an atomic swap replaced, retained at
 * `<bundle>/.anvil/history/<timestamp>-<hash12>/` so a reviewer can roll a
 * bundle back to exactly what it was before a decision. Bounded — the oldest
 * generations are removed once more than `historyLimit` are kept — and
 * private: `.anvil/` at the bundle root is excluded from `readBundleDir`, so
 * a retained generation is never mistaken for the live one by certification,
 * discovery (which stops at the live bundle's own `air.yaml`), or a hash.
 *
 * A retained generation is the replaced directory itself, renamed into place
 * — the same bytes the swap moved aside, never a copy that could drift — with
 * its own `.anvil/history` handed forward to the live bundle first, so
 * generations never nest.
 */

export const BUNDLE_HISTORY_DIR = ".anvil/history";
export const DEFAULT_HISTORY_LIMIT = 5;
const HISTORY_LIMIT_ENV = "ANVIL_BUNDLE_HISTORY_LIMIT";

/** `historyLimit` when given, else the environment, else the default. Never below zero. */
export function resolveHistoryLimit(limit?: number): number {
  const fromEnv = process.env[HISTORY_LIMIT_ENV];
  const candidate = limit ?? (fromEnv !== undefined ? Number(fromEnv) : DEFAULT_HISTORY_LIMIT);
  if (!Number.isInteger(candidate) || candidate < 0) {
    throw new Error(
      `The bundle history limit must be a non-negative integer (got ${JSON.stringify(limit ?? fromEnv)}).`,
    );
  }
  return candidate;
}

export function bundleHistoryDir(bundleDir: string): string {
  return join(bundleDir, ...BUNDLE_HISTORY_DIR.split("/"));
}

/** A `cpSync` filter that leaves a bundle's retained generations behind. */
export function excludeHistory(bundleDir: string): (path: string) => boolean {
  const history = resolve(bundleHistoryDir(bundleDir));
  return (path) => {
    const candidate = resolve(path);
    return candidate !== history && !candidate.startsWith(`${history}${sep}`);
  };
}

/** `<iso-timestamp with ':' and '.' made path-safe>-<first 12 hex of the hash>`. */
export function historyEntryId(recordedAt: Date, hash: string): string {
  return `${recordedAt.toISOString().replace(/[:.]/g, "-")}-${hash.slice(0, 12)}`;
}

export interface HistoryEntry {
  id: string;
  /** Absolute directory of the retained generation. */
  path: string;
  /** When the swap that retired this generation ran, from the entry id. */
  recordedAt: string;
  /** The retained generation's own content hash, computed from its files. */
  bundleHash: string;
}

const ENTRY_ID = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-([0-9a-f]{12})$/;

function recordedAtOf(id: string): string {
  const match = ENTRY_ID.exec(id);
  if (!match) return "";
  const [date = "", time = ""] = (match[1] as string).split("T");
  const [hh = "", mm = "", ss = "", ms = ""] = time.replace(/Z$/, "").split("-");
  return `${date}T${hh}:${mm}:${ss}.${ms}Z`;
}

/** Retained generations, newest first. Names that are not entry ids are ignored. */
export function listBundleHistory(bundleDir: string): HistoryEntry[] {
  const dir = bundleHistoryDir(bundleDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => ENTRY_ID.test(name) && statSync(join(dir, name)).isDirectory())
    .sort()
    .reverse()
    .map((id) => {
      const path = join(dir, id);
      return {
        id,
        path,
        recordedAt: recordedAtOf(id),
        bundleHash: bundleHash(readBundleDir(path)),
      };
    });
}

export interface ArchiveOptions {
  /** The replaced generation's hash, computed before the swap. */
  hash: string;
  recordedAt: Date;
  historyLimit: number;
}

/**
 * Retire a replaced generation into the live bundle's history. `backupDir` is
 * the directory the swap moved aside; it carries the history the live bundle
 * had before the swap (the stage was copied without it), which is handed
 * forward first. Returns the entry, or `undefined` when the limit is zero and
 * the generation was discarded instead.
 */
export function archiveReplacedGeneration(
  bundleDir: string,
  backupDir: string,
  options: ArchiveOptions,
): HistoryEntry | undefined {
  const liveHistory = bundleHistoryDir(bundleDir);
  const priorHistory = bundleHistoryDir(backupDir);
  mkdirSync(join(bundleDir, ".anvil"), { recursive: true });
  if (existsSync(priorHistory)) {
    if (existsSync(liveHistory)) {
      for (const name of readdirSync(priorHistory)) {
        renameSync(join(priorHistory, name), join(liveHistory, name));
      }
      rmSync(priorHistory, { recursive: true, force: true });
    } else {
      renameSync(priorHistory, liveHistory);
    }
  }
  mkdirSync(liveHistory, { recursive: true });
  if (options.historyLimit === 0) {
    rmSync(backupDir, { recursive: true, force: true });
    pruneHistory(bundleDir, 0);
    return undefined;
  }
  const id = historyEntryId(options.recordedAt, options.hash);
  const path = join(liveHistory, id);
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  renameSync(backupDir, path);
  pruneHistory(bundleDir, options.historyLimit);
  return { id, path, recordedAt: options.recordedAt.toISOString(), bundleHash: options.hash };
}

/** Remove the oldest generations beyond `limit`. */
export function pruneHistory(bundleDir: string, limit: number): string[] {
  const dir = bundleHistoryDir(bundleDir);
  if (!existsSync(dir)) return [];
  const ids = readdirSync(dir)
    .filter((name) => ENTRY_ID.test(name))
    .sort();
  const removed = ids.slice(0, Math.max(0, ids.length - limit));
  for (const id of removed) rmSync(join(dir, id), { recursive: true, force: true });
  return removed;
}

/** Find a retained generation by full hash or unambiguous hash prefix; newest when `to` is absent. */
export function selectHistoryEntry(bundleDir: string, to?: string): HistoryEntry {
  const entries = listBundleHistory(bundleDir);
  if (entries.length === 0) {
    throw new Error(
      `No retained generation under ${bundleHistoryDir(bundleDir)}; nothing to roll back to.`,
    );
  }
  if (to === undefined) return entries[0] as HistoryEntry;
  const wanted = to.trim().toLowerCase();
  if (wanted.length < 6 || !/^[0-9a-f]+$/.test(wanted)) {
    throw new Error("--to takes a bundle hash or a hex prefix of at least 6 characters.");
  }
  const matches = entries.filter(
    (entry) => entry.bundleHash.startsWith(wanted) || entry.id.endsWith(`-${wanted}`),
  );
  if (matches.length === 0) {
    throw new Error(
      `No retained generation matches '${to}'. Retained: ${entries.map((entry) => `${entry.id} (${entry.bundleHash.slice(0, 12)})`).join(", ")}.`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `'${to}' matches ${matches.length} retained generations; give a longer prefix.`,
    );
  }
  return matches[0] as HistoryEntry;
}
