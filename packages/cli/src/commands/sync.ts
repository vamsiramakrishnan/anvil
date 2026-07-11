import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  affectedCapabilities,
  type CertificationRef,
  compile,
  DRIFT_SEVERITY_ORDER,
  DriftRecord,
  type DriftSeverity,
  diffContracts,
  driftRecordId,
  FileSystemSourceSnapshotStore,
  FilesystemSourceImporter,
  invalidatedCertifications,
  type SourceSnapshot,
  type SourceSnapshotStore,
  snapshotFromImport,
} from "@anvil/compiler";
import { Certification, readBundleDir } from "@anvil/generators";
import type { Command } from "commander";
import type { CliIO } from "../io.js";
import { loadBundleAir, resolveBundleDir } from "./certify.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";
import { printDiagnostics } from "./source.js";

/**
 * `anvil sync <spec> <dir|air.yaml>` — Layer 6, drift detection. Re-imports the
 * spec through the Layer 0 snapshot layer (locking a new snapshot when content
 * changed), recompiles it IN MEMORY, and diffs the fresh contract against the
 * stored AIR. Read-only toward the model by construction: it never mutates AIR,
 * never applies spec changes, and never touches capability lifecycles — the
 * only writes are the locked snapshot and the drift record under
 * `.anvil/drift/`. Exits non-zero when safety-semantic (high/blocking) drift is
 * found, so it gates a pipeline (like `anvil assess --check`, sync's exit code
 * is the gate — drift severe enough to demand recertification must stop a line).
 */
export function registerSync(parent: Command, ctx: CommandContext): void {
  annotate(
    parent
      .command("sync")
      .summary("Detect semantic drift between the current spec and a stored AIR contract.")
      .description(
        'Layer 6 — drift and recertification. Re-imports the spec through the Layer 0 snapshot layer (unchanged content is a fast path: same sourceHash, no drift), recompiles it in memory, and diffs the fresh contract against the stored AIR: operations added/removed, field type and requiredness changes, auth scope/type changes, retry/idempotency/confirmation semantics, pagination, and documentation-only edits (info). Safety-loosening drift (a dropped confirmation, new retries, an idempotency claim crossing "none", auth vanishing) is blocking; other safety-semantic drift is high. Reports which capabilities are affected and which certifications must be re-earned even though their bundle bytes are untouched, then writes a drift record to .anvil/drift/<id>.json. Never mutates AIR, never applies spec changes, never touches capability lifecycles. Exits non-zero on high/blocking drift so it can gate a pipeline.',
      )
      .argument("<spec-path>", "the spec file as it exists now")
      .argument("<path>", "bundle directory or air.yaml holding the stored contract")
      .option("--manifest <file>", "Anvil manifest applied to the in-memory recompile")
      .option("--root <ws>", "workspace root for .anvil/sources and .anvil/drift", ".")
      .option("--json", "emit the drift verdict (and record) as JSON")
      .action(async (specPath: string, bundlePath: string, opts: SyncOptions) => {
        ctx.code = await runSync(specPath, bundlePath, opts, ctx.io);
      }),
    { mutates: true },
  );
}

interface SyncOptions {
  manifest?: string;
  root?: string;
  json?: boolean;
}

