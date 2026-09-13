import { z } from "zod";

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const BusinessJournalEvent = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("started"),
    planDigest: Digest,
    requestDigest: Digest,
    project: z.string(),
    action: z.string(),
    tenantDigest: Digest,
    principalDigest: Digest,
  }),
  z.strictObject({
    kind: z.literal("attempted"),
    step: z.string(),
    source: z.string(),
    operation: z.string(),
    mutation: z.boolean(),
    inputDigest: Digest,
    keyDigest: Digest.optional(),
    effect: z.string().optional(),
  }),
  z.strictObject({ kind: z.literal("received"), step: z.string(), outputDigest: Digest }),
  z.strictObject({
    kind: z.literal("finished"),
    status: z.enum([
      "completed",
      "rejected",
      "partial",
      "reconciliation_required",
      "approval_required",
    ]),
    completedEffects: z.array(z.string()),
  }),
  z.strictObject({
    kind: z.literal("reconciled"),
    reviewer: z.string().min(1),
    note: z.string().min(1),
    evidence: z
      .array(
        z.strictObject({
          step: z.string(),
          authority: z.string().min(1),
          observation: z.enum(["committed", "not_committed", "unknown"]),
          receiptDigest: Digest,
          observedAt: z.string().datetime(),
        }),
      )
      .min(1),
  }),
]);
export type BusinessJournalEvent = z.infer<typeof BusinessJournalEvent>;
export const BusinessJournalRecord = z.strictObject({
  sequence: z.number().int().min(0),
  previous: Digest.nullable(),
  digest: Digest,
  at: z.string().datetime(),
  event: BusinessJournalEvent,
});
export type BusinessJournalRecord = z.infer<typeof BusinessJournalRecord>;
