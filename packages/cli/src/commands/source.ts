import { join } from "node:path";
import {
  FileSystemSourceSnapshotStore,
  FilesystemSourceImporter,
  type SourceDiagnostic,
  SourceOriginKind,
  SourceService,
  type SourceSnapshot,
} from "@anvil/compiler";
import type { Command } from "commander";
import type { CliIO } from "../io.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";

/**
 * `anvil source <subcommand>` — Layer 0, the immutable source snapshot. This
 * file is deliberately thin: Commander parses options → call SourceService →
 * render → exit code. Discovery, hashing, status, and storage all live in
 * @anvil/compiler's source subsystem, so `anvil agentify` and `anvil sync`
 * lock sources through the identical path.
 */
export function registerSource(parent: Command, ctx: CommandContext): void {
  const source = annotate(
    parent
      .command("source")
      .summary("Import and lock API source graphs as immutable content-addressed snapshots.")
      .description(
        "Layer 0 — capture what the customer actually supplied, before any compilation. " +
          "`anvil source add <dir | file...>` imports explicit entrypoint files (plus every local $ref reachable from them) or a whole directory (files declaring `openapi:`/`swagger:` become entrypoints; unrelated YAML/JSON is excluded), records each entrypoint's own format and version, hashes the verbatim bytes deterministically, and atomically locks a snapshot under .anvil/sources/<snapshot-id>/ (source.json plus byte-identical raw/ copies). " +
          "The snapshot-id is content-derived; `--name` attaches a human label that never controls identity or a path, and `--origin` declares a gateway origin (apigee, mulesoft, kong, api_connect, wso2) independent of the spec format. References escaping the import root are rejected; remote refs are recorded as external, never fetched. " +
          "Anything readable is snapshotted — broken input locks an `invalid` (or `unclassified`) snapshot with its diagnostics inside and exits non-zero, and only `valid` snapshots may be compiled. " +
          "`list` and `show` are read-only (list reports corrupt slots explicitly); `validate <snapshot-id>` re-hashes raw/ against the locked source.json, so tampering is caught before it can contaminate a compile.",
      ),
    { mutates: true },
  );

  source
    .command("add")
    .summary("Import, discover, freeze, and lock a spec directory or explicit files.")
    .argument("<targets...>", "a directory or explicit entrypoint files")
    .option("--name <label>", "human label (never controls identity or a path)")
    .option(
      "--origin <kind>",
      "declared gateway origin (apigee, mulesoft, kong, api_connect, wso2)",
    )
    .option("--environment <env>", "gateway environment recorded as metadata")
    .option("--gateway-product <product>", "gateway product recorded as metadata")
    .option("--organization <org>", "owning organization recorded as metadata")
    .option("--workspace <workspace>", "gateway workspace recorded as metadata")
    .option("--root <dir>", "workspace root for .anvil/sources", ".")
    .option("--json", "emit the snapshot, lock directory, and diagnostics as JSON")
    .action(async (targets: string[], opts: SourceAddOptions) => {
      ctx.code = await runSourceAdd(targets, opts, ctx.io);
    });

  source
    .command("list")
    .summary("List every locked snapshot, and every corrupt slot.")
    .option("--root <dir>", "workspace root for .anvil/sources", ".")
    .option("--json", "emit the listing as JSON")
    .action(async (opts: SourceCommonOptions) => {
      ctx.code = await runSourceList(opts, ctx.io);
    });

  source
    .command("show")
    .summary("Show one locked snapshot in full.")
    .argument("<snapshot-id>", "the content-derived snapshot id")
    .option("--root <dir>", "workspace root for .anvil/sources", ".")
    .option("--json", "emit the snapshot as JSON")
    .action(async (id: string, opts: SourceCommonOptions) => {
      ctx.code = await runSourceShow(id, opts, ctx.io);
    });

  source
    .command("validate")
    .summary("Re-hash raw/ against the locked source.json to detect tampering.")
    .argument("<snapshot-id>", "the content-derived snapshot id")
    .option("--root <dir>", "workspace root for .anvil/sources", ".")
    .option("--json", "emit the verdict and diagnostics as JSON")
    .action(async (id: string, opts: SourceCommonOptions) => {
      ctx.code = await runSourceValidate(id, opts, ctx.io);
    });
}

interface SourceCommonOptions {
  root?: string;
  json?: boolean;
}

interface SourceAddOptions extends SourceCommonOptions {
  name?: string;
  origin?: string;
  environment?: string;
  gatewayProduct?: string;
  organization?: string;
  workspace?: string;
}

/** Build the service against the workspace the --root option points at. */
export function sourceService(opts: { root?: string }): SourceService {
  const root = opts.root ?? ".";
  return new SourceService({
    importer: new FilesystemSourceImporter(),
    store: new FileSystemSourceSnapshotStore(join(root, ".anvil", "sources")),
  });
}

/** `anvil source add <dir | file...>` — import, discover, freeze, and lock. */
async function runSourceAdd(targets: string[], opts: SourceAddOptions, io: CliIO): Promise<number> {
  let originKind: SourceOriginKind | undefined;
  if (opts.origin !== undefined) {
    const parsed = SourceOriginKind.safeParse(opts.origin);
    if (!parsed.success) {
      return emitDiagnostics(io, opts, [
        {
          level: "error",
          code: "source/unknown_origin",
          message: `Unknown origin '${opts.origin}'. Expected one of: ${SourceOriginKind.options.join(", ")}.`,
        },
      ]);
    }
    originKind = parsed.data;
  }

  const { snapshot, dir, created, diagnostics } = await sourceService(opts).add(targets, {
    name: opts.name,
    originKind,
    metadata: {
      environment: opts.environment,
      gatewayProduct: opts.gatewayProduct,
      organization: opts.organization,
      workspace: opts.workspace,
    },
  });
  // No snapshot means nothing was readable at all; otherwise even an invalid
  // capture is locked, and the exit code reports whether it can be compiled.
  if (!snapshot) return emitDiagnostics(io, opts, diagnostics);

  if (opts.json === true) {
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
async function runSourceList(opts: SourceCommonOptions, io: CliIO): Promise<number> {
  const listing = await sourceService(opts).list();
  if (opts.json === true) {
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
async function runSourceShow(id: string, opts: SourceCommonOptions, io: CliIO): Promise<number> {
  const { snapshot, diagnostics } = await sourceService(opts).show(id);
  if (!snapshot) return emitDiagnostics(io, opts, diagnostics);
  if (opts.json === true) {
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
async function runSourceValidate(
  id: string,
  opts: SourceCommonOptions,
  io: CliIO,
): Promise<number> {
  const { ok, diagnostics } = await sourceService(opts).validate(id);
  if (opts.json === true) {
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

function describeFile(snapshot: SourceSnapshot, f: SourceSnapshot["files"][number]): string {
  const entry = snapshot.entrypoints.find((e) => e.path === f.path);
  const syntax = f.syntax ?? "binary";
  return entry ? `${entry.format} ${entry.version} (${syntax})` : `${f.role} (${syntax})`;
}

/** Print diagnostics (or --json them) and exit non-zero on any error. */
function emitDiagnostics(
  io: CliIO,
  opts: { json?: boolean },
  diagnostics: SourceDiagnostic[],
): number {
  if (opts.json === true) io.out(JSON.stringify({ diagnostics }, null, 2));
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
