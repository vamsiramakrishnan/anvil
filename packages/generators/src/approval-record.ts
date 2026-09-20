import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

/**
 * The approval record: an append-only log of every decision that changed a
 * bundle's approval state, kept at `<bundle>/.anvil/approvals.jsonl`. One JSON
 * object per line, never rewritten — a line is added by the same atomic
 * reprojection that installs the decision, so a record without a matching
 * generation and a generation without a record cannot both exist.
 *
 * The log lives under `.anvil/`, which `readBundleDir` excludes from the
 * bundle's bytes: the record describes the bundle's history and must not
 * join the hash it records (`bundleHash.after` would otherwise be the hash
 * of a bundle that did not yet contain the line naming it).
 *
 * `reviewer` is never invented. A surface that has an identity passes it; one
 * that has none records `"unrecorded"` explicitly, so a reader cannot mistake
 * an absent field for an anonymous-by-design decision. An empty or whitespace
 * reviewer is refused rather than coerced to either.
 */

export const APPROVAL_RECORD_FILE = ".anvil/approvals.jsonl";
export const UNRECORDED_REVIEWER = "unrecorded";

export const ApprovalRecordSubject = z.object({
  kind: z.enum(["operation", "capability", "generation"]),
  id: z.string().min(1),
  /** Prior state (an operation state, a capability lifecycle, or a bundle hash). */
  from: z.string(),
  /** New state. */
  to: z.string(),
});
export type ApprovalRecordSubject = z.infer<typeof ApprovalRecordSubject>;

export const ApprovalRecordAction = z.enum([
  "approve_operations",
  "approve_capability",
  "reject_capability",
  "reproject",
  "rollback",
]);
export type ApprovalRecordAction = z.infer<typeof ApprovalRecordAction>;

export const ApprovalRecord = z.object({
  schemaVersion: z.literal(1),
  recordedAt: z.string().refine((value) => !Number.isNaN(Date.parse(value)), "ISO timestamp"),
  reviewer: z.string().min(1),
  action: ApprovalRecordAction,
  subjects: z.array(ApprovalRecordSubject),
  bundleHash: z.object({
    before: z.string().regex(/^[0-9a-f]{64}$/),
    after: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  note: z.string().optional(),
});
export type ApprovalRecord = z.infer<typeof ApprovalRecord>;

/** What a caller knows about the decision; the reprojection fills in time and hashes. */
export interface ApprovalRecordInput {
  action: ApprovalRecordAction;
  subjects: ApprovalRecordSubject[];
  reviewer?: string;
  note?: string;
}

/**
 * Normalize a reviewer identity: absent means `"unrecorded"`, present must be
 * non-empty. A blank identity is a request nobody made, so it is refused.
 */
export function normalizeReviewer(reviewer: string | undefined): string {
  if (reviewer === undefined) return UNRECORDED_REVIEWER;
  const trimmed = reviewer.trim();
  if (trimmed.length === 0) {
    throw new Error("A reviewer identity, when given, must not be empty.");
  }
  return trimmed;
}

export interface ApprovalRecordContext {
  bundleHash: { before: string; after: string };
  now?: () => Date;
}

export function buildApprovalRecord(
  input: ApprovalRecordInput,
  context: ApprovalRecordContext,
): ApprovalRecord {
  const note = input.note?.trim();
  return ApprovalRecord.parse({
    schemaVersion: 1,
    recordedAt: (context.now ?? (() => new Date()))().toISOString(),
    reviewer: normalizeReviewer(input.reviewer),
    action: input.action,
    subjects: input.subjects,
    bundleHash: context.bundleHash,
    ...(note ? { note } : {}),
  });
}

/** Append one record; returns the log's path. Creates `.anvil/` on first use. */
export function appendApprovalRecord(bundleDir: string, record: ApprovalRecord): string {
  const path = join(bundleDir, APPROVAL_RECORD_FILE);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(ApprovalRecord.parse(record))}\n`, "utf8");
  return path;
}

/** Every record in the log, oldest first. A malformed line is an error, not a skipped entry. */
export function readApprovalRecords(bundleDir: string): ApprovalRecord[] {
  const path = join(bundleDir, APPROVAL_RECORD_FILE);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n");
  const records: ApprovalRecord[] = [];
  lines.forEach((line, index) => {
    if (line.trim().length === 0) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (error) {
      throw new Error(
        `${APPROVAL_RECORD_FILE}:${index + 1} is not valid JSON: ${(error as Error).message}`,
      );
    }
    const parsed = ApprovalRecord.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `${APPROVAL_RECORD_FILE}:${index + 1} is not an approval record: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
          .join("; ")}`,
      );
    }
    records.push(parsed.data);
  });
  return records;
}

/** One line for `anvil inspect`: how many decisions the log holds and who made the last. */
export function summarizeApprovalRecords(records: readonly ApprovalRecord[]): string {
  if (records.length === 0) return "approval record: none (no decision has been recorded)";
  const last = records[records.length - 1] as ApprovalRecord;
  const decided = last.subjects.filter((subject) => subject.kind !== "generation");
  const what =
    decided.length > 0
      ? `${decided.length} ${decided[0]?.kind}(s)`
      : last.action === "rollback"
        ? "a prior generation"
        : "the projections";
  return `approval record: ${records.length} decision(s); last ${last.action} of ${what} by ${last.reviewer} at ${last.recordedAt}`;
}
