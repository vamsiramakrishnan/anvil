import { hashCanonical } from "@anvil/air";
import { z } from "zod";
import {
  LegacyCapabilityCandidate,
  LegacyClaimDimension,
  LegacyClaimValue,
  LegacyIdentifier,
  LegacyRelativePath,
  LegacySha256,
} from "../core/model.js";

const text = (max = 2048) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value === value.trim(), "must not have surrounding whitespace")
    .refine(
      (value) =>
        [...value].every((character) => {
          const codePoint = character.codePointAt(0) ?? 0;
          return codePoint > 31 && codePoint !== 127;
        }),
      "must not contain control characters",
    );

const contentId = (prefix: string, core: object) => {
  const hex = hashCanonical(core);
  return { id: `${prefix}_${hex}`, hash: `sha256:${hex}` as const };
};

const LegacyCandidateHash = LegacySha256;
const LegacyTaskId = z.string().regex(/^lrt_[0-9a-f]{64}$/);
const LegacyProposalId = z.string().regex(/^lrp_[0-9a-f]{64}$/);
const LegacyReviewReceiptId = z.string().regex(/^lrr_[0-9a-f]{64}$/);
const LegacyBindingId = z.string().regex(/^lcb_[0-9a-f]{64}$/);

export const LegacyRefinementDecisionKind = z.enum([
  "conflict_resolution",
  "business_operation",
  "business_effect",
  "input_schema",
  "output_schema",
  "error_semantics",
  "transport_target",
  "interaction_pattern",
  "completion_semantics",
  "authorization",
  "idempotency",
  "retry_policy",
]);
export type LegacyRefinementDecisionKind = z.infer<typeof LegacyRefinementDecisionKind>;

export const LegacyRequiredDecision = z
  .object({
    kind: LegacyRefinementDecisionKind,
    dimension: LegacyClaimDimension.optional(),
    reason: text(),
  })
  .strict();
export type LegacyRequiredDecision = z.infer<typeof LegacyRequiredDecision>;

const LegacyRefinementPolicy = z
  .object({
    humanApprovalRequired: z.literal(true),
    runtimeExecutionAllowed: z.literal(false),
    brokerAcknowledgementIsBusinessCompletion: z.literal(false),
    genericMiddlewareToolsForbidden: z.literal(true),
  })
  .strict();

const LegacyRefinementTaskCore = z
  .object({
    schemaVersion: z.literal(1),
    inventoryId: z.string().regex(/^li_[0-9a-f]{64}$/),
    inventoryContentHash: LegacySha256,
    candidateId: z.string().regex(/^lc_[0-9a-f]{64}$/),
    candidateHash: LegacyCandidateHash,
    candidate: LegacyCapabilityCandidate,
    requiredDecisions: z.array(LegacyRequiredDecision).min(1).max(64),
    policy: LegacyRefinementPolicy,
  })
  .strict();

export const LegacyRefinementTask = LegacyRefinementTaskCore.extend({
  taskId: LegacyTaskId,
  taskHash: LegacySha256,
})
  .strict()
  .superRefine((record, ctx) => {
    const { taskId: _taskId, taskHash: _taskHash, ...core } = record;
    const expected = contentId("lrt", core);
    if (record.taskId !== expected.id) {
      ctx.addIssue({ code: "custom", path: ["taskId"], message: "must match task content" });
    }
    if (record.taskHash !== expected.hash) {
      ctx.addIssue({ code: "custom", path: ["taskHash"], message: "must match task content" });
    }
    if (record.candidateId !== record.candidate.candidateId) {
      ctx.addIssue({
        code: "custom",
        path: ["candidateId"],
        message: "must match the embedded candidate",
      });
    }
    const expectedCandidateHash = `sha256:${hashCanonical(record.candidate)}`;
    if (record.candidateHash !== expectedCandidateHash) {
      ctx.addIssue({
        code: "custom",
        path: ["candidateHash"],
        message: "must match the embedded candidate",
      });
    }
  });
export type LegacyRefinementTask = z.infer<typeof LegacyRefinementTask>;

export function finalizeLegacyRefinementTask(
  input: z.input<typeof LegacyRefinementTaskCore>,
): LegacyRefinementTask {
  const core = LegacyRefinementTaskCore.parse(input);
  const address = contentId("lrt", core);
  return LegacyRefinementTask.parse({ ...core, taskId: address.id, taskHash: address.hash });
}

const EvidenceRefId = LegacyIdentifier;

