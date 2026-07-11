import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import {
  createSnapshot,
  parseSourceSnapshot,
  type SnapshotFileInput,
  type SourceDiagnostic,
  type SourceSnapshot,
  SourceSnapshotKind,
  verifySnapshot,
} from "@anvil/compiler";
import type { CliIO } from "./io.js";

/**
 * `anvil source <subcommand>` — Layer 0, source import and locking. `add`
 * captures what the customer supplied (verbatim raw/ copies + a locked
 * source.json) before any compilation; `validate` proves the capture is still
 * intact. The model, detection, and hashing live in @anvil/compiler and are
 * pure; this file is the filesystem shell around them.
 */
export async function cmdSource(
  args: string[],
  flags: Record<string, string | boolean>,
  io: CliIO,
): Promise<number> {
  const sub = args[0];
  switch (sub) {
    case "add":
      return cmdSourceAdd(args.slice(1), flags, io);
    case "list":
      return cmdSourceList(flags, io);
    case "show":
      return cmdSourceShow(args.slice(1), flags, io);
    case "validate":
      return cmdSourceValidate(args.slice(1), flags, io);
    default:
      if (sub && sub !== "help") io.err(`Unknown source subcommand: '${sub}'.`);
      io.err("Usage: anvil source add      <path|dir> [--id <id>] [--kind <kind>] [--json]");
      io.err("       anvil source list     [--json]");
      io.err("       anvil source show     <id> [--json]");
      io.err("       anvil source validate <id> [--json]");
      io.err("Snapshots are locked under .anvil/sources/<id>/ (--root <dir> to relocate).");
      return sub && sub !== "help" ? 1 : 0;
  }
}

/** Extensions considered part of an import; other files are ignored. */
const SPEC_EXTENSIONS = new Set([".yaml", ".yml", ".json"]);

function sourcesRoot(flags: Record<string, string | boolean>): string {
  const root = typeof flags.root === "string" ? flags.root : ".";
  return join(root, ".anvil", "sources");
}

/** What locking a source produced: the record, or the diagnostics that stopped it. */
export interface LockedSource {
  /** Absent when any error-level diagnostic was produced (nothing was written). */
  snapshot?: SourceSnapshot;
  diagnostics: SourceDiagnostic[];
  /** The locked snapshot directory, present only on success. */
  dir?: string;
}

/**
 * Import, detect, hash, and lock a source under `<root>/.anvil/sources/<id>/`
 * (source.json + verbatim raw/ copies). This is the single write path behind
 * `anvil source add`, exported so `anvil agentify` locks sources through the
 * identical layout instead of a second implementation. Broken input yields
 * structured diagnostics and writes nothing.
 */
export function lockSource(
  target: string,
  options: {
    /** Workspace root; snapshots land under its .anvil/sources. Default ".". */
    root?: string;
    id?: string;
    kind?: SourceSnapshotKind;
    metadata?: SourceSnapshot["metadata"];
  } = {},
): LockedSource {
  if (!existsSync(target)) {
    return {
      diagnostics: [
        {
          level: "error",
          code: "source/not_found",
          message: `No such file or directory: ${target}`,
        },
      ],
    };
  }
  const inputs = collectFiles(target);
  const { snapshot, diagnostics } = createSnapshot({
    files: inputs,
    sourceUri: target,
    id: options.id,
    kind: options.kind,
    metadata: options.metadata,
  });
  if (!snapshot) return { diagnostics };

  // Lock it: source.json is the record, raw/ is the verbatim evidence.
  const dir = join(options.root ?? ".", ".anvil", "sources", snapshot.id);
  writeFile(join(dir, "source.json"), `${JSON.stringify(snapshot, null, 2)}\n`);
  const byPath = new Map(inputs.map((f) => [f.path, f.content]));
  for (const file of snapshot.files) {
    writeFile(join(dir, "raw", file.path), byPath.get(file.path) ?? "");
  }
  return { snapshot, diagnostics, dir };
}

/** `anvil source add <path|dir>` — import, detect, hash, and lock. */
function cmdSourceAdd(args: string[], flags: Record<string, string | boolean>, io: CliIO): number {
  const target = args[0];
  if (!target) {
    io.err("Usage: anvil source add <path|dir> [--id <id>] [--kind <kind>] [--json]");
    return 1;
  }
  let kind: SourceSnapshotKind | undefined;
  if (typeof flags.kind === "string") {
    const parsed = SourceSnapshotKind.safeParse(flags.kind);
    if (!parsed.success) {
      return emitDiagnostics(io, flags, [
        {
          level: "error",
          code: "source/unknown_kind",
          message: `Unknown kind '${flags.kind}'. Expected one of: ${SourceSnapshotKind.options.join(", ")}.`,
        },
      ]);
    }
    kind = parsed.data;
  }

  const { snapshot, diagnostics, dir } = lockSource(target, {
    root: str(flags.root),
    id: str(flags.id),
    kind,
    metadata: {
      environment: str(flags.environment),
      gatewayProduct: str(flags["gateway-product"]),
      organization: str(flags.organization),
      workspace: str(flags.workspace),
    },
  });
  if (!snapshot) return emitDiagnostics(io, flags, diagnostics);

  if (flags.json === true) {
    io.out(JSON.stringify({ snapshot, diagnostics }, null, 2));
    return 0;
  }
  printDiagnostics(io, diagnostics);
  io.out(
    `Locked source '${snapshot.id}' (${snapshot.kind}, ${snapshot.files.length} file(s)) → ${dir}`,
  );
  for (const f of snapshot.files) io.out(`  ${f.path.padEnd(34)} ${describeFile(f)}`);
  io.out(`  sourceHash: ${snapshot.sourceHash}`);
  return 0;
}

