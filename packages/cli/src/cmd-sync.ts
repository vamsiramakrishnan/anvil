import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import {
  affectedCapabilities,
  type CertificationRef,
  compile,
  computeSourceHash,
  createSnapshot,
  DRIFT_SEVERITY_ORDER,
  DriftRecord,
  type DriftSeverity,
  diffContracts,
  driftRecordId,
  invalidatedCertifications,
  parseSourceSnapshot,
  type SnapshotFileInput,
  type SourceSnapshot,
} from "@anvil/compiler";
import { Certification, readBundleDir } from "@anvil/generators";
import { loadBundleAir, resolveBundleDir } from "./cmd-certify.js";
import type { CliIO } from "./io.js";

/**
 * `anvil sync <spec> <dir|air.yaml>` — Layer 6, drift detection. Re-imports the
 * spec through the Layer 0 snapshot layer (locking a new snapshot when content
 * changed), recompiles it IN MEMORY, and diffs the fresh contract against the
 * stored AIR. Read-only toward the model by construction: it never mutates AIR,
 * never applies spec changes, and never touches capability lifecycles — the
 * only writes are the locked snapshot and the drift record under
 * `.anvil/drift/`. Exits non-zero when safety-semantic (high/blocking) drift is
 * found, so it gates a pipeline the same way `anvil assess` does.
 */
export async function cmdSync(
  args: string[],
  flags: Record<string, string | boolean>,
  io: CliIO,
  deps: { now?: () => Date } = {},
): Promise<number> {
  const [specPath, bundlePath] = args;
  if (!specPath || !bundlePath) {
    io.err("Usage: anvil sync <spec-path> <dir|air.yaml> [--manifest f] [--root ws] [--json]");
    return 1;
  }
  if (!existsSync(specPath)) {
    io.err(`No such spec: ${specPath}`);
    return 1;
  }
  const root = typeof flags.root === "string" ? flags.root : ".";
  const now = deps.now ?? (() => new Date());

  // Layer 0 first: hash what the spec says NOW and compare against the locked
  // snapshots for this source. Unchanged content is the fast path — same hash,
  // no compile, no drift.
  const inputs = collectSpecFiles(specPath);
  const sourceHash = inputs.length > 0 ? computeSourceHash(inputs) : undefined;
  const previous = latestSnapshotFor(root, specPath);
  if (sourceHash !== undefined && previous && previous.sourceHash === sourceHash) {
    const outstanding = loadDriftRecords(root).filter(
      (r) => r.sourceHash === sourceHash && r.reviewedAt === undefined,
    );
    if (flags.json === true) {
      io.out(
        JSON.stringify(
          {
            changed: false,
            sourceHash,
            snapshotId: previous.id,
            outstandingDrift: outstanding.map((r) => r.id),
          },
          null,
          2,
        ),
      );
    } else {
      io.out(`Source unchanged since snapshot '${previous.id}' (${sourceHash}). No drift.`);
      for (const r of outstanding) {
        io.out(`  note: unreviewed drift record '${r.id}' already covers this content.`);
      }
    }
    return 0;
  }

  // Content changed (or was never locked): lock a new snapshot before anything
  // else, so provenance exists even if the compile below fails.
  const { snapshot, diagnostics } = createSnapshot({ files: inputs, sourceUri: specPath, now });
  if (!snapshot) {
    for (const d of diagnostics)
      io.err(`${d.level.toUpperCase().padEnd(8)} ${d.code}  ${d.message}`);
    return 1;
  }
  lockSnapshot(root, snapshot, inputs);

  // Recompile in memory. The spec text is the snapshot's single detected spec
  // document; a directory with several primary specs is ambiguous.
  const detected = snapshot.files.filter((f) => f.detected);
  if (detected.length > 1) {
    io.err(
      `Ambiguous source: ${detected.length} spec documents detected (${detected.map((f) => f.path).join(", ")}). Pass the primary spec file.`,
    );
    return 1;
  }
  const specFile = detected[0]?.path;
  const spec = inputs.find((f) => f.path === specFile)?.content ?? "";
  const manifestPath = typeof flags.manifest === "string" ? flags.manifest : undefined;
  const fresh = await compile({
    spec,
    manifest: manifestPath ? readFileSync(manifestPath, "utf8") : undefined,
    sourceUri: specPath,
  });

  // The stored contract: AIR plus any certifications living in the bundle.
  const dir = resolveBundleDir(bundlePath);
  const bundleFiles = readBundleDir(dir);
  const stored = loadBundleAir(dir, bundleFiles);

  const items = diffContracts(stored, fresh);
  const certs = certificationRefs(bundleFiles);
  const impacts = invalidatedCertifications(items, certs);

  if (items.length === 0) {
    if (flags.json === true) {
      io.out(
        JSON.stringify({ changed: true, sourceHash: snapshot.sourceHash, items: [] }, null, 2),
      );
    } else {
      io.out(sourceHashLine(previous?.sourceHash, snapshot.sourceHash, snapshot.id));
      io.out("No semantic drift: the recompiled contract matches the stored AIR.");
    }
    return 0;
  }

  const record: DriftRecord = {
    schemaVersion: 1,
    id: driftRecordId({
      serviceId: stored.service.id,
      sourceHash: snapshot.sourceHash,
      previousSourceHash: previous?.sourceHash,
      itemIds: items.map((i) => i.id),
    }),
    serviceId: stored.service.id,
    sourceUri: specPath,
    snapshotId: snapshot.id,
    previousSourceHash: previous?.sourceHash,
    sourceHash: snapshot.sourceHash,
    bundleDir: dir,
    detectedAt: now().toISOString(),
    items,
    affectedCapabilityIds: affectedCapabilities(items),
    invalidatedCertifications: impacts.map((i) => ({ ...i.ref, invalidatedBy: i.invalidatedBy })),
  };
  const recordPath = join(driftRoot(root), `${record.id}.json`);
  mkdirSync(dirname(recordPath), { recursive: true });
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

  if (flags.json === true) {
    io.out(JSON.stringify({ changed: true, record, recordPath }, null, 2));
  } else {
    io.out(sourceHashLine(previous?.sourceHash, snapshot.sourceHash, snapshot.id));
    io.out("");
    io.out(renderDriftReport(record));
    io.out("");
    io.out(`Wrote ${recordPath}. Review it with \`anvil drift show ${record.id}\`;`);
    io.out("mark it reviewed with `anvil drift accept`. AIR was not changed.");
  }
  // Safety-semantic drift gates the pipeline; lower severities inform it.
  return items.some((i) => i.severity === "blocking" || i.severity === "high") ? 1 : 0;
}