export const LegacyRefinementEvidenceReference = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("inventory"),
      refId: EvidenceRefId,
      evidenceId: z.string().regex(/^le_[0-9a-f]{64}$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal("repository"),
      refId: EvidenceRefId,
      repository: text(512),
      revision: text(512),
      path: LegacyRelativePath,
      startLine: z.number().int().positive(),
      endLine: z.number().int().positive(),
      blobDigest: LegacySha256,
      excerptDigest: LegacySha256,
    })
    .strict()
    .refine((value) => value.endLine >= value.startLine, {
      path: ["endLine"],
      message: "must be at or after startLine",
    }),
  z
    .object({
      kind: z.literal("document"),
      refId: EvidenceRefId,
      systemId: LegacyIdentifier,
      revision: text(512).optional(),
      coordinate: text(2048),
      contentDigest: LegacySha256,
    })
    .strict(),
  z
    .object({
      kind: z.literal("operator_attestation"),
      refId: EvidenceRefId,
      attestationId: LegacyIdentifier,
      attestor: text(512),
      statementDigest: LegacySha256,
    })
    .strict(),
]);
export type LegacyRefinementEvidenceReference = z.infer<typeof LegacyRefinementEvidenceReference>;

export const LegacyClaimEvidence = z
  .object({
    claim: LegacyRefinementDecisionKind,
    evidenceRefIds: z.array(EvidenceRefId).min(1).max(64),
  })
  .strict();
export type LegacyClaimEvidence = z.infer<typeof LegacyClaimEvidence>;

export const LegacyConflictResolution = z
  .object({
    dimension: LegacyClaimDimension,
    selectedValue: LegacyClaimValue,
    evidenceRefIds: z.array(EvidenceRefId).min(1).max(64),
    reason: text(),
  })
  .strict();
export type LegacyConflictResolution = z.infer<typeof LegacyConflictResolution>;

function inspectJson(
  value: unknown,
  ctx: z.RefinementCtx,
  path: PropertyKey[],
  depth: number,
  count: { value: number },
): void {
  count.value += 1;
  if (count.value > 10_000) {
    ctx.addIssue({ code: "custom", path, message: "JSON value exceeds 10,000 nodes" });
    return;
  }
  if (depth > 16) {
    ctx.addIssue({ code: "custom", path, message: "JSON value exceeds 16 levels" });
    return;
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) ctx.addIssue({ code: "custom", path, message: "must be finite" });
    return;
  }
  if (typeof value === "string") {
    if (value.length > 65_536) {
      ctx.addIssue({ code: "custom", path, message: "string exceeds 65,536 characters" });
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 1_000) {
      ctx.addIssue({ code: "custom", path, message: "array exceeds 1,000 items" });
      return;
    }
    value.forEach((item, index) => {
      inspectJson(item, ctx, [...path, index], depth + 1, count);
    });
    return;
  }
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    ctx.addIssue({ code: "custom", path, message: "must contain plain JSON values only" });
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (
      key.length === 0 ||
      key.length > 256 ||
      ["__proto__", "prototype", "constructor"].includes(key)
    ) {
      ctx.addIssue({ code: "custom", path: [...path, key], message: "unsafe JSON key" });
      continue;
    }
    inspectJson(item, ctx, [...path, key], depth + 1, count);
  }
}

export const LegacyJsonSchema = z
  .record(z.string(), z.unknown())
  .superRefine((value, ctx) => inspectJson(value, ctx, [], 0, { value: 0 }));
export type LegacyJsonSchema = z.infer<typeof LegacyJsonSchema>;

const LegacyErrorMapping = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
    meaning: text(),
    retryable: z.boolean(),
    recovery: text(),
  })
  .strict();

const LegacyPagination = z
  .object({
    mode: z.enum(["cursor", "offset", "page"]),
    requestField: text(256),
    responseItemsPath: text(1024),
    responseCursorPath: text(1024).optional(),
    maxPageSize: z.number().int().positive().max(100_000).optional(),
  })
  .strict();

export const LegacyBusinessOperation = z
  .object({
    name: z
      .string()
      .min(3)
      .max(128)
      .regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/),
    summary: text(256),
    description: text(2048),
    effect: z.enum(["read", "create", "update", "delete", "trigger", "event"]),
    exposure: z.enum(["mcp_tool", "event_trigger", "internal"]),
    inputSchema: LegacyJsonSchema,
    outputSchema: LegacyJsonSchema,
    errors: z.array(LegacyErrorMapping).max(128),
    pagination: LegacyPagination.optional(),
  })
  .strict();
export type LegacyBusinessOperation = z.infer<typeof LegacyBusinessOperation>;

