import { z } from "zod";

/**
 * The approval record's shape: an append-only log of every decision that
 * changed a bundle's approval state, one JSON object per line at
 * `<bundle>/.anvil/approvals.jsonl`.
 *
 * The SHAPE lives here, in AIR, and the reading and writing live in
 * `@anvil/generators` beside the reprojection that appends a line. The split
 * is what lets the review console — a browser bundle — validate a record it
 * displays without importing a package that reaches `node:fs` and
 * `node:async_hooks`, which do not exist in a browser.
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
