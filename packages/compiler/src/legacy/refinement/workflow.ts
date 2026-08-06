import { hashCanonical } from "@anvil/air";
import { z } from "zod";
import { verifyLegacyInventory } from "../core/inventory.js";
import type {
  LegacyCapabilityCandidate,
  LegacyClaimAssertion,
  LegacyClaimDimension,
  LegacyClaimValue,
  LegacyInventorySnapshot,
} from "../core/model.js";
import { reconcileLegacyInventory } from "../core/reconcile.js";
import {
  finalizeLegacyCapabilityBindingRecord,
  finalizeLegacyRefinementProposal,
  finalizeLegacyRefinementTask,
  finalizeLegacyReviewReceipt,
  LegacyCapabilityBinding,
  type LegacyCapabilityBinding as LegacyCapabilityBindingType,
  LegacyRefinementProposal,
  type LegacyRefinementProposal as LegacyRefinementProposalType,
  LegacyRefinementSubmission,
  type LegacyRefinementSubmission as LegacyRefinementSubmissionType,
  LegacyRefinementTask,
  type LegacyRefinementTask as LegacyRefinementTaskType,
  LegacyReviewReceipt,
  type LegacyReviewReceipt as LegacyReviewReceiptType,
} from "./model.js";

export const LegacyRefinementIssue = z
  .object({
    code: z
      .string()
      .min(1)
      .max(128)
      .regex(/^legacy\/refinement\/[a-z0-9_/-]+$/),
    path: z.string().min(1).max(1024),
    message: z.string().min(1).max(4096),
  })
  .strict();
export type LegacyRefinementIssue = z.infer<typeof LegacyRefinementIssue>;

export const LegacyRefinementAssessment = z
  .object({
    schemaVersion: z.literal(1),
    inventoryId: z.string().regex(/^li_[0-9a-f]{64}$/),
    taskId: z.string().regex(/^lrt_[0-9a-f]{64}$/),
    proposalId: z.string().regex(/^lrp_[0-9a-f]{64}$/),
    ok: z.boolean(),
    issues: z.array(LegacyRefinementIssue).max(512),
  })
  .strict();
export type LegacyRefinementAssessment = z.infer<typeof LegacyRefinementAssessment>;

const DECISION_REASONS: ReadonlyArray<{
  kind:
    | "business_operation"
    | "business_effect"
    | "input_schema"
    | "output_schema"
    | "error_semantics"
    | "transport_target"
    | "interaction_pattern"
    | "completion_semantics"
    | "authorization"
    | "idempotency"
    | "retry_policy";
  reason: string;
}> = [
  {
    kind: "business_operation",
    reason:
      "Choose a stable, business-shaped operation name rather than exposing middleware verbs.",
  },
  {
    kind: "business_effect",
    reason:
      "State the business effect; a technical invocation does not prove what work it performs.",
  },
  {
    kind: "input_schema",
    reason:
      "Define clear agent-facing inputs and preserve any distinct wire mapping outside the tool schema.",
  },
  {
    kind: "output_schema",
    reason: "Define business output and omit UI-only button or screen state.",
  },
  {
    kind: "error_semantics",
    reason: "Map failures to stable codes, retryability, and actionable recovery guidance.",
  },
  {
    kind: "transport_target",
    reason:
      "Select the exact reviewed queue, topic, JNDI name, endpoint, procedure, or job target.",
  },
  {
    kind: "interaction_pattern",
    reason:
      "Declare whether the bridge sends, receives, requests a reply, publishes, or handles an event.",
  },
  {
    kind: "completion_semantics",
    reason:
      "Distinguish transport acknowledgement, application acceptance, and completed business work.",
  },
  {
    kind: "authorization",
    reason:
      "Define which deployment identity or delegated user is authorized to perform the operation.",
  },
  {
    kind: "idempotency",
    reason:
      "Record whether duplicate execution is safe and how a client key is carried when required.",
  },
  {
    kind: "retry_policy",
    reason:
      "Permit automatic retry only when the reviewed idempotency and failure semantics make it safe.",
  },
];