const MessageTransport = z
  .object({
    kind: z.literal("message"),
    protocol: z.enum(["jms", "ibm_mq", "amqp", "kafka", "artemis", "msmq", "other"]),
    target: text(2048),
    direction: z.enum(["produce", "consume", "request_reply", "publish", "subscribe"]),
    payloadEncoding: z.enum(["json", "xml", "text", "binary", "vendor"]),
    reply: z
      .object({
        mode: z.enum(["none", "reply_to", "fixed_destination", "poll_status"]),
        target: text(2048).optional(),
        correlationField: text(512).optional(),
      })
      .strict(),
  })
  .strict();

const RemoteMethodTransport = z
  .object({
    kind: z.literal("remote_method"),
    protocol: z.enum(["ejb_rmi", "wcf", "rmi", "com_plus", "other"]),
    target: text(2048),
    interface: text(512),
    method: text(512),
    serialization: z.enum(["soap", "data_contract", "java_serialization", "json", "vendor"]),
  })
  .strict();

export const LegacyTransportPlan = z.discriminatedUnion("kind", [
  MessageTransport,
  RemoteMethodTransport,
  z
    .object({
      kind: z.literal("resource_adapter"),
      target: text(2048),
      adapterRef: text(512),
      connectionFactoryRef: text(512),
      interactionSpec: text(512).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("stored_procedure"),
      target: text(2048),
      databaseRef: text(512),
      procedure: text(512),
    })
    .strict(),
  z
    .object({
      kind: z.literal("batch_job"),
      target: text(2048),
      schedulerRef: text(512),
      job: text(512),
    })
    .strict(),
]);
export type LegacyTransportPlan = z.infer<typeof LegacyTransportPlan>;

export const LegacyOperationalSemantics = z
  .object({
    completion: z.enum([
      "unknown",
      "transport_accepted",
      "application_accepted",
      "business_completed",
      "job_accepted",
    ]),
    timeoutMs: z.number().int().positive().max(3_600_000),
    authorization: z
      .object({
        mode: z.enum(["unknown", "bridge_identity", "delegated_user", "service_account"]),
        scopes: z.array(text(256)).max(64),
      })
      .strict(),
    idempotency: z
      .object({
        mode: z.enum(["unknown", "none", "natural", "client_key"]),
        carrier: text(512).optional(),
      })
      .strict(),
    retry: z
      .object({
        mode: z.enum(["never", "safe_transient", "operator_only"]),
        maxAttempts: z.number().int().min(1).max(10),
      })
      .strict(),
  })
  .strict();
export type LegacyOperationalSemantics = z.infer<typeof LegacyOperationalSemantics>;

const Executor = z.object({ name: text(256), model: text(256).optional() }).strict();

export const LegacyRefinementSubmission = z.discriminatedUnion("status", [
  z
    .object({
      schemaVersion: z.literal(1),
      taskId: LegacyTaskId,
      taskHash: LegacySha256,
      status: z.literal("proposal_generated"),
      executor: Executor,
      summary: text(),
      evidence: z.array(LegacyRefinementEvidenceReference).min(1).max(256),
      claimEvidence: z.array(LegacyClaimEvidence).min(1).max(64),
      resolutions: z.array(LegacyConflictResolution).max(64),
      operation: LegacyBusinessOperation,
      transport: LegacyTransportPlan,
      semantics: LegacyOperationalSemantics,
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      taskId: LegacyTaskId,
      taskHash: LegacySha256,
      status: z.literal("declined"),
      executor: Executor,
      reason: z.enum([
        "insufficient_evidence",
        "conflicted",
        "unsupported_transport",
        "blocked_by_missing_source",
      ]),
      summary: text(),
    })
    .strict(),
]);
export type LegacyRefinementSubmission = z.infer<typeof LegacyRefinementSubmission>;

const LegacyRefinementProposalCore = z
  .object({
    schemaVersion: z.literal(1),
    inventoryId: z.string().regex(/^li_[0-9a-f]{64}$/),
    candidateId: z.string().regex(/^lc_[0-9a-f]{64}$/),
    candidateHash: LegacyCandidateHash,
    taskId: LegacyTaskId,
    taskHash: LegacySha256,
    submission: LegacyRefinementSubmission,
  })
  .strict();

export const LegacyRefinementProposal = LegacyRefinementProposalCore.extend({
  proposalId: LegacyProposalId,
  proposalHash: LegacySha256,
})
  .strict()
  .superRefine((record, ctx) => {
    const { proposalId: _proposalId, proposalHash: _proposalHash, ...core } = record;
    const expected = contentId("lrp", core);
    if (record.proposalId !== expected.id) {
      ctx.addIssue({
        code: "custom",
        path: ["proposalId"],
        message: "must match proposal content",
      });
    }
    if (record.proposalHash !== expected.hash) {
      ctx.addIssue({
        code: "custom",
        path: ["proposalHash"],
        message: "must match proposal content",
      });
    }
    if (
      record.submission.taskId !== record.taskId ||
      record.submission.taskHash !== record.taskHash
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["submission"],
        message: "must be bound to the proposal task",
      });
    }
  });
