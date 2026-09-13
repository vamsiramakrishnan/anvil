import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { BusinessJournalEvent, type BusinessJournalRecord, hashCanonical } from "@anvil/air";

export { BusinessJournalEvent, BusinessJournalRecord } from "@anvil/air";
export interface BusinessJournal {
  /** Must durably persist before resolving. Store receipt digests, never credentials or raw vendor payloads. */
  append(
    trace: string,
    event: BusinessJournalEvent,
    expectedDigest?: string | null,
  ): Promise<BusinessJournalRecord>;
  read(trace: string): Promise<BusinessJournalRecord[]>;
}
/** Local single-host journal. Mount a persistent volume for retention; distributed hosts supply a shared implementation. */
export class FileBusinessJournal implements BusinessJournal {
  readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
    this.assertPath(this.root);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }
  private assertPath(path: string) {
    let current: string = sep;
    for (const part of resolve(path).split(sep).filter(Boolean)) {
      current = join(current, part);
      try {
        if (lstatSync(current).isSymbolicLink())
          throw new Error("Journal paths cannot contain symlinks.");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
  }
  private dir(trace: string) {
    if (!/^[a-f0-9-]{36}$/.test(trace)) throw new Error("Invalid execution trace.");
    const dir = join(this.root, trace);
    this.assertPath(dir);
    return dir;
  }
  async read(trace: string): Promise<BusinessJournalRecord[]> {
    const dir = this.dir(trace);
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir)
      .filter((n) => /^\d{4}\.json$/.test(n))
      .sort();
    const records: BusinessJournalRecord[] = [];
    for (const file of files) {
      const path = join(dir, file);
      this.assertPath(path);
      const record = JSON.parse(readFileSync(path, "utf8")) as BusinessJournalRecord;
      const { digest, ...body } = record;
      BusinessJournalEvent.parse(record.event);
      if (
        record.sequence !== records.length ||
        record.previous !== (records.at(-1)?.digest ?? null) ||
        hashCanonical(body) !== digest
      )
        throw new Error("Execution journal integrity check failed.");
      records.push(record);
    }
    return records;
  }
  async append(
    trace: string,
    raw: BusinessJournalEvent,
    expectedDigest?: string | null,
  ): Promise<BusinessJournalRecord> {
    const event = BusinessJournalEvent.parse(raw),
      dir = this.dir(trace);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Persist a newly created trace directory before acknowledging any of its records.
    const parent = openSync(this.root, "r");
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
    const lock = join(dir, "write.lock");
    mkdirSync(lock);
    try {
      const records = await this.read(trace),
        previous = records.at(-1)?.digest ?? null;
      if (expectedDigest !== undefined && expectedDigest !== previous)
        throw new Error("Execution changed. Inspect the latest journal before reconciling.");
      if (records.length >= 1000) throw new Error("Execution journal limit reached.");
      const body = { sequence: records.length, previous, at: new Date().toISOString(), event };
      const record = { ...body, digest: hashCanonical(body) };
      const fd = openSync(join(dir, `${String(body.sequence).padStart(4, "0")}.json`), "wx", 0o600);
      try {
        writeFileSync(fd, `${JSON.stringify(record)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      // Persist the directory entry as well as the record bytes on local filesystems.
      const directory = openSync(dir, "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
      return record;
    } finally {
      rmSync(lock, { recursive: true });
    }
  }
}
export type ReconciliationEvidence = Extract<
  BusinessJournalEvent,
  { kind: "reconciled" }
>["evidence"][number];
/** A trusted broker verifies backend receipts. User/model claims alone are never reconciliation evidence. */
export async function reconcileBusinessExecution(options: {
  journal: BusinessJournal;
  trace: string;
  expectedDigest: string;
  reviewer: string;
  note: string;
  verify(record: Readonly<BusinessJournalRecord[]>): Promise<ReconciliationEvidence[]>;
}): Promise<BusinessJournalRecord> {
  const records = await options.journal.read(options.trace);
  if (records.at(-1)?.digest !== options.expectedDigest)
    throw new Error("Execution changed. Inspect the latest journal.");
  if (!records.some((r) => r.event.kind === "finished"))
    throw new Error(
      "Execution is running or crashed before recording its outcome; fence the original worker before reconciliation.",
    );
  const attempts = records.flatMap((r) =>
    r.event.kind === "attempted" && r.event.mutation ? [r.event.step] : [],
  );
  const evidence = await options.verify(structuredClone(records));
  if (
    new Set(evidence.map((e) => e.step)).size !== evidence.length ||
    attempts.some((step) => !evidence.some((e) => e.step === step)) ||
    evidence.some((e) => !attempts.includes(e.step))
  )
    throw new Error(
      "Supply authoritative evidence for every attempted mutation, with no unrelated steps.",
    );
  return options.journal.append(
    options.trace,
    { kind: "reconciled", reviewer: options.reviewer, note: options.note, evidence },
    options.expectedDigest,
  );
}
