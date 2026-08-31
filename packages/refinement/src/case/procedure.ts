import type { RefinementSkill } from "../skills/contract.js";
import type { SemanticTarget } from "../target.js";
import type { CasePhase } from "./model.js";

/**
 * An **investigation procedure** is what makes a skill more than a bag of
 * constraints: a repeatable method a coding agent follows to *find* the truth, not
 * just a boundary on what it may write. Each step is tagged with the phase it
 * belongs to, so the same procedure drives the case brief (CASE.md), the ordering
 * of the phase outputs, and the escalation tier a step implies. Procedures are
 * derived from the skill registry, so a new skill gets a sane default without one.
 */

export interface ProcedureStep {
  phase: CasePhase;
  instruction: string;
}

export interface InvestigationProcedure {
  skill: string;
  /** The one-line question the case exists to answer, phrased for the target. */
  question(target: SemanticTarget): string;
  /** The ranked search plan hints an executor should start from. */
  searchHints: string[];
  steps: ProcedureStep[];
}

function targetNoun(target: SemanticTarget): string {
  switch (target.kind) {
    case "field":
    case "enum":
      return `\`${target.path}\` on ${target.operationId}`;
    case "error":
      return `error \`${target.code}\` of ${target.operationId}`;
    case "operation":
      return target.operationId;
    case "capability":
      return target.capabilityId;
    case "group":
      return `confusable tool cluster \`${target.groupId}\``;
    default:
      return "this target";
  }
}

/* -------------------------------------------------------------------------- */
/* The described-field method — the exemplar the design specifies             */
/* -------------------------------------------------------------------------- */

const describeField: InvestigationProcedure = {
  skill: "describe-field",
  question: (t) => `Investigate what ${targetNoun(t)} means and how it is used.`,
  searchHints: [
    "the field name, quoted, in the service implementation",
    "the field name in contract tests and fixtures",
    "the field name in user-facing docs and serializers",
  ],
  steps: [
    {
      phase: "research",
      instruction: "Locate the field's declaration in the source implementation.",
    },
    { phase: "research", instruction: "Trace every read and write of the field through the code." },
    {
      phase: "research",
      instruction:
        "Inspect its validation and serialization — where it is checked and where it leaves the system.",
    },
    {
      phase: "research",
      instruction:
        "Inspect the tests that exercise the field, and any user-facing output that contains it.",
    },
    {
      phase: "extract",
      instruction: "Identify contradictions between sources before drawing conclusions.",
    },
    {
      phase: "extract",
      instruction: "Produce atomic claims, each with an exact source span and predicate.",
    },
    {
      phase: "synthesize",
      instruction: "Draft a description that contains ONLY clauses supported by an accepted claim.",
    },
    {
      phase: "critique",
      instruction: "Try to falsify each clause; drop any the evidence does not support.",
    },
    {
      phase: "test",
      instruction:
        "Run the generated deterministic validation and record the checks that prove the change.",
    },
  ],
};

const describeOperation: InvestigationProcedure = {
  skill: "describe-operation",
  question: (t) =>
    `Investigate what ${targetNoun(t)} does, precisely enough to tell it apart from its siblings.`,
  searchHints: [
    "the operation's handler / route in the implementation",
    "tests that call the operation",
    "docs describing the endpoint",
  ],
  steps: [
    {
      phase: "research",
      instruction: "Find the operation's handler and read what it actually does.",
    },
    {
      phase: "research",
      instruction:
        "Read sibling operations so the description distinguishes this one (it feeds routing).",
    },
    {
      phase: "research",
      instruction: "Inspect tests and docs that describe the operation's effect.",
    },
    {
      phase: "extract",
      instruction: "Extract atomic claims about the operation's behaviour, with source spans.",
    },
    {
      phase: "synthesize",
      instruction: "Draft a description from supported claims only; do not invent behaviour.",
    },
    {
      phase: "critique",
      instruction: "Falsify each clause and confirm the description is distinct from siblings.",
    },
    { phase: "test", instruction: "Record the routing checks the new description should improve." },
  ],
};

const generateExamples: InvestigationProcedure = {
  skill: "generate-examples",
  question: (t) => `Find a realistic, schema-valid value for ${targetNoun(t)}.`,
  searchHints: [
    "the field in contract-test fixtures (real values)",
    "the field in doc or Postman examples",
    "the field's own schema (enum / example / default)",
  ],
  steps: [
    {
      phase: "research",
      instruction:
        "Look for a real value in fixtures, docs, or Postman; else use the field's own schema.",
    },
    { phase: "extract", instruction: "Record the value as a claim tied to where it came from." },
    {
      phase: "synthesize",
      instruction: "Set `examples` to values that VALIDATE against the field schema.",
    },
    {
      phase: "critique",
      instruction: "Confirm each example satisfies the schema (type, enum, bounds).",
    },
    { phase: "test", instruction: "Record the argument-mapping check the example should improve." },
  ],
};