export type LegacyRefinementProposal = z.infer<typeof LegacyRefinementProposal>;

export function finalizeLegacyRefinementProposal(
  input: z.input<typeof LegacyRefinementProposalCore>,
): LegacyRefinementProposal {
  const core = LegacyRefinementProposalCore.parse(input);
  const address = contentId("lrp", core);
  return LegacyRefinementProposal.parse({
    ...core,
    proposalId: address.id,
    proposalHash: address.hash,
  });
}

const LegacyReviewReceiptCore = z
  .object({
    schemaVersion: z.literal(1),
    inventoryId: z.string().regex(/^li_[0-9a-f]{64}$/),
    inventoryContentHash: LegacySha256,
    candidateId: z.string().regex(/^lc_[0-9a-f]{64}$/),
    candidateHash: LegacyCandidateHash,
    taskId: LegacyTaskId,
    taskHash: LegacySha256,
    proposalId: LegacyProposalId,
    proposalHash: LegacySha256,
    decision: z.enum(["approved", "rejected"]),
    reviewer: text(512),
    reason: text(4096),
  })
  .strict();

export const LegacyReviewReceipt = LegacyReviewReceiptCore.extend({
  receiptId: LegacyReviewReceiptId,
  receiptHash: LegacySha256,
})
  .strict()
  .superRefine((record, ctx) => {
    const { receiptId: _receiptId, receiptHash: _receiptHash, ...core } = record;
    const expected = contentId("lrr", core);
    if (record.receiptId !== expected.id) {
      ctx.addIssue({ code: "custom", path: ["receiptId"], message: "must match receipt content" });
    }
    if (record.receiptHash !== expected.hash) {
      ctx.addIssue({
        code: "custom",
        path: ["receiptHash"],
        message: "must match receipt content",
      });
    }
  });
export type LegacyReviewReceipt = z.infer<typeof LegacyReviewReceipt>;

export function finalizeLegacyReviewReceipt(
  input: z.input<typeof LegacyReviewReceiptCore>,
): LegacyReviewReceipt {
  const core = LegacyReviewReceiptCore.parse(input);
  const address = contentId("lrr", core);
  return LegacyReviewReceipt.parse({ ...core, receiptId: address.id, receiptHash: address.hash });
}

const LegacyCapabilityBindingCore = z
  .object({
    schemaVersion: z.literal(1),
    inventoryId: z.string().regex(/^li_[0-9a-f]{64}$/),
    inventoryContentHash: LegacySha256,
    candidateId: z.string().regex(/^lc_[0-9a-f]{64}$/),
    candidateHash: LegacyCandidateHash,
    taskId: LegacyTaskId,
    taskHash: LegacySha256,
    proposalId: LegacyProposalId,
    proposalHash: LegacySha256,
    receiptId: LegacyReviewReceiptId,
    receiptHash: LegacySha256,
    operation: LegacyBusinessOperation,
    transport: LegacyTransportPlan,
    semantics: LegacyOperationalSemantics,
    runtime: z
      .object({
        placement: z.literal("deployment_local_bridge"),
        status: z.literal("not_implemented"),
      })
      .strict(),
  })
  .strict();

export const LegacyCapabilityBinding = LegacyCapabilityBindingCore.extend({
  bindingId: LegacyBindingId,
  contentHash: LegacySha256,
})
  .strict()
  .superRefine((record, ctx) => {
    const { bindingId: _bindingId, contentHash: _contentHash, ...core } = record;
    const expected = contentId("lcb", core);
    if (record.bindingId !== expected.id) {
      ctx.addIssue({ code: "custom", path: ["bindingId"], message: "must match binding content" });
    }
    if (record.contentHash !== expected.hash) {
      ctx.addIssue({
        code: "custom",
        path: ["contentHash"],
        message: "must match binding content",
      });
    }
  });
export type LegacyCapabilityBinding = z.infer<typeof LegacyCapabilityBinding>;

export function finalizeLegacyCapabilityBindingRecord(
  input: z.input<typeof LegacyCapabilityBindingCore>,
): LegacyCapabilityBinding {
  const core = LegacyCapabilityBindingCore.parse(input);
  const address = contentId("lcb", core);
  return LegacyCapabilityBinding.parse({
    ...core,
    bindingId: address.id,
    contentHash: address.hash,
  });
}