/** The one-line source identity summary at the top of the report. */
function sourceHashLine(previous: string | undefined, current: string, snapshotId: string): string {
  const from = previous ? `${previous} → ` : "";
  return `Source hash: ${from}${current}  (locked snapshot '${snapshotId}')`;
}

/**
 * The human drift report: items grouped by severity (highest first), then the
 * capability and certification consequences. Shared with `anvil drift show`.
 */
export function renderDriftReport(record: DriftRecord): string {
  const lines: string[] = [];
  lines.push(
    `Drift ${record.id} — ${record.serviceId}: ${record.items.length} item(s) vs ${record.bundleDir}`,
  );
  for (const severity of DRIFT_SEVERITY_ORDER) {
    const group = record.items.filter((i) => i.severity === severity);
    if (group.length === 0) continue;
    lines.push(`  ${severity.toUpperCase()} (${group.length})`);
    for (const i of group)
      lines.push(`    [${i.id}] ${i.operationId} ${i.coordinate}: ${i.message}`);
  }
  lines.push(`  affected capabilities: ${record.affectedCapabilityIds.join(", ") || "(none)"}`);
  if (record.invalidatedCertifications.length === 0) {
    lines.push("  invalidated certifications: (none)");
  } else {
    lines.push("  invalidated certifications (recertify with `anvil certify`):");
    for (const c of record.invalidatedCertifications) {
      lines.push(
        `    ${c.path} (${c.capabilityId ?? "whole service"}, was ${c.status}) — ${c.invalidatedBy.length} item(s)`,
      );
    }
  }
  if (record.reviewedAt) {
    lines.push(
      `  reviewed: ${record.reviewedAt}${record.reviewNote ? ` — ${record.reviewNote}` : ""}`,
    );
  }
  return lines.join("\n");
}