const enrichErrors: InvestigationProcedure = {
  skill: "enrich-errors",
  question: (t) => `Investigate what ${targetNoun(t)} means and whether it is safe to retry.`,
  searchHints: [
    "where the error is raised in the implementation",
    "tests that assert this error",
    "docs or incidents describing it",
  ],
  steps: [
    { phase: "research", instruction: "Find where the error is raised and under what condition." },
    {
      phase: "research",
      instruction:
        "Inspect tests and incidents that show whether a retry succeeds or duplicates work.",
    },
    {
      phase: "extract",
      instruction: "Extract claims for the human message and for retryability, with sources.",
    },
    {
      phase: "synthesize",
      instruction:
        "Set `message` and, ONLY when tightening, `retryable`. Loosening (retryable=true) needs authoritative evidence and defers to review.",
    },
    {
      phase: "critique",
      instruction: "Check the retryability direction against the evidence class before proposing.",
    },
    {
      phase: "test",
      instruction: "Record the error-recovery check the enrichment should improve.",
    },
  ],
};

const investigateUiProjection: InvestigationProcedure = {
  skill: "investigate-ui-projection",
  question: (t) =>
    `Investigate whether ${targetNoun(t)} is a stable business capability or transient screen plumbing.`,
  searchHints: [
    "frontend call sites and the user actions that trigger this operation",
    "the server handler, serializer, downstream calls, and persistence writes",
    "contract and integration tests that define behavior independently of one screen",
    "API ownership, versioning, and any direct domain API serving the same intent",
  ],
  steps: [
    {
      phase: "research",
      instruction:
        "Trace every supplied frontend caller to the handler and record the user intent separately from the screen layout.",
    },
    {
      phase: "research",
      instruction:
        "Trace the handler through serializers, downstream calls, persistence writes, authorization checks, and idempotency handling.",
    },
    {
      phase: "research",
      instruction:
        "Inspect contract/integration tests, ownership, versioning, and sibling domain APIs to learn whether behavior is stable outside this view.",
    },
    {
      phase: "extract",
      instruction:
        "Record separate claims for business intent, UI-only composition, hidden writes, authority, ownership, and lifecycle; preserve contradictions.",
    },
    {
      phase: "synthesize",
      instruction:
        "Only when verified evidence proves a stable capability, propose a precise description grounded by that evidence. Otherwise emit no proposal and state what evidence or owner decision is missing.",
    },
    {
      phase: "critique",
      instruction:
        "Try to falsify stability: look for screen-specific fields, per-view branching, duplicate domain APIs, undocumented persistence, and frontend-only version coupling.",
    },
    {
      phase: "test",
      instruction:
        "Record contract, authorization, write-safety, and routing checks that would prove the retained capability; never invent a replacement facade.",
    },
  ],
};

const rehomeResource: InvestigationProcedure = {
  skill: "rehome-resource",
  question: (t) =>
    `Decide the routing resource of ${targetNoun(t)}: the path-derived resource never appears in the operation's own name text. Is the name a synonym for the path segment, or is the derived resource wrong?`,
  searchHints: [
    "the vendor's own wording: the operation's summary, description, and docs for this endpoint",
    "sibling operations under the same parent path segment (carried in the task's deficiency facts)",
    "the handler/model/serializer names in the implementation for the entity this endpoint acts on",
    "the estate's naming-style facts in the task (REST resource grammar vs RPC-over-HTTP)",
  ],
  steps: [
    {
      phase: "research",
      instruction:
        "Read the path, the name text, and the sibling operations. Establish what entity this operation actually acts on — not which segment happens to precede it.",
    },
    {
      phase: "research",
      instruction:
        "Check for a synonym pair (hook/webhook, content/file): when the name and the path spell the SAME entity differently, the path's word is usually still the right resource and no change is needed.",
    },
    {
      phase: "extract",
      instruction:
        "Record claims naming the entity, each tied to a source span; keep contradictions visible.",
    },
    {
      phase: "synthesize",
      instruction:
        "Propose ONLY `resource`, and only a word the operation's own path or name text states — the deterministic grounding check refuses anything else. When the evidence does not decide, decline honestly.",
    },
    {
      phase: "critique",
      instruction:
        "Try to falsify the choice: a scope segment (org, repo, user) that merely corroborates the name is the audited failure mode, not a resource.",
    },
    {
      phase: "test",
      instruction:
        "Record the routing checks the re-home should improve; the closure a reviewer applies is the manifest `name: { resource }` override.",
    },
  ],
};