/** Build one deterministic harness task from a verified inventory candidate. */
export function createLegacyRefinementTask(
  inventoryInput: LegacyInventorySnapshot,
  candidateId: string,
): LegacyRefinementTaskType {
  const inventory = verifyLegacyInventory(inventoryInput);
  const candidate = reconcileLegacyInventory(inventory).find(
    (item) => item.candidateId === candidateId,
  );
  if (!candidate) throw new Error(`legacy candidate '${candidateId}' is not in this inventory`);

  return finalizeLegacyRefinementTask({
    schemaVersion: 1,
    inventoryId: inventory.inventoryId,
    inventoryContentHash: inventory.contentHash,
    candidateId: candidate.candidateId,
    candidateHash: sha256(candidate),
    candidate,
    requiredDecisions: [
      ...candidate.conflicts.map((conflict) => ({
        kind: "conflict_resolution" as const,
        dimension: conflict.dimension,
        reason: `Select one evidence-backed ${conflict.dimension} assertion; evidence rank does not choose it automatically.`,
      })),
      ...DECISION_REASONS,
    ],
    policy: {
      humanApprovalRequired: true,
      runtimeExecutionAllowed: false,
      brokerAcknowledgementIsBusinessCompletion: false,
      genericMiddlewareToolsForbidden: true,
    },
  });
}

/** Bind an untrusted harness submission to the exact task without approving it. */
export function createLegacyRefinementProposal(
  taskInput: LegacyRefinementTaskType,
  submissionInput: LegacyRefinementSubmissionType,
): LegacyRefinementProposalType {
  const task = LegacyRefinementTask.parse(taskInput);
  const submission = LegacyRefinementSubmission.parse(submissionInput);
  if (submission.taskId !== task.taskId || submission.taskHash !== task.taskHash) {
    throw new Error("legacy refinement submission is bound to a different task");
  }
  return finalizeLegacyRefinementProposal({
    schemaVersion: 1,
    inventoryId: task.inventoryId,
    candidateId: task.candidateId,
    candidateHash: task.candidateHash,
    taskId: task.taskId,
    taskHash: task.taskHash,
    submission,
  });
}