/** `anvil source list` — every locked snapshot in this workspace. */
function cmdSourceList(flags: Record<string, string | boolean>, io: CliIO): number {
  const snapshots = loadAllSnapshots(sourcesRoot(flags));
  if (flags.json === true) {
    io.out(JSON.stringify(snapshots, null, 2));
    return 0;
  }
  if (snapshots.length === 0) {
    io.out("No sources locked. Import one with `anvil source add <path|dir>`.");
    return 0;
  }
  for (const s of snapshots) {
    io.out(
      `  ${s.id.padEnd(34)} ${s.kind.padEnd(9)} ${String(s.files.length).padStart(2)} file(s)  ${s.importedAt}`,
    );
  }
  return 0;
}

/** `anvil source show <id>` — one snapshot in full. */
function cmdSourceShow(args: string[], flags: Record<string, string | boolean>, io: CliIO): number {
  const loaded = loadSnapshot(args[0], flags, io);
  if (typeof loaded === "number") return loaded;
  const { snapshot } = loaded;
  if (flags.json === true) {
    io.out(JSON.stringify(snapshot, null, 2));
    return 0;
  }
  io.out(`${snapshot.id} (${snapshot.kind})`);
  io.out(`  sourceUri:  ${snapshot.sourceUri}`);
  io.out(`  importedAt: ${snapshot.importedAt}`);
  io.out(`  sourceHash: ${snapshot.sourceHash}`);
  for (const f of snapshot.files) {
    io.out(
      `  ${f.path.padEnd(34)} ${describeFile(f)}  ${f.bytes} bytes  ${f.sha256.slice(0, 12)}…`,
    );
  }
  const meta = Object.entries(snapshot.metadata).filter(([, v]) => v !== undefined);
  if (meta.length > 0) io.out(`  metadata: ${meta.map(([k, v]) => `${k}=${v}`).join(" ")}`);
  return 0;
}

/** `anvil source validate <id>` — re-hash raw/ against the locked record. */
function cmdSourceValidate(
  args: string[],
  flags: Record<string, string | boolean>,
  io: CliIO,
): number {
  const loaded = loadSnapshot(args[0], flags, io);
  if (typeof loaded === "number") return loaded;
  const { snapshot, dir } = loaded;
  const rawDir = join(dir, "raw");
  const files = existsSync(rawDir) ? collectFiles(rawDir) : [];
  const { ok, diagnostics } = verifySnapshot(snapshot, files);
  if (flags.json === true) {
    io.out(JSON.stringify({ id: snapshot.id, ok, diagnostics }, null, 2));
    return ok ? 0 : 1;
  }
  if (ok) {
    io.out(
      `Source '${snapshot.id}' is intact: ${snapshot.files.length} file(s) match ${snapshot.sourceHash}.`,
    );
    return 0;
  }
  printDiagnostics(io, diagnostics);
  io.err(
    `Source '${snapshot.id}' does NOT match its locked snapshot. Re-import it with \`anvil source add\`.`,
  );
  return 1;
}

/* --------------------------------- helpers -------------------------------- */

/**
 * Gather the import file set: a single file, or every .yaml/.yml/.json under a
 * directory (hidden directories skipped). Paths are relative + posix so the
 * snapshot — and therefore the hash — is location- and OS-independent.
 */
function collectFiles(target: string): SnapshotFileInput[] {
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

/** Load one snapshot by id, or print why not and return an exit code. */
function loadSnapshot(
  id: string | undefined,
  flags: Record<string, string | boolean>,
  io: CliIO,
): { snapshot: SourceSnapshot; dir: string } | number {
  if (!id) {
    io.err("Usage: anvil source <show|validate> <id> [--json]");
    return 1;
  }
  const dir = join(sourcesRoot(flags), id);
  const path = join(dir, "source.json");
  if (!existsSync(path)) {
    return emitDiagnostics(io, flags, [
      {
        level: "error",
        code: "source/not_found",
        message: `No locked source '${id}'. Run \`anvil source list\`.`,
      },
    ]);
  }
  const { snapshot, diagnostics } = parseSourceSnapshot(readFileSync(path, "utf8"));
  if (!snapshot) return emitDiagnostics(io, flags, diagnostics);
  return { snapshot, dir };
}

function loadAllSnapshots(root: string): SourceSnapshot[] {
  if (!existsSync(root)) return [];
  const out: SourceSnapshot[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name, "source.json");
    if (!existsSync(path)) continue;
    const { snapshot } = parseSourceSnapshot(readFileSync(path, "utf8"));
    if (snapshot) out.push(snapshot);
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

function describeFile(f: SourceSnapshot["files"][number]): string {
  return f.detected
    ? `${f.detected.kind} ${f.detected.version} (${f.syntax})`
    : `supporting (${f.syntax})`;
}

/** Print diagnostics (or --json them) and exit non-zero on any error. */
function emitDiagnostics(
  io: CliIO,
  flags: Record<string, string | boolean>,
  diagnostics: SourceDiagnostic[],
): number {
  if (flags.json === true) io.out(JSON.stringify({ diagnostics }, null, 2));
  else printDiagnostics(io, diagnostics);
  return diagnostics.some((d) => d.level === "error") ? 1 : 0;
}

function printDiagnostics(io: CliIO, diagnostics: SourceDiagnostic[]): void {
  for (const d of diagnostics) {
    const line = `${d.level.toUpperCase().padEnd(8)} ${d.code.padEnd(26)} ${d.path ?? ""}  ${d.message}`;
    (d.level === "error" ? io.err : io.out)(line);
  }
}

function writeFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
}

function str(v: string | boolean | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}