/* ------------------------------ drift storage ------------------------------ */

/** Where drift records live inside a workspace. */
export function driftRoot(root: string): string {
  return join(root, ".anvil", "drift");
}

/** Every parseable drift record in the workspace, sorted by id. */
export function loadDriftRecords(root: string): DriftRecord[] {
  const dir = driftRoot(root);
  if (!existsSync(dir)) return [];
  const out: DriftRecord[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    const parsed = DriftRecord.safeParse(JSON.parse(readFileSync(join(dir, entry), "utf8")));
    if (parsed.success) out.push(parsed.data);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/* ------------------------------ snapshot shell ------------------------------ */

/**
 * Gather the spec file set exactly like `anvil source add` does: a single file,
 * or every .yaml/.yml/.json under a directory. Kept local (not shared with
 * cmd-source) so the two commands stay independently mergeable; the hashing and
 * model live in @anvil/compiler either way.
 */
const SPEC_EXTENSIONS = new Set([".yaml", ".yml", ".json"]);

function collectSpecFiles(target: string): SnapshotFileInput[] {
  if (statSync(target).isFile()) {
    return [{ path: basename(target), content: readFileSync(target, "utf8") }];
  }
  const out: SnapshotFileInput[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (SPEC_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        out.push({
          path: relative(target, full).replaceAll("\\", "/"),
          content: readFileSync(full, "utf8"),
        });
      }
    }
  };
  walk(target);
  return out;
}

/** The most recently imported locked snapshot for this source path, if any. */
function latestSnapshotFor(root: string, specPath: string): SourceSnapshot | undefined {
  const sourcesDir = join(root, ".anvil", "sources");
  if (!existsSync(sourcesDir)) return undefined;
  const wanted = resolve(specPath);
  let latest: SourceSnapshot | undefined;
  for (const entry of readdirSync(sourcesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(sourcesDir, entry.name, "source.json");
    if (!existsSync(path)) continue;
    const { snapshot } = parseSourceSnapshot(readFileSync(path, "utf8"));
    if (!snapshot || resolve(snapshot.sourceUri) !== wanted) continue;
    if (!latest || snapshot.importedAt > latest.importedAt) latest = snapshot;
  }
  return latest;
}

/** Lock the snapshot the way `anvil source add` does: source.json + raw/. */
function lockSnapshot(root: string, snapshot: SourceSnapshot, inputs: SnapshotFileInput[]): void {
  const dir = join(root, ".anvil", "sources", snapshot.id);
  const write = (path: string, contents: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, "utf8");
  };
  write(join(dir, "source.json"), `${JSON.stringify(snapshot, null, 2)}\n`);
  const byPath = new Map(inputs.map((f) => [f.path, f.content]));
  for (const file of snapshot.files) {
    write(join(dir, "raw", file.path), byPath.get(file.path) ?? "");
  }
}

/* --------------------------- certification refs ---------------------------- */

/**
 * Adapt every certification.json found in the bundle (root or nested capability
 * bundles) into the compiler's structural CertificationRef shape.
 */
function certificationRefs(files: Record<string, string>): CertificationRef[] {
  const refs: CertificationRef[] = [];
  for (const rel of Object.keys(files).sort()) {
    if (rel !== "certification.json" && !rel.endsWith("/certification.json")) continue;
    try {
      const parsed = Certification.safeParse(JSON.parse(files[rel] ?? ""));
      if (parsed.success) {
        refs.push({
          path: rel,
          capabilityId: parsed.data.capabilityId,
          status: parsed.data.status,
        });
      }
    } catch {
      // An unreadable record cannot be judged; skip it rather than crash a diff.
    }
  }
  return refs;
}

/** Exported for cmd-drift's severity summaries. */
export function severityCounts(record: DriftRecord): Partial<Record<DriftSeverity, number>> {
  const counts: Partial<Record<DriftSeverity, number>> = {};
  for (const i of record.items) counts[i.severity] = (counts[i.severity] ?? 0) + 1;
  return counts;
}