/** Assess completeness for human review without granting approval. */
export function assessLegacyRefinementProposal(
  inventoryInput: LegacyInventorySnapshot,
  taskInput: LegacyRefinementTaskType,
  proposalInput: LegacyRefinementProposalType,
): LegacyRefinementAssessment {
  const inventory = verifyLegacyInventory(inventoryInput);
  const task = LegacyRefinementTask.parse(taskInput);
  const proposal = LegacyRefinementProposal.parse(proposalInput);
  const issues: LegacyRefinementIssue[] = [];
  const add = (code: string, path: string, message: string) =>
    issues.push(LegacyRefinementIssue.parse({ code: `legacy/refinement/${code}`, path, message }));

  const currentCandidate = reconcileLegacyInventory(inventory).find(
    (item) => item.candidateId === task.candidateId,
  );
  if (
    inventory.inventoryId !== task.inventoryId ||
    inventory.contentHash !== task.inventoryContentHash
  ) {
    add("stale_inventory", "task.inventoryId", "The task is bound to a different inventory.");
  }
  if (!currentCandidate || sha256(currentCandidate) !== task.candidateHash) {
    add("stale_candidate", "task.candidateHash", "The candidate changed after task creation.");
  } else {
    const canonicalTask = createLegacyRefinementTask(inventory, currentCandidate.candidateId);
    if (canonicalTask.taskId !== task.taskId) {
      add(
        "noncanonical_task",
        "task.taskId",
        "The task does not contain Anvil's complete required decisions and policy.",
      );
    }
  }
  if (
    proposal.inventoryId !== task.inventoryId ||
    proposal.candidateId !== task.candidateId ||
    proposal.candidateHash !== task.candidateHash ||
    proposal.taskId !== task.taskId ||
    proposal.taskHash !== task.taskHash
  ) {
    add("proposal_binding_mismatch", "proposal", "The proposal is not bound to this exact task.");
  }
  if (proposal.submission.status === "declined") {
    add(
      "proposal_declined",
      "proposal.submission.status",
      `The harness declined: ${proposal.submission.reason}.`,
    );
    return assessment(inventory, task, proposal, issues);
  }

  const submission = proposal.submission;
  const evidenceByRef = new Map<string, (typeof submission.evidence)[number]>();
  for (const [index, evidence] of submission.evidence.entries()) {
    if (evidenceByRef.has(evidence.refId)) {
      add(
        "duplicate_evidence_reference",
        `proposal.submission.evidence.${index}.refId`,
        `Evidence reference '${evidence.refId}' is duplicated.`,
      );
    }
    evidenceByRef.set(evidence.refId, evidence);
    if (evidence.kind === "inventory") {
      const exists = inventory.evidence.some((item) => item.evidenceId === evidence.evidenceId);
      if (!exists || !task.candidate.evidenceIds.includes(evidence.evidenceId)) {
        add(
          "evidence_out_of_scope",
          `proposal.submission.evidence.${index}.evidenceId`,
          `Inventory evidence '${evidence.evidenceId}' is outside this candidate.`,
        );
      }
    }
  }

  const evidenceForClaim = new Map<string, Set<string>>();
  for (const [index, claim] of submission.claimEvidence.entries()) {
    const refs = evidenceForClaim.get(claim.claim) ?? new Set<string>();
    for (const refId of claim.evidenceRefIds) {
      refs.add(refId);
      if (!evidenceByRef.has(refId)) {
        add(
          "unknown_evidence_reference",
          `proposal.submission.claimEvidence.${index}.evidenceRefIds`,
          `Claim '${claim.claim}' references unknown evidence '${refId}'.`,
        );
      }
    }
    evidenceForClaim.set(claim.claim, refs);
  }
  const requiredClaims = new Set(
    task.requiredDecisions
      .filter((decision) => decision.kind !== "conflict_resolution")
      .map((decision) => decision.kind),
  );
  for (const claim of requiredClaims) {
    if ((evidenceForClaim.get(claim)?.size ?? 0) === 0) {
      add(
        "missing_claim_evidence",
        "proposal.submission.claimEvidence",
        `Decision '${claim}' has no evidence reference.`,
      );
    }
  }

  assessConflictResolutions(task.candidate, submission, evidenceByRef, add);
  assessBusinessOperation(submission, add);
  assessTransport(task.candidate, submission, evidenceForClaim, add);
  assessOperationalSemantics(submission, add);
  return assessment(inventory, task, proposal, issues);
}

