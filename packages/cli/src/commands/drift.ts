import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DRIFT_SEVERITY_ORDER, DriftRecord } from "@anvil/compiler";
import type { Command } from "commander";
import type { CliIO } from "../io.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";
import { driftRoot, loadDriftRecords, renderDriftReport, severityCounts } from "./sync.js";

/**
 * `anvil drift <subcommand>` — review the drift records `anvil sync` stored
 * under `.anvil/drift/`. `list` and `show` are read-only; `accept` is
 * bookkeeping only — it stamps reviewedAt (plus an optional note) on the
 * record and nothing else. Accepting drift never edits AIR, never re-earns a
 * certification, and never touches capability lifecycles: those decisions go
 * through `anvil compile` / `anvil certify` / `anvil capability` deliberately.
 */
export function registerDrift(parent: Command, ctx: CommandContext): void {
  const drift = annotate(
    parent
      .command("drift")
      .summary("List, inspect, and mark reviewed the drift records `anvil sync` stored.")
      .description(
        "`list` shows every stored drift record with its severity mix and review status; `show <id>` prints one record in full (items grouped by severity, affected capabilities, invalidated certifications). `accept <id> [--note ..]` stamps reviewedAt on the record — bookkeeping only: accepting drift never edits AIR, never restores a certification, and never changes capability lifecycles. Act on drift deliberately with `anvil compile`, `anvil certify`, and the capability review commands.",
      ),
    { mutates: true },
  );

  drift
    .command("list")
    .summary("Every stored drift record as a small table.")
    .option("--root <ws>", "workspace root for .anvil/drift", ".")
    .option("--json", "emit the records as JSON")
    .action((opts: DriftCommonOptions) => {
      ctx.code = runDriftList(opts, ctx.io);
    });

  drift
    .command("show")
    .summary("One drift record in full.")
    .argument("<id>", "a drift record id from `anvil drift list`")
    .option("--root <ws>", "workspace root for .anvil/drift", ".")
    .option("--json", "emit the record as JSON")
    .action((id: string, opts: DriftCommonOptions) => {
      ctx.code = runDriftShow(id, opts, ctx.io);
    });

  drift
    .command("accept")
    .summary("Stamp the record reviewed (bookkeeping only).")
    .argument("<id>", "a drift record id from `anvil drift list`")
    .option("--note <note>", "review note stored on the record")
    .option("--root <ws>", "workspace root for .anvil/drift", ".")
    .option("--json", "emit the reviewed record as JSON")
    .action((id: string, opts: DriftAcceptOptions) => {
      ctx.code = runDriftAccept(id, opts, ctx.io);
    });
}

interface DriftCommonOptions {
  root?: string;
  json?: boolean;
}

interface DriftAcceptOptions extends DriftCommonOptions {
  note?: string;
}

/** `anvil drift list` — every stored record as a small table. */
function runDriftList(opts: DriftCommonOptions, io: CliIO): number {
  const records = loadDriftRecords(opts.root ?? ".");
  if (opts.json === true) {
    io.out(JSON.stringify(records, null, 2));
    return 0;
  }
  if (records.length === 0) {
    io.out("No drift records. Detect drift with `anvil sync <spec> <dir|air.yaml>`.");
    return 0;
  }
  for (const r of records) {
    const counts = severityCounts(r);
    const summary = DRIFT_SEVERITY_ORDER.filter((s) => counts[s])
      .map((s) => `${counts[s]} ${s}`)
      .join(", ");
    const reviewed = r.reviewedAt ? "reviewed" : "UNREVIEWED";
    io.out(`  ${r.id.padEnd(28)} ${reviewed.padEnd(11)} ${summary.padEnd(30)} ${r.detectedAt}`);
  }
  return 0;
}

/** `anvil drift show <id>` — one record in full. */
function runDriftShow(id: string, opts: DriftCommonOptions, io: CliIO): number {
  const loaded = loadRecord(id, opts, io);
  if (typeof loaded === "number") return loaded;
  if (opts.json === true) io.out(JSON.stringify(loaded.record, null, 2));
  else io.out(renderDriftReport(loaded.record));
  return 0;
}

/**
 * `anvil drift accept <id>` — stamp the record reviewed (bookkeeping only).
 * Exported with an injectable clock so tests can pin reviewedAt.
 */
export function runDriftAccept(
  id: string,
  opts: DriftAcceptOptions,
  io: CliIO,
  deps: { now?: () => Date } = {},
): number {
  const loaded = loadRecord(id, opts, io);
  if (typeof loaded === "number") return loaded;
  const { record, path } = loaded;
  if (record.reviewedAt !== undefined) {
    // Re-accepting would silently rewrite who reviewed what, when. Refuse the
    // ambiguity; the record already says it was seen.
    io.out(`Drift '${record.id}' was already reviewed at ${record.reviewedAt}. Nothing to do.`);
    return 0;
  }
  const now = deps.now ?? (() => new Date());
  const reviewed: DriftRecord = {
    ...record,
    reviewedAt: now().toISOString(),
    reviewNote: opts.note,
  };
  writeFileSync(path, `${JSON.stringify(reviewed, null, 2)}\n`, "utf8");
  if (opts.json === true) {
    io.out(JSON.stringify(reviewed, null, 2));
    return 0;
  }
  io.out(`Marked drift '${record.id}' reviewed at ${reviewed.reviewedAt}.`);
  io.out("Bookkeeping only — AIR, snapshots, and certifications were not changed.");
  return 0;
}

/** Load one record by id, or print why not and return an exit code. */
function loadRecord(
  id: string,
  opts: DriftCommonOptions,
  io: CliIO,
): { record: DriftRecord; path: string } | number {
  const path = join(driftRoot(opts.root ?? "."), `${id}.json`);
  if (!existsSync(path)) {
    io.err(`No drift record '${id}'. Run \`anvil drift list\`.`);
    return 1;
  }
  const parsed = DriftRecord.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) {
    io.err(`Drift record '${id}' does not match the record schema.`);
    return 1;
  }
  return { record: parsed.data, path };
}