const resolveConfusableCluster: InvestigationProcedure = {
  skill: "resolve-confusable-cluster",
  question: (t) =>
    `Decide the higher-order shape for ${targetNoun(t)}: the routing benchmark measured these tools eating each other's tasks. Compose a workflow that supersedes its own steps, author a capability over the members, or honestly propose no change.`,
  searchHints: [
    "the task's own facts: member operations in full routing detail, the mis-routed intents verbatim, shared vocabulary tokens",
    "the estate's traffic groupings in the task facts, if a spool report was present at export",
    "the vendor's docs for the members: is the family one task performed in sequence, or true alternatives an agent must pick between?",
    "sibling estates or implementation code showing the members called together in one flow",
  ],
  steps: [
    {
      phase: "research",
      instruction:
        "Read every member's name, description, params, and intent examples, and the mis-routed intents verbatim. Establish WHY the agent confuses them: variants of one read, steps of one task, or genuinely distinct operations with colliding vocabulary.",
    },
    {
      phase: "research",
      instruction:
        "If the members form a sequence (one's output feeds the next's required input), sketch the workflow: steps in order, each later step's required params bound as $.output.<field> of the previous step's real output schema.",
    },
    {
      phase: "research",
      instruction:
        "If the members are one task-shaped family rather than a sequence, sketch the capability: the member set (grant only), a name and intents in the members' own vocabulary.",
    },
    {
      phase: "extract",
      instruction:
        "Record claims naming the chosen shape, each tied to a source; keep the evidence for sequences (docs describing the flow, traffic groupings) separate from vocabulary facts.",
    },
    {
      phase: "synthesize",
      instruction:
        "Propose EXACTLY ONE of `workflow` or `capability`, with every operation reference inside the task's grant, supersedes only naming the proposal's own steps, and every name/intent grounded in the members' own vocabulary. When neither shape is real, decline honestly (insufficient_evidence) and say why in the summary — a decline is a first-class answer.",
    },
    {
      phase: "critique",
      instruction:
        "Try to falsify the composition: a binding whose field the previous step does not output, a superseded tool the composite cannot stand in for, a name that only relabels the confusion. Anvil will re-run the routing benchmark over your proposal and refuse a negative delta with the numbers.",
    },
    {
      phase: "test",
      instruction:
        "Record which mis-routed intents your shape should flip to passing; the import's scored admission attaches the measured delta as evidence for the reviewer.",
    },
  ],
};

const PROCEDURES: Record<string, InvestigationProcedure> = {
  "describe-field": describeField,
  "describe-operation": describeOperation,
  "generate-examples": generateExamples,
  "enrich-errors": enrichErrors,
  "investigate-ui-projection": investigateUiProjection,
  "rehome-resource": rehomeResource,
  "resolve-confusable-cluster": resolveConfusableCluster,
};

/**
 * The procedure for a skill. When a skill has no authored method, synthesise a
 * generic one from its contract so a fresh skill still yields a coherent case: the
 * phases are fixed, the constraints become the caveats, and the evidence policy
 * names where to look.
 */
export function procedureFor(skill: RefinementSkill): InvestigationProcedure {
  const authored = PROCEDURES[skill.name];
  if (authored) return authored;
  return {
    skill: skill.name,
    question: (t) =>
      `Investigate the semantics of ${targetNoun(t)} and close ${skill.triggers.join("/")}.`,
    searchHints: skill.evidence.allowed.map((s) => `${s} sources for this target`),
    steps: [
      {
        phase: "research",
        instruction: `Gather evidence from admissible sources: ${skill.evidence.allowed.join(", ")}.`,
      },
      { phase: "extract", instruction: "Turn the evidence into atomic, sourced claims." },
      {
        phase: "synthesize",
        instruction: `Draft a patch that writes only: ${skill.output.fields.join(", ") || "(nothing)"}.`,
      },
      {
        phase: "critique",
        instruction: "Falsify each asserted value; keep only what the evidence supports.",
      },
      { phase: "test", instruction: "Record the checks that would prove the refinement." },
    ],
  };
}
