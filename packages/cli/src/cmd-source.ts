import { join } from "node:path";
import {
  FileSystemSourceSnapshotStore,
  FilesystemSourceImporter,
  type SourceDiagnostic,
  SourceOriginKind,
  SourceService,
  type SourceSnapshot,
} from "@anvil/compiler";
import type { CliIO } from "./io.js";

/**
 * `anvil source <subcommand>` — Layer 0, the immutable source snapshot. This
 * file is deliberately thin: parse options → call SourceService → render →
 * exit code. Discovery, hashing, status, and storage all live in
 * @anvil/compiler's source subsystem, so `anvil agentify` and `anvil sync`
 * lock sources through the identical path.
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
      io.err(
        "Usage: anvil source add      <dir | file...> [--name <label>] [--origin <kind>] [--json]",
      );
      io.err("       anvil source list     [--json]");
      io.err("       anvil source show     <snapshot-id> [--json]");
      io.err("       anvil source validate <snapshot-id> [--json]");
      io.err(
        "Snapshots are locked under .anvil/sources/<snapshot-id>/ (--root <dir> to relocate).",
      );
      return sub && sub !== "help" ? 1 : 0;
  }
}

/** Build the service against the workspace the --root flag points at. */
export function sourceService(flags: Record<string, string | boolean>): SourceService {
  const root = typeof flags.root === "string" ? flags.root : ".";
  return new SourceService({
    importer: new FilesystemSourceImporter(),
    store: new FileSystemSourceSnapshotStore(join(root, ".anvil", "sources")),
  });
}

/** `anvil source add <dir | file...>` — import, discover, freeze, and lock. */
async function cmdSourceAdd(
  targets: string[],
  flags: Record<string, string | boolean>,
  io: CliIO,
): Promise<number> {
  if (targets.length === 0) {
    io.err("Usage: anvil source add <dir | file...> [--name <label>] [--origin <kind>] [--json]");
    return 1;
  }
  let originKind: SourceOriginKind | undefined;
  if (typeof flags.origin === "string") {
    const parsed = SourceOriginKind.safeParse(flags.origin);
    if (!parsed.success) {
      return emitDiagnostics(io, flags, [
        {
          level: "error",
          code: "source/unknown_origin",
          message: `Unknown origin '${flags.origin}'. Expected one of: ${SourceOriginKind.options.join(", ")}.`,
        },
      ]);
    }
    originKind = parsed.data;
  }

  const { snapshot, dir, created, diagnostics } = await sourceService(flags).add(targets, {
    name: str(flags.name),
    originKind,
    metadata: {
      environment: str(flags.environment),
      gatewayProduct: str(flags["gateway-product"]),
      organization: str(flags.organization),
      workspace: str(flags.workspace),
    },
  });
  // No snapshot means nothing was readable at all; otherwise even an invalid
  // capture is locked, and the exit code reports whether it can be compiled.
  if (!snapshot) return emitDiagnostics(io, flags, diagnostics);

  if (flags.json === true) {
    io.out(JSON.stringify({ snapshot, dir, created, diagnostics }, null, 2));
    return snapshot.status === "valid" ? 0 : 1;
  }
  printDiagnostics(io, diagnostics);
  const label = snapshot.name ? ` '${snapshot.name}'` : "";
  io.out(
    `Locked source ${snapshot.snapshotId}${label} (${snapshot.status}, ${snapshot.files.length} file(s)) → ${dir}`,
  );
  for (const f of snapshot.files) io.out(`  ${f.path.padEnd(34)} ${describeFile(snapshot, f)}`);
  io.out(`  sourceHash: ${snapshot.sourceHash}`);
  if (snapshot.status !== "valid") {
    io.err(`Snapshot is ${snapshot.status}; it will be refused by compilation.`);
    return 1;
  }
  return 0;
}

