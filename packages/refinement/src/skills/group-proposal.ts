import type { Operation } from "@anvil/air";
import {
  bindableOutputFields,
  extractFieldName,
  planWorkflowSurface,
  snakeCase,
  Workflow,
} from "@anvil/air";
import { z } from "zod";
import { normalizedWords, routingTokens, wordGrounds } from "../vocabulary.js";
import type { JsonValue } from "./contract.js";

/**
 * The GROUP proposal boundary — what a coding harness may answer when Anvil
 * asks it about a whole confusable-tool cluster rather than one operation.
 *
 * A `confusable_tool_cluster` task carries K operations the routing benchmark
 * measured eating each other's tasks. The harness's answer is a bounded union,
 * spelled here as two zod payloads on two patch keys:
 *
 *   `workflow`   — compose a higher-order tool whose steps are cluster members
 *                  and whose `supersedes` (⊆ its own steps) SHRINKS the served
 *                  surface, per the shared planner in `@anvil/air`.
 *   `capability` — author a task-shaped grouping over the members, the same
 *                  declaration a manifest `capabilities:` entry makes — born
 *                  proposed, never approved.
 *
 * "No change, with a reason" is deliberately NOT a third patch key: the
 * protocol already has honest-decline statuses (`insufficient_evidence`,
 * `supported`, …) that must not carry a patch, and the decline's reason is the
 * submission's summary. Inventing a patch that changes nothing would let a
 * decline masquerade as a proposal.
 *
 * Everything here is deterministic validation over the proposal, the task's
 * hash-bound grant, and AIR-resolved member operations — the same "an
 * unreliable executor is safe because the machine only accepts demonstrated,
 * grounded output" discipline as every other skill. Nothing here touches a
 * safety semantic: the payloads carry no state, no idempotency, no
 * confirmation, and the strict schemas refuse any extra key.
 */

/* ------------------------------- payloads --------------------------------- */

