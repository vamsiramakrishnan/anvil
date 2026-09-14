import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "./process.mjs";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const MAX_BYTES = 64 * 1024 * 1024;

export function inspectBytes(file) {
  if (statSync(file).size > MAX_BYTES) throw new Error("source exceeds 64 MiB acquisition limit");
  const bytes = readFileSync(file);
  if (!bytes.length) throw new Error("empty source");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (/^\s*(?:<!doctype html|<html)\b/i.test(text)) throw new Error("HTML response is not an API contract");
  return { sha256: sha256(bytes), bytes: bytes.length };
}

/** A locked download never silently drifts. Private exports stay outside the repository. */
export async function acquire(system, options, lock) {
  const { cache, sourceDir, offline, refresh, reportDir } = options;
  mkdirSync(cache, { recursive: true });
  const pinned = lock[system.id];
  const cached = pinned && join(cache, `${pinned.sha256}.${system.extension}`);
  const supplied = sourceDir && join(sourceDir, `${system.id}.${system.extension}`);
  let file;
  let transport;
  if (supplied && existsSync(supplied)) {
    file = supplied;
    transport = "local-export";
  } else if (!refresh && cached && existsSync(cached)) {
    file = cached;
    transport = "verified-cache";
  } else if (system.access === "export-required") {
    return { status: "needs-export", detail: system.instructions };
  } else if (offline) {
    return { status: "unavailable", detail: "No verified cached source; acquire it before an offline run." };
  } else {
    file = join(cache, `${system.id}.download`);
    const url = new URL(system.url);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("source URL must be credential-free HTTPS");
    const result = await run("curl", [
      "--fail", "--silent", "--show-error", "--location", "--proto", "=https", "--proto-redir", "=https",
      "--connect-timeout", "15", "--max-time", "90", "--max-filesize", String(MAX_BYTES),
      "--output", file, system.url,
    ], { timeoutMs: 95_000, log: join(reportDir, `${system.id}.download.log`) });
    if (result.code !== 0) {
      rmSync(file, { force: true });
      return { status: "download-failed", detail: result.tail.slice(-1000) || result.error || "download failed" };
    }
    transport = "https";
  }
  let identity;
  try { identity = inspectBytes(file); }
  catch (error) { return { status: "invalid-source", detail: error.message }; }
  if (system.sourceBlob) {
    const bytes = readFileSync(file);
    const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (blob !== system.sourceBlob) return { status: "source-drift", detail: "Downloaded bytes differ from the publisher's pinned Git blob." };
  }
  if (pinned && !refresh && (pinned.sha256 !== identity.sha256 || pinned.url !== system.url)) {
    return { status: "source-drift", detail: "Source bytes or URL differ from the lock. Inspect the change, then use --refresh to record it." };
  }
  if (!pinned && !refresh) return { status: "unlocked", detail: "No source lock; use --refresh for the initial acquisition." };
  const destination = join(cache, `${identity.sha256}.${system.extension}`);
  if (destination !== file) copyFileSync(file, destination);
  // The lock records public contract provenance only. No tenant URL or token is collected.
  const entry = { ...identity, url: system.url, acquiredAt: pinned?.sha256 === identity.sha256 ? pinned.acquiredAt : new Date().toISOString() };
  if (refresh) lock[system.id] = entry;
  return { status: "acquired", file: destination, transport, ...entry };
}

export function saveLock(file, sources) {
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ version: 1, sources }, null, 2)}\n`);
  renameSync(temporary, file);
}