export function createLegacyReviewReceipt(
  inventoryInput: LegacyInventorySnapshot,
  taskInput: LegacyRefinementTaskType,
  proposalInput: LegacyRefinementProposalType,
  input: { decision: "approved" | "rejected"; reviewer: string; reason: string },
): LegacyReviewReceiptType {
  const inventory = verifyLegacyInventory(inventoryInput);
  const task = LegacyRefinementTask.parse(taskInput);
  const proposal = LegacyRefinementProposal.parse(proposalInput);
  const result = assessLegacyRefinementProposal(inventory, task, proposal);
  if (input.decision === "approved" && !result.ok) {
    throw new Error(
      `legacy refinement cannot be approved: ${result.issues
        .map((issue) => `${issue.code}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return finalizeLegacyReviewReceipt({
    schemaVersion: 1,
    inventoryId: inventory.inventoryId,
    inventoryContentHash: inventory.contentHash,
    candidateId: task.candidateId,
    candidateHash: task.candidateHash,
    taskId: task.taskId,
    taskHash: task.taskHash,
    proposalId: proposal.proposalId,
    proposalHash: proposal.proposalHash,
    decision: input.decision,
    reviewer: input.reviewer,
    reason: input.reason,
  });
}

/** Emit a reviewed plan only. Runtime status remains explicitly unimplemented. */
export function createReviewedLegacyCapabilityBinding(
  inventoryInput: LegacyInventorySnapshot,
  taskInput: LegacyRefinementTaskType,
  proposalInput: LegacyRefinementProposalType,
  receiptInput: LegacyReviewReceiptType,
): LegacyCapabilityBindingType {
  const inventory = verifyLegacyInventory(inventoryInput);
  const task = LegacyRefinementTask.parse(taskInput);
  const proposal = LegacyRefinementProposal.parse(proposalInput);
  const receipt = LegacyReviewReceipt.parse(receiptInput);
  const result = assessLegacyRefinementProposal(inventory, task, proposal);
  if (!result.ok) throw new Error("legacy refinement proposal is not valid for binding");
  if (receipt.decision !== "approved") throw new Error("legacy refinement receipt is not approved");
  const expected = {
    inventoryId: inventory.inventoryId,
    inventoryContentHash: inventory.contentHash,
    candidateId: task.candidateId,
    candidateHash: task.candidateHash,
    taskId: task.taskId,
    taskHash: task.taskHash,
    proposalId: proposal.proposalId,
    proposalHash: proposal.proposalHash,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (receipt[key as keyof typeof expected] !== value) {
      throw new Error(`legacy refinement receipt ${key} does not match the reviewed proposal`);
    }
  }
  if (proposal.submission.status !== "proposal_generated") {
    throw new Error("declined legacy refinement cannot produce a binding");
  }
  return finalizeLegacyCapabilityBindingRecord({
    schemaVersion: 1,
    ...expected,
    receiptId: receipt.receiptId,
    receiptHash: receipt.receiptHash,
    operation: proposal.submission.operation,
    transport: proposal.submission.transport,
    semantics: proposal.submission.semantics,
    runtime: { placement: "deployment_local_bridge", status: "not_implemented" },
  });
}

/** Verify the binding's own content address; source lineage is checked during creation. */
export function verifyLegacyCapabilityBinding(input: unknown): LegacyCapabilityBindingType {
  return LegacyCapabilityBinding.parse(input);
}

function assessConflictResolutions(
  candidate: LegacyCapabilityCandidate,
  submission: Extract<LegacyRefinementSubmissionType, { status: "proposal_generated" }>,
  evidenceByRef: ReadonlyMap<string, (typeof submission.evidence)[number]>,
  add: (code: string, path: string, message: string) => void,
): void {
  const byDimension = new Map<LegacyClaimDimension, (typeof submission.resolutions)[number][]>();
  for (const resolution of submission.resolutions) {
    byDimension.set(resolution.dimension, [
      ...(byDimension.get(resolution.dimension) ?? []),
      resolution,
    ]);
  }
  const conflictDimensions = new Set(candidate.conflicts.map((conflict) => conflict.dimension));
  for (const dimension of byDimension.keys()) {
    if (!conflictDimensions.has(dimension)) {
      add(
        "unexpected_conflict_resolution",
        "proposal.submission.resolutions",
        `Dimension '${dimension}' is not conflicting in this candidate.`,
      );
    }
  }
  for (const conflict of candidate.conflicts) {
    const resolutions = byDimension.get(conflict.dimension) ?? [];
    if (resolutions.length !== 1) {
      add(
        "unresolved_conflict",
        "proposal.submission.resolutions",
        `Conflict '${conflict.dimension}' requires exactly one reviewed resolution.`,
      );
      continue;
    }
    const resolution = resolutions[0] as (typeof submission.resolutions)[number];
    const selectedClaim = candidate.claims
      .find((claim) => claim.dimension === conflict.dimension)
      ?.assertions.find((assertion) => sameValue(assertion.value, resolution.selectedValue));
    if (!selectedClaim) {
      add(
        "invented_conflict_value",
        "proposal.submission.resolutions.selectedValue",
        `Resolution for '${conflict.dimension}' is not one of the captured assertions.`,
      );
      continue;
    }
    for (const refId of resolution.evidenceRefIds) {
      if (!evidenceByRef.has(refId)) {
        add(
          "unknown_evidence_reference",
          "proposal.submission.resolutions.evidenceRefIds",
          `Resolution references unknown evidence '${refId}'.`,
        );
      }
    }
    const selectedEvidence = new Set(selectedClaim.evidence.map((evidence) => evidence.evidenceId));
    const hasCapturedSupport = resolution.evidenceRefIds.some((refId) => {
      const evidence = evidenceByRef.get(refId);
      return evidence?.kind === "inventory" && selectedEvidence.has(evidence.evidenceId);
    });
    if (!hasCapturedSupport) {
      add(
        "resolution_not_evidence_bound",
        "proposal.submission.resolutions.evidenceRefIds",
        `Resolution for '${conflict.dimension}' must cite captured evidence for the selected assertion.`,
      );
    }
  }
}

function assessBusinessOperation(
  submission: Extract<LegacyRefinementSubmissionType, { status: "proposal_generated" }>,
  add: (code: string, path: string, message: string) => void,
): void {
  const operation = submission.operation;
  const leaf = operation.name.split(".").at(-1) ?? operation.name;
  if (
    /^(?:put|send|consume|read|receive|invoke|call)_(?:message|queue|topic|ejb|mbean|method|service)$/i.test(
      leaf,
    ) ||
    ["put_message", "consume_queue", "invoke_any_ejb", "call_any_mbean"].includes(leaf)
  ) {
    add(
      "generic_middleware_operation",
      "proposal.submission.operation.name",
      "Expose the business outcome, not a generic middleware primitive.",
    );
  }
  const errorCodes = new Set<string>();
  for (const [index, error] of operation.errors.entries()) {
    if (errorCodes.has(error.code)) {
      add(
        "duplicate_error_code",
        `proposal.submission.operation.errors.${index}.code`,
        `Error code '${error.code}' is duplicated.`,
      );
    }
    errorCodes.add(error.code);
  }
  if (operation.pagination?.mode === "cursor" && !operation.pagination.responseCursorPath) {
    add(
      "incomplete_pagination",
      "proposal.submission.operation.pagination.responseCursorPath",
      "Cursor pagination requires the response cursor path.",
    );
  }
  if (operation.pagination && operation.effect !== "read") {
    add(
      "pagination_on_mutation",
      "proposal.submission.operation.pagination",
      "Pagination is valid only for a read operation.",
    );
  }
  if (operation.pagination && !operation.pagination.maxPageSize) {
    add(
      "unbounded_pagination",
      "proposal.submission.operation.pagination.maxPageSize",
      "Paginated operations require a reviewed maximum page size.",
    );
  }
  for (const [surface, schema] of [
    ["inputSchema", operation.inputSchema],
    ["outputSchema", operation.outputSchema],
  ] as const) {
    if (schema.type !== "object") {
      add(
        "non_object_agent_schema",
        `proposal.submission.operation.${surface}.type`,
        "Agent-facing input and output schemas must have an object root.",
      );
    }
    for (const { key, path } of schemaProperties(schema)) {
      if (/^(?:val|obj|tmp|misc|data)$/i.test(key)) {
        add(
          "weak_field_name",
          `proposal.submission.operation.${surface}.${path}`,
          `Field '${key}' is too ambiguous for an agent-facing contract.`,
        );
      }
      if (
        surface === "outputSchema" &&
        /^(?:button|buttonState|isButtonEnabled|showButton|canClick|disabled)$/i.test(key)
      ) {
        add(
          "ui_projection_exposed",
          `proposal.submission.operation.${surface}.${path}`,
          `Field '${key}' is UI state; expose the underlying business fact instead.`,
        );
      }
    }
  }
}

function assessTransport(
  candidate: LegacyCapabilityCandidate,
  submission: Extract<LegacyRefinementSubmissionType, { status: "proposal_generated" }>,
  evidenceForClaim: ReadonlyMap<string, ReadonlySet<string>>,
  add: (code: string, path: string, message: string) => void,
): void {
  const invocation = candidate.invocation;
  const transport = submission.transport;
  if (transport.kind !== invocation.kind) {
    add(
      "transport_kind_mismatch",
      "proposal.submission.transport.kind",
      `Transport '${transport.kind}' does not match candidate invocation '${invocation.kind}'.`,
    );
    return;
  }

  if (transport.kind === "message" && invocation.kind === "message") {
    if (transport.protocol !== invocation.protocol) {
      add(
        "transport_protocol_mismatch",
        "proposal.submission.transport.protocol",
        "Message protocol changed.",
      );
    }
    if (invocation.direction !== "unknown" && transport.direction !== invocation.direction) {
      add(
        "interaction_mismatch",
        "proposal.submission.transport.direction",
        "Message direction changed from captured evidence.",
      );
    }
    if (
      submission.operation.exposure === "mcp_tool" &&
      ["consume", "subscribe"].includes(transport.direction)
    ) {
      add(
        "unsafe_tool_exposure",
        "proposal.submission.operation.exposure",
        "Inbound consumers and subscriptions must be event triggers or internal bindings, not polling MCP tools.",
      );
    }
    if (
      submission.operation.exposure === "event_trigger" &&
      !["consume", "subscribe"].includes(transport.direction)
    ) {
      add(
        "invalid_event_trigger",
        "proposal.submission.operation.exposure",
        "An event trigger must consume or subscribe.",
      );
    }
    if (transport.direction === "request_reply" && transport.reply.mode === "none") {
      add(
        "missing_reply_strategy",
        "proposal.submission.transport.reply",
        "Request/reply requires an explicit reply and correlation strategy.",
      );
    }
  }
  if (transport.kind === "remote_method" && invocation.kind === "remote_method") {
    if (
      transport.protocol !== invocation.protocol ||
      transport.interface !== invocation.interface
    ) {
      add(
        "remote_contract_mismatch",
        "proposal.submission.transport",
        "Remote protocol and interface must match the captured candidate.",
      );
    }
    if (invocation.method && transport.method !== invocation.method) {
      add(
        "remote_method_mismatch",
        "proposal.submission.transport.method",
        "Remote method must match the captured candidate.",
      );
    }
  }
  if (transport.kind === "resource_adapter" && invocation.kind === "resource_adapter") {
    if (
      transport.adapterRef !== invocation.adapterRef ||
      transport.connectionFactoryRef !== invocation.connectionFactoryRef
    ) {
      add(
        "resource_adapter_mismatch",
        "proposal.submission.transport",
        "Resource adapter references must match the captured candidate.",
      );
    }
  }
  if (transport.kind === "stored_procedure" && invocation.kind === "stored_procedure") {
    if (
      transport.databaseRef !== invocation.databaseRef ||
      transport.procedure !== invocation.procedure
    ) {
      add(
        "stored_procedure_mismatch",
        "proposal.submission.transport",
        "Database and procedure must match the captured candidate.",
      );
    }
  }
  if (transport.kind === "batch_job" && invocation.kind === "batch_job") {
    if (transport.schedulerRef !== invocation.schedulerRef || transport.job !== invocation.job) {
      add(
        "batch_job_mismatch",
        "proposal.submission.transport",
        "Scheduler and job must match the captured candidate.",
      );
    }
  }

  const targets = claimAssertions(candidate, "binding_target");
  if (
    targets.length > 0 &&
    !targets.some((assertion) => sameValue(assertion.value, transport.target))
  ) {
    add(
      "invented_transport_target",
      "proposal.submission.transport.target",
      "Transport target is not one of the captured binding assertions.",
    );
  }
  if (targets.length === 0 && (evidenceForClaim.get("transport_target")?.size ?? 0) === 0) {
    add(
      "missing_transport_target_evidence",
      "proposal.submission.transport.target",
      "A target absent from inventory needs external evidence.",
    );
  }
  const targetConflict = candidate.conflicts.some(
    (conflict) => conflict.dimension === "binding_target",
  );
  if (targetConflict) {
    const selected = submission.resolutions.find(
      (resolution) => resolution.dimension === "binding_target",
    );
    if (selected && !sameValue(selected.selectedValue, transport.target)) {
      add(
        "transport_target_resolution_mismatch",
        "proposal.submission.transport.target",
        "Transport target must equal the reviewed binding_target resolution.",
      );
    }
  }
}

function assessOperationalSemantics(
  submission: Extract<LegacyRefinementSubmissionType, { status: "proposal_generated" }>,
  add: (code: string, path: string, message: string) => void,
): void {
  const semantics = submission.semantics;
  if (semantics.completion === "unknown") {
    add(
      "unknown_completion_semantics",
      "proposal.submission.semantics.completion",
      "Approval requires an explicit completion meaning.",
    );
  }
  if (
    semantics.completion === "transport_accepted" &&
    /\bcomplet(?:e|ed|ion)\b/i.test(
      `${submission.operation.summary} ${submission.operation.description}`,
    )
  ) {
    add(
      "completion_overclaim",
      "proposal.submission.operation.description",
      "The operation claims completion, but the reviewed signal proves only transport acceptance.",
    );
  }
  if (semantics.authorization.mode === "unknown") {
    add(
      "unknown_authorization",
      "proposal.submission.semantics.authorization.mode",
      "Approval requires a deployment or delegated authorization model.",
    );
  }
  if (semantics.idempotency.mode === "unknown") {
    add(
      "unknown_idempotency",
      "proposal.submission.semantics.idempotency.mode",
      "Approval requires an explicit idempotency decision, including an explicit 'none'.",
    );
  }
  if (semantics.idempotency.mode === "client_key" && !semantics.idempotency.carrier) {
    add(
      "missing_idempotency_carrier",
      "proposal.submission.semantics.idempotency.carrier",
      "Client-key idempotency requires a reviewed transport carrier.",
    );
  }
  if (semantics.retry.mode === "never" && semantics.retry.maxAttempts !== 1) {
    add(
      "invalid_retry_attempts",
      "proposal.submission.semantics.retry.maxAttempts",
      "Retry mode 'never' requires exactly one attempt.",
    );
  }
  if (semantics.retry.mode === "safe_transient" && semantics.retry.maxAttempts < 2) {
    add(
      "invalid_retry_attempts",
      "proposal.submission.semantics.retry.maxAttempts",
      "Automatic retry requires at least two total attempts.",
    );
  }
  if (
    semantics.retry.mode === "safe_transient" &&
    !["natural", "client_key"].includes(semantics.idempotency.mode)
  ) {
    add(
      "unsafe_retry_policy",
      "proposal.submission.semantics.retry",
      "Automatic retry requires proven natural or client-key idempotency.",
    );
  }
}

function assessment(
  inventory: LegacyInventorySnapshot,
  task: LegacyRefinementTaskType,
  proposal: LegacyRefinementProposalType,
  issues: LegacyRefinementIssue[],
): LegacyRefinementAssessment {
  const ordered = [...issues].sort(
    (left, right) => left.code.localeCompare(right.code) || left.path.localeCompare(right.path),
  );
  return LegacyRefinementAssessment.parse({
    schemaVersion: 1,
    inventoryId: inventory.inventoryId,
    taskId: task.taskId,
    proposalId: proposal.proposalId,
    ok: ordered.length === 0,
    issues: ordered,
  });
}

function claimAssertions(
  candidate: LegacyCapabilityCandidate,
  dimension: LegacyClaimDimension,
): LegacyClaimAssertion[] {
  return candidate.claims.find((claim) => claim.dimension === dimension)?.assertions ?? [];
}

function sameValue(left: LegacyClaimValue, right: LegacyClaimValue): boolean {
  return hashCanonical(left) === hashCanonical(right);
}

function sha256(value: unknown): `sha256:${string}` {
  return `sha256:${hashCanonical(value)}`;
}

function schemaProperties(
  schema: Record<string, unknown>,
  prefix = "properties",
  depth = 0,
): Array<{ key: string; path: string }> {
  if (depth > 8) return [];
  const properties = schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return [];
  const found: Array<{ key: string; path: string }> = [];
  for (const [key, value] of Object.entries(properties)) {
    const path = `${prefix}.${key}`;
    found.push({ key, path });
    if (value && typeof value === "object" && !Array.isArray(value)) {
      found.push(
        ...schemaProperties(value as Record<string, unknown>, `${path}.properties`, depth + 1),
      );
    }
  }
  return found;
}