export const zGroupWorkflowPayload = z
  .object({
    /** Workflow name; becomes `<capability>.<snake(name)>` — the composite tool id. */
    name: z.string().min(1),
    display_name: z.string().min(1).optional(),
    description: z.string().min(1),
    intent_examples: z.array(z.string().min(1)).min(1),
    steps: z
      .array(
        z
          .object({
            /** Operation reference: AIR id, canonicalName, or source operationId. */
            operation: z.string().min(1),
            description: z.string().optional(),
            /** paramName -> `$.output.<field>` of the previous step. */
            bindings: z.record(z.string(), z.string()).optional(),
          })
          .strict(),
      )
      .min(2, "a composed workflow needs at least two steps"),
    /** Operation references the composite replaces on the served surface. */
    supersedes: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type GroupWorkflowPayload = z.infer<typeof zGroupWorkflowPayload>;

export const zGroupCapabilityPayload = z
  .object({
    /** Stable dotted id for the authored capability. */
    id: z.string().min(1),
    display_name: z.string().min(1),
    description: z.string().min(1),
    intent_examples: z.array(z.string().min(1)).min(1),
    /** Member operation references. */
    operations: z.array(z.string().min(1)).min(2, "a capability over one operation groups nothing"),
  })
  .strict();
export type GroupCapabilityPayload = z.infer<typeof zGroupCapabilityPayload>;

/** The two patch keys a group skill may write. Exactly one per proposal. */
export const GROUP_PATCH_KEYS = ["workflow", "capability"] as const;

/* --------------------------------- grant ---------------------------------- */

/**
 * What the task GRANTED the harness: the cluster's member operations plus any
 * explicitly-listed related operations (traffic-grouping members carried in
 * the facts). Read from the deficiency's facts, which are hash-bound into the
 * exported task and re-verified on import — a submission naming anything
 * outside this set is refused by `group_grant_respected`, not reviewed.
 */
export interface GroupGrant {
  memberOperationIds: string[];
  relatedOperationIds: string[];
}

const zGrantFacts = z
  .object({
    members: z.array(z.object({ operationId: z.string() }).loose()).default([]),
    relatedOperationIds: z.array(z.string()).default([]),
  })
  .loose();

export function groupGrantOf(facts: Record<string, unknown>): GroupGrant {
  const parsed = zGrantFacts.safeParse(facts);
  if (!parsed.success) return { memberOperationIds: [], relatedOperationIds: [] };
  return {
    memberOperationIds: parsed.data.members.map((member) => member.operationId),
    relatedOperationIds: parsed.data.relatedOperationIds,
  };
}

/**
 * Resolve one manifest-style operation reference: AIR id, canonical name, or
 * the source operationId. Mirrors `operationMatchesKey` in `@anvil/compiler`
 * (manifest.ts) rather than importing it — `@anvil/compiler` is a *dev*
 * dependency of this package (the runtime graph runs compiler → refinement,
 * never back), the same reasoning `vocabulary.ts` records for `singularize`.
 * Kept byte-equivalent so a reference a manifest would accept is a reference
 * this validation accepts.
 */
export function resolveOperationReference(
  operations: readonly Operation[],
  reference: string,
): Operation | undefined {
  return operations.find(
    (op) =>
      op.id === reference ||
      op.canonicalName === reference ||
      op.sourceRef.operationId === reference,
  );
}

/* ------------------------------ construction ------------------------------ */

export interface GroupWorkflowBuild {
  workflow?: Workflow;
  issues: string[];
}

/**
 * Build the real `Workflow` a group workflow payload describes, against the
 * operations the task granted. One builder, three consumers — validation
 * (`group_workflow_composes`), the CLI's benchmark-scored admission, and the
 * apply write path — so the workflow that is validated is the workflow that is
 * scored is the workflow that lands in AIR.
 *
 * The state is `approved` by construction and that is NOT an approval: this
 * object only ever reaches canonical AIR through `applyReviewed`, behind a
 * receipt-bound human decision (the approval policy pins every `workflow`
 * patch to review — see approval.ts). It is `approved` here because both other
 * consumers need the registrable form: `planWorkflowSurface` registers and
 * supersedes only for approved workflows, and a hypothetical surface built
 * from an unregistrable workflow would score a composition that can never
 * serve.
 */
export function buildGroupWorkflow(
  payload: GroupWorkflowPayload,
  grantOps: readonly Operation[],
  fallbackOwnerId: string,
): GroupWorkflowBuild {
  const issues: string[] = [];
  const steps: Workflow["steps"] = [];
  for (const step of payload.steps) {
    const op = resolveOperationReference(grantOps, step.operation);
    if (!op) {
      issues.push(`step '${step.operation}' does not resolve to a granted operation`);
      continue;
    }
    steps.push({
      operationId: op.id,
      description: step.description ?? op.displayName,
      optional: false,
      bindings: step.bindings ?? {},
    });
  }
  const supersedes: string[] = [];
  for (const reference of payload.supersedes ?? []) {
    const op = resolveOperationReference(grantOps, reference);
    if (!op) {
      issues.push(`supersedes '${reference}' does not resolve to a granted operation`);
      continue;
    }
    if (!supersedes.includes(op.id)) supersedes.push(op.id);
  }
  if (issues.length > 0) return { issues };

  const capabilityId = steps
    .map((step) => grantOps.find((op) => op.id === step.operationId)?.capabilityId)
    .find((id): id is string => Boolean(id));
  const ownerId = capabilityId ?? fallbackOwnerId;
  const parsed = Workflow.safeParse({
    id: `${ownerId}.${snakeCase(payload.name)}`,
    capabilityId: ownerId,
    displayName: payload.display_name ?? payload.name,
    description: payload.description,
    intentExamples: payload.intent_examples,
    steps,
    humanApproval: false,
    ...(supersedes.length > 0 ? { supersedes } : {}),
    state: "approved",
    evidence: { claims: [] },
  });
  if (!parsed.success) {
    return { issues: parsed.error.issues.map((issue) => issue.message) };
  }
  return { workflow: parsed.data, issues: [] };
}

/* ------------------------------- validation ------------------------------- */

/** The parsed shape of one group patch, or the reasons it has none. */
export function parseGroupPatch(set: Record<string, JsonValue>): {
  workflow?: GroupWorkflowPayload;
  capability?: GroupCapabilityPayload;
  issues: string[];
} {
  const keys = Object.keys(set);
  const groupKeys = keys.filter((key) => (GROUP_PATCH_KEYS as readonly string[]).includes(key));
  if (groupKeys.length !== 1) {
    return {
      issues: [
        `a group proposal sets exactly one of ${GROUP_PATCH_KEYS.join("/")}; got: ${keys.join(", ") || "(nothing)"}`,
      ],
    };
  }
  if ("workflow" in set) {
    const parsed = zGroupWorkflowPayload.safeParse(set.workflow);
    return parsed.success
      ? { workflow: parsed.data, issues: [] }
      : {
          issues: parsed.error.issues.map(
            (issue) => `workflow.${issue.path.join(".")}: ${issue.message}`,
          ),
        };
  }
  const parsed = zGroupCapabilityPayload.safeParse(set.capability);
  return parsed.success
    ? { capability: parsed.data, issues: [] }
    : {
        issues: parsed.error.issues.map(
          (issue) => `capability.${issue.path.join(".")}: ${issue.message}`,
        ),
      };
}

/** Every operation reference a group patch makes, in payload order. */
export function groupPatchReferences(patch: {
  workflow?: GroupWorkflowPayload;
  capability?: GroupCapabilityPayload;
}): string[] {
  if (patch.workflow) {
    return [
      ...patch.workflow.steps.map((step) => step.operation),
      ...(patch.workflow.supersedes ?? []),
    ];
  }
  return patch.capability?.operations ?? [];
}

/**
 * The `supersedes ⊆ steps` rule, checked explicitly and by name: every
 * supersedes reference must resolve to an operation the payload's own steps
 * perform. The AIR `Workflow` schema refuses this shape too (defense in
 * depth), but THIS check owns the named rejection — the mutation gate arms it
 * (`refinement/group-supersedes-outside-steps-refused`).
 */
export function supersedesOutsideSteps(
  payload: GroupWorkflowPayload,
  grantOps: readonly Operation[],
): string[] {
  const stepIds = new Set(
    payload.steps
      .map((step) => resolveOperationReference(grantOps, step.operation)?.id)
      .filter((id): id is string => Boolean(id)),
  );
  return (payload.supersedes ?? []).filter((reference) => {
    const op = resolveOperationReference(grantOps, reference);
    return !op || !stepIds.has(op.id);
  });
}

/**
 * Structural data-flow dry run: from step 2 on, a step's input is ONLY what its
 * bindings pull from the previous step's output (`@anvil/mcp-runtime` resets
 * the input between steps), so every required input must have a binding, every
 * binding must use the one grammar (`$.output.<field>`), and every bound field
 * must be a name the previous step's output schema actually declares
 * (`bindableOutputFields` — the same resolution `detectWorkflowCandidates`
 * proposes against). This validates that the chain CAN thread; it does not
 * execute it (see the admission report's `simulated` flag for what was not
 * run).
 */
export function workflowBindingIssues(
  payload: GroupWorkflowPayload,
  grantOps: readonly Operation[],
): string[] {
  const issues: string[] = [];
  const stepOps = payload.steps.map((step) => resolveOperationReference(grantOps, step.operation));
  for (let i = 1; i < payload.steps.length; i++) {
    const step = payload.steps[i];
    const stepOp = stepOps[i];
    const prevOp = stepOps[i - 1];
    if (!step || !stepOp || !prevOp) continue; // unresolved refs already failed the grant check
    const available = bindableOutputFields(prevOp.output.schema);
    const bindings = step.bindings ?? {};
    for (const [param, binding] of Object.entries(bindings)) {
      const field = extractFieldName(binding);
      if (!field) {
        issues.push(
          `step ${i + 1} ('${stepOp.id}') binding for '${param}' is not of the form $.output.<field>: '${binding}'`,
        );
        continue;
      }
      if (!available.has(field)) {
        issues.push(
          `step ${i + 1} ('${stepOp.id}') binds '${param}' from '${field}', which '${prevOp.id}' does not output`,
        );
      }
    }
    const requiredInputs = [
      ...stepOp.input.params.filter((p) => p.required && p.in !== "header").map((p) => p.name),
      ...(stepOp.input.body?.projection === "fields"
        ? stepOp.input.body.fields.filter((f) => f.required).map((f) => f.name)
        : []),
    ];
    for (const name of requiredInputs) {
      if (!(name in bindings)) {
        issues.push(
          `step ${i + 1} ('${stepOp.id}') requires '${name}' but no binding supplies it — later steps receive only bound values`,
        );
      }
    }
  }
  return issues;
}

/**
 * Does the composed workflow actually register on the shared surface planner?
 * `planWorkflowSurface` is THE decision both `@anvil/mcp-runtime` and the
 * disclosure budget consume; a workflow it would skip (unapproved step,
 * malformed binding, keyed later step) must fail validation here rather than
 * land in review looking servable.
 */
export function workflowComposeIssues(
  workflow: Workflow,
  grantOps: readonly Operation[],
): string[] {
  const approved = new Map(
    grantOps.filter((op) => op.state === "approved").map((op) => [op.id, op]),
  );
  const all = new Map(grantOps.map((op) => [op.id, op]));
  const plan = planWorkflowSurface([workflow], approved, all);
  const registration = plan.registrations[0];
  if (!registration) return ["the workflow surface planner returned no verdict"];
  if (registration.skipReason !== undefined) {
    return [
      `the shared surface planner would not register this workflow: ${registration.skipReason}`,
    ];
  }
  const refused = plan.refused.map(
    (entry) => `suppression of '${entry.operationId}' would be refused: ${entry.reason}`,
  );
  return refused;
}

/* ------------------------------ vocabulary -------------------------------- */

/** The routing vocabulary of the granted operations: names, tool names, intents. */
export function groupVocabulary(grantOps: readonly Operation[]): Set<string> {
  const vocabulary = new Set<string>();
  for (const op of grantOps) {
    const text = [
      op.canonicalName,
      op.displayName,
      op.mcp.toolName,
      op.description,
      ...op.skill.intentExamples,
    ].join(" ");
    for (const token of routingTokens(text)) vocabulary.add(token);
  }
  return vocabulary;
}

function grounded(token: string, vocabulary: ReadonlySet<string>): boolean {
  return [...vocabulary].some((word) => wordGrounds(token, word) || wordGrounds(word, token));
}

/**
 * Names and intents must be the operations' OWN vocabulary, not invented — the
 * group form of `resource_grounded_in_contract`, using the one shared
 * tokenizer (`routingTokens`). Name tokens are held word-by-word (a routing
 * name is read token-by-token); descriptions and intent phrases are sentences,
 * so each must *share* vocabulary with the members rather than consist of it.
 */
export function groupNameIssues(
  patch: { workflow?: GroupWorkflowPayload; capability?: GroupCapabilityPayload },
  grantOps: readonly Operation[],
): string[] {
  const vocabulary = groupVocabulary(grantOps);
  const issues: string[] = [];
  const nameOf = (label: string, value: string): void => {
    const tokens = routingTokens(value);
    if (tokens.length === 0) {
      issues.push(`${label} '${value}' carries no content words`);
      return;
    }
    const alien = tokens.filter((token) => !grounded(token, vocabulary));
    if (alien.length > 0) {
      issues.push(
        `${label} word(s) not stated by the member operations' own vocabulary: ${alien.join(", ")}`,
      );
    }
  };
  const sentenceOf = (label: string, value: string): void => {
    const tokens = routingTokens(value);
    if (!tokens.some((token) => grounded(token, vocabulary))) {
      issues.push(`${label} shares no vocabulary with the member operations: '${value}'`);
    }
  };
  if (patch.workflow) {
    nameOf("workflow name", payloadNameWords(patch.workflow.name));
    if (patch.workflow.display_name) nameOf("workflow display_name", patch.workflow.display_name);
    sentenceOf("workflow description", patch.workflow.description);
    for (const [index, intent] of patch.workflow.intent_examples.entries()) {
      sentenceOf(`workflow intent_examples[${index}]`, intent);
    }
  }
  if (patch.capability) {
    nameOf("capability id", payloadNameWords(patch.capability.id));
    nameOf("capability display_name", patch.capability.display_name);
    sentenceOf("capability description", patch.capability.description);
    for (const [index, intent] of patch.capability.intent_examples.entries()) {
      sentenceOf(`capability intent_examples[${index}]`, intent);
    }
  }
  return issues;
}

/** Split a dotted/underscored proposal name into the words the grounding reads. */
function payloadNameWords(name: string): string {
  return normalizedWords(name).join(" ");
}