/** `anvil source list` — every locked snapshot, and every corrupt slot. */
async function cmdSourceList(flags: Record<string, string | boolean>, io: CliIO): Promise<number> {
  const listing = await sourceService(flags).list();
  if (flags.json === true) {
    io.out(JSON.stringify(listing, null, 2));
    return 0;
  }
  if (listing.snapshots.length === 0 && listing.corrupt.length === 0) {
    io.out("No sources locked. Import one with `anvil source add <dir | file...>`.");
    return 0;
  }
  for (const s of listing.snapshots) {
    io.out(
      `  ${s.snapshotId.padEnd(22)} ${s.status.padEnd(12)} ${String(s.files.length).padStart(2)} file(s)  ${s.importedAt}  ${s.name ?? s.origin.uri}`,
    );
  }
  // A corrupt slot is a finding, not a formatting problem — never skip it.
  for (const c of listing.corrupt) {
    io.err(`  ${c.snapshotId.padEnd(22)} CORRUPT      ${c.diagnostics[0]?.message ?? ""}`);
  }
  return 0;
}

/** `anvil source show <snapshot-id>` — one snapshot in full. */
async function cmdSourceShow(
  args: string[],
  flags: Record<string, string | boolean>,
  io: CliIO,
): Promise<number> {
  const loaded = await loadSnapshot(args[0], flags, io);
  if (typeof loaded === "number") return loaded;
  const { snapshot } = loaded;
  if (flags.json === true) {
    io.out(JSON.stringify(snapshot, null, 2));
    return 0;
  }
  io.out(
    `${snapshot.snapshotId}${snapshot.name ? ` '${snapshot.name}'` : ""} (${snapshot.status})`,
  );
  io.out(`  origin:     ${snapshot.origin.kind} ${snapshot.origin.uri}`);
  io.out(`  importedAt: ${snapshot.importedAt}`);
  io.out(`  sourceHash: ${snapshot.sourceHash}`);
  for (const f of snapshot.files) {
    io.out(
      `  ${f.path.padEnd(34)} ${describeFile(snapshot, f)}  ${f.bytes} bytes  ${f.sha256.slice(0, 12)}…`,
    );
  }
  printDiagnostics(io, snapshot.diagnostics);
  const meta = Object.entries(snapshot.metadata).filter(([, v]) => v !== undefined);
  if (meta.length > 0) io.out(`  metadata: ${meta.map(([k, v]) => `${k}=${v}`).join(" ")}`);
  return 0;
}

/** `anvil source validate <snapshot-id>` — re-hash raw/ against the record. */
async function cmdSourceValidate(
  args: string[],
  flags: Record<string, string | boolean>,
  io: CliIO,
): Promise<number> {
  const id = args[0];
  if (!id) {
    io.err("Usage: anvil source <show|validate> <snapshot-id> [--json]");
    return 1;
  }
  const { ok, diagnostics } = await sourceService(flags).validate(id);
  if (flags.json === true) {
    io.out(JSON.stringify({ snapshotId: id, ok, diagnostics }, null, 2));
    return ok ? 0 : 1;
  }
  if (ok) {
    io.out(`Source '${id}' is intact: raw/ matches the locked source.json.`);
    return 0;
  }
  printDiagnostics(io, diagnostics);
  io.err(
    `Source '${id}' does NOT match its locked snapshot. Re-import it with \`anvil source add\`.`,
  );
  return 1;
}

/* --------------------------------- helpers -------------------------------- */

/** Load one snapshot by id, or print why not and return an exit code. */
async function loadSnapshot(
  id: string | undefined,
  flags: Record<string, string | boolean>,
  io: CliIO,
): Promise<{ snapshot: SourceSnapshot } | number> {
  if (!id) {
    io.err("Usage: anvil source <show|validate> <snapshot-id> [--json]");
    return 1;
  }
  const { snapshot, diagnostics } = await sourceService(flags).show(id);
  if (!snapshot) return emitDiagnostics(io, flags, diagnostics);
  return { snapshot };
}

function describeFile(snapshot: SourceSnapshot, f: SourceSnapshot["files"][number]): string {
  const entry = snapshot.entrypoints.find((e) => e.path === f.path);
  const syntax = f.syntax ?? "binary";
  return entry ? `${entry.format} ${entry.version} (${syntax})` : `${f.role} (${syntax})`;
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

export function printDiagnostics(io: CliIO, diagnostics: SourceDiagnostic[]): void {
  for (const d of diagnostics) {
    const at = d.path ? `${d.path}${d.line ? `:${d.line}:${d.column ?? 1}` : ""}` : "";
    const line = `${d.level.toUpperCase().padEnd(8)} ${d.code.padEnd(26)} ${at}  ${d.message}`;
    (d.level === "error" ? io.err : io.out)(line);
  }
}

function str(v: string | boolean | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}