/** The sync action, exported with an injectable clock so tests can pin time. */
export async function runSync(
  specPath: string,
  bundlePath: string,
  opts: SyncOptions,
  io: CliIO,
  deps: { now?: () => Date } = {},
): Promise<number> {
  if (!existsSync(specPath)) {
    io.err(`No such spec: ${specPath}`);
    return 1;
  }
  const root = opts.root ?? ".";
  const now = deps.now ?? (() => new Date());

  // Layer 0 first: re-import what the spec says NOW (a pure read — nothing is
  // written yet) and compare against the locked snapshots for this source.
  // Unchanged content is the fast path — same hash, no compile, no drift.
  const store = new FileSystemSourceSnapshotStore(join(root, ".anvil", "sources"));
  const imported = await new FilesystemSourceImporter().import([specPath]);
  const previous = await latestSnapshotFor(store, specPath);
  if (
    imported.sourceHash !== undefined &&
    previous &&
    previous.sourceHash === imported.sourceHash
  ) {
    const outstanding = loadDriftRecords(root).filter(
      (r) => r.sourceHash === imported.sourceHash && r.reviewedAt === undefined,
    );
    if (opts.json === true) {
      io.out(
        JSON.stringify(
          {
            changed: false,
            sourceHash: imported.sourceHash,
            snapshotId: previous.snapshotId,
            outstandingDrift: outstanding.map((r) => r.id),
          },
          null,
          2,
        ),
      );
    } else {
      io.out(
        `Source unchanged since snapshot '${previous.snapshotId}' (${imported.sourceHash}). No drift.`,
      );
      for (const r of outstanding) {
        io.out(`  note: unreviewed drift record '${r.id}' already covers this content.`);
      }
    }
    return 0;
  }

  // Content changed (or was never locked): lock a new snapshot before anything
  // else, so provenance exists even if the compile below fails.
  const snapshot = snapshotFromImport(imported, { originUri: specPath, clock: now });
  if (!snapshot) {
    printDiagnostics(io, imported.diagnostics);
    return 1;
  }
  const locked = await store.create(snapshot, imported.files);
  if (!locked.ok) {
    printDiagnostics(io, locked.diagnostics);
    return 1;
  }
  // Only a valid snapshot may be compiled; an invalid or unclassified one is
  // still locked above, with its diagnostics inside it.
  if (snapshot.status !== "valid") {
    printDiagnostics(io, snapshot.diagnostics);
    io.err(`Snapshot ${snapshot.snapshotId} is ${snapshot.status}; refusing to compile it.`);
    return 1;
  }

  // Recompile in memory. The spec text is the snapshot's single entrypoint;
  // a directory with several primary specs is ambiguous.
  if (snapshot.entrypoints.length > 1) {
    io.err(
      `Ambiguous source: ${snapshot.entrypoints.length} spec documents detected (${snapshot.entrypoints.map((e) => e.path).join(", ")}). Pass the primary spec file.`,
    );
    return 1;
  }
  const specFile = snapshot.entrypoints[0]?.path;
  const specBytes = imported.files.find((f) => f.path === specFile)?.bytes;
  const spec = specBytes ? new TextDecoder("utf-8").decode(specBytes) : "";
  const fresh = await compile({
    spec,
    manifest: opts.manifest ? readFileSync(opts.manifest, "utf8") : undefined,
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
    if (opts.json === true) {
      io.out(
        JSON.stringify({ changed: true, sourceHash: snapshot.sourceHash, items: [] }, null, 2),
      );
    } else {
      io.out(sourceHashLine(previous?.sourceHash, snapshot.sourceHash, snapshot.snapshotId));
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
    snapshotId: snapshot.snapshotId,
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

  if (opts.json === true) {
    io.out(JSON.stringify({ changed: true, record, recordPath }, null, 2));
  } else {
    io.out(sourceHashLine(previous?.sourceHash, snapshot.sourceHash, snapshot.snapshotId));
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

/** The most recently imported locked snapshot for this source path, if any. */
async function latestSnapshotFor(
  store: SourceSnapshotStore,
  specPath: string,
): Promise<SourceSnapshot | undefined> {
  const wanted = resolve(specPath);
  let latest: SourceSnapshot | undefined;
  for (const snapshot of (await store.list()).snapshots) {
    if (resolve(snapshot.origin.uri) !== wanted) continue;
    if (!latest || snapshot.importedAt > latest.importedAt) latest = snapshot;
  }
  return latest;
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

/** Exported for the drift command's severity summaries. */
export function severityCounts(record: DriftRecord): Partial<Record<DriftSeverity, number>> {
  const counts: Partial<Record<DriftSeverity, number>> = {};
  for (const i of record.items) counts[i.severity] = (counts[i.severity] ?? 0) + 1;
  return counts;
}
