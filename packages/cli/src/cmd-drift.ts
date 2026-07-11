import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DRIFT_SEVERITY_ORDER, DriftRecord } from "@anvil/compiler";
import { driftRoot, loadDriftRecords, renderDriftReport, severityCounts } from "./cmd-sync.js";
import type { CliIO } from "./io.js";

/**
 * `anvil drift <subcommand>` — review the drift records `anvil sync` stored
 * under `.anvil/drift/`. `list` and `show` are read-only; `accept` is
 * bookkeeping only — it stamps reviewedAt (plus an optional note) on the
 * record and nothing else. Accepting drift never edits AIR, never re-earns a
 * certification, and never touches capability lifecycles: those decisions go
 * through `anvil compile` / `anvil certify` / `anvil capability` deliberately.
 */
export function cmdDrift(
  args: string[],
  flags: Record<string, string | boolean>,
  io: CliIO,
  deps: { now?: () => Date } = {},
): number {
  const sub = args[0];
  switch (sub) {
    case "list":
      return cmdDriftList(flags, io);
    case "show":
      return cmdDriftShow(args.slice(1), flags, io);
    case "accept":
      return cmdDriftAccept(args.slice(1), flags, io, deps.now ?? (() => new Date()));
    default:
      if (sub && sub !== "help") io.err(`Unknown drift subcommand: '${sub}'.`);
      io.err("Usage: anvil drift list          [--json]");
      io.err("       anvil drift show   <id>   [--json]");
      io.err("       anvil drift accept <id>   [--note ..] [--json]");
      io.err("Records live under .anvil/drift/ (--root <dir> to relocate).");
      return sub && sub !== "help" ? 1 : 0;
  }
}

function root(flags: Record<string, string | boolean>): string {
  return typeof flags.root === "string" ? flags.root : ".";
}

/** `anvil drift list` — every stored record as a small table. */
function cmdDriftList(flags: Record<string, string | boolean>, io: CliIO): number {
  const records = loadDriftRecords(root(flags));
  if (flags.json === true) {
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
function cmdDriftShow(args: string[], flags: Record<string, string | boolean>, io: CliIO): number {
  const loaded = loadRecord(args[0], flags, io);
  if (typeof loaded === "number") return loaded;
  if (flags.json === true) io.out(JSON.stringify(loaded.record, null, 2));
  else io.out(renderDriftReport(loaded.record));
  return 0;
}

/** `anvil drift accept <id>` — stamp the record reviewed (bookkeeping only). */
function cmdDriftAccept(
  args: string[],
  flags: Record<string, string | boolean>,
  io: CliIO,
  now: () => Date,
): number {
  const loaded = loadRecord(args[0], flags, io);
  if (typeof loaded === "number") return loaded;
  const { record, path } = loaded;
  if (record.reviewedAt !== undefined) {
    // Re-accepting would silently rewrite who reviewed what, when. Refuse the
    // ambiguity; the record already says it was seen.
    io.out(`Drift '${record.id}' was already reviewed at ${record.reviewedAt}. Nothing to do.`);
    return 0;
  }
  const reviewed: DriftRecord = {
    ...record,
    reviewedAt: now().toISOString(),
    reviewNote: typeof flags.note === "string" ? flags.note : undefined,
  };
  writeFileSync(path, `${JSON.stringify(reviewed, null, 2)}\n`, "utf8");
  if (flags.json === true) {
    io.out(JSON.stringify(reviewed, null, 2));
    return 0;
  }
  io.out(`Marked drift '${record.id}' reviewed at ${reviewed.reviewedAt}.`);
  io.out("Bookkeeping only — AIR, snapshots, and certifications were not changed.");
  return 0;
}

/** Load one record by id, or print why not and return an exit code. */
function loadRecord(
  id: string | undefined,
  flags: Record<string, string | boolean>,
  io: CliIO,
): { record: DriftRecord; path: string } | number {
  if (!id) {
    io.err("Usage: anvil drift <show|accept> <id> [--json]");
    return 1;
  }
  const path = join(driftRoot(root(flags)), `${id}.json`);
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
