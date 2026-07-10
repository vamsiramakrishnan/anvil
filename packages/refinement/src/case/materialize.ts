import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AirDocument, Claim } from "@anvil/air";
import type { Deficiency } from "../deficiency.js";
import { assembleContext, evidenceForTarget } from "../skills/context.js";
import type { RefinementSkill, SkillConstraint, SkillContext } from "../skills/contract.js";
import { skillFor } from "../skills/registry.js";
import { describeTarget, targetKey } from "../target.js";
import {
  buildRunIdentity,
  type CaseWorkspace,
  type RunIdentity,
  resolveWorkspace,
} from "./identity.js";
import {
  type AllowedToolsDoc,
  CASE_FILES,
  CASE_OUTPUT,
  type CaseDocument,
  type CaseFieldFacts,
  type CaseTargetDoc,
  type CaseTask,
  type EvidencePolicyDoc,
  expectedOutputSchema,
  PHASE_ROLE,
} from "./model.js";
import { type InvestigationProcedure, procedureFor } from "./procedure.js";

/**
 * The `anvil case` helper commands available inside a case — only the rails that
 * enforce *Anvil* semantics. Repository search and language tooling are the coding
 * agent's own job; Anvil does not ship a weak re-implementation of them.
 */
export const CASE_HELPERS = [
  "anvil case inspect <case>",
  "anvil case add-evidence <case> --predicate p --source k --path file --lines a-b",
  "anvil case validate-claims <case>",
  "anvil case synthesize <case> field=value",
  "anvil case validate-proposal <case> <air>",
  "anvil case finalize <case> [--status ...]",
];

/**
 * Supporting predicates per skill: the narrow, intermediate facts an investigation
 * may legitimately record beyond the skill's output predicates. Kept deliberately
 * small — an executor may not assert free-form predicates into `claims.json`.
 */
export const SUPPORTING_PREDICATES: Record<string, string[]> = {
  "describe-field": [
    "field.visibility",
    "field.unit",
    "field.usage",
    "field.lifecycle",
    "field.sensitivity",
  ],
  "describe-operation": ["operation.effect", "operation.behavior"],
  "generate-examples": ["field.format", "field.description"],
  "enrich-errors": ["error.cause", "error.httpStatus"],
};

/** Human wording for each machine constraint, for the brief's "you may not" list. */
const CONSTRAINT_PROSE: Record<SkillConstraint, string> = {
  do_not_invent_business_rules: "infer business rules the sources do not support",
  do_not_change_field_type: "change the field's type",
  do_not_change_requiredness: "change whether the field is required",
  preserve_domain_terms: "replace the domain's own terms with invented vocabulary",
  do_not_loosen_safety:
    "loosen safety (e.g. mark an error retryable) without authoritative evidence",
};

/** The hard prohibitions every case carries, independent of the skill. */
const BASE_DENY = [
  "modify source files",
  "edit canonical AIR",
  "change schema structure (type, requiredness, enum)",
  "use generated documentation or mocks as authoritative evidence",
];

export interface OpenCaseOptions {
  /** Root the `cases/` dir is created under (default `.refinement`). */
  root?: string;
  /** Repository scopes the executor may inspect (resolved within the repo root). */
  inspect?: string[];
  /** The repository root scopes resolve against and must stay within (default cwd). */
  repositoryRoot?: string;
  repositoryRevision?: string;
  /** Identity of the executor this run is opened for (recorded in run.json). */
  executor?: string;
  /** Injectable clock (ms) for reproducible run ids in tests. */
  now?: number;
  /**
   * What to do if the computed run directory already exists and is populated.
   * `reject` (default) refuses — a new run never silently consumes stale output;
   * `resume` reuses it; `replace` clears its `output/` and rewrites the inputs.
   */
  onExisting?: "reject" | "resume" | "replace";
}

export interface MaterializedCase {
  caseId: string;
  /** The case key `<skill>--<target-key>` (stable across runs). */
  caseKey: string;
  runId: string;
  dir: string;
  skill: RefinementSkill;
  context: SkillContext;
  identity: RunIdentity;
  workspace: CaseWorkspace;
  task: CaseTask;
  target: CaseTargetDoc;
  policy: EvidencePolicyDoc;
  tools: AllowedToolsDoc;
  procedure: InvestigationProcedure;
}

/** A filesystem-safe id for a case: `${skill}--${targetKey}` with unsafe chars folded. */
export function caseId(skill: string, deficiencyTargetKey: string): string {
  return `${skill}--${deficiencyTargetKey}`.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function buildTargetDoc(context: SkillContext, priorEvidence: Claim[]): CaseTargetDoc {
  const t = context.target;
  const doc: CaseTargetDoc = {
    target: t,
    key: targetKey(t),
    describe: describeTarget(t),
    priorEvidence,
  };
  if (context.operation) {
    doc.operationId = context.operation.id;
    doc.operationName = context.operation.canonicalName;
    doc.operationEffect = context.operation.effect.kind;
  }
  if (context.field) {
    const f = context.field;
    doc.field = {
      path: f.path,
      name: f.name,
      required: f.required,
      type: f.schema.type as string | undefined,
      enumValues: f.enumValues as CaseFieldFacts["enumValues"],
      existingDescription: f.description,
      example: f.example as CaseFieldFacts["example"],
    };
  }
  if (context.siblingFields) {
    doc.siblingFields = context.siblingFields.map((f) => ({
      name: f.name,
      description: f.description,
    }));
  }
  if (t.kind === "error") doc.errorCode = t.code;
  return doc;
}

function buildPolicyDoc(skill: RefinementSkill): EvidencePolicyDoc {
  return {
    allowedSources: skill.evidence.allowed,
    minimumStrength: skill.evidence.minimumStrength,
    writablePredicates: skill.output.predicates,
    supportingPredicates: SUPPORTING_PREDICATES[skill.name] ?? [],
    writableFields: skill.output.fields,
    constraints: skill.constraints,
    mustNot: skill.constraints.map((c) => CONSTRAINT_PROSE[c]),
  };
}

function buildToolsDoc(workspace: CaseWorkspace): AllowedToolsDoc {
  return { workspace, helpers: CASE_HELPERS, deny: BASE_DENY };
}

/* -------------------------------------------------------------------------- */
/* CASE.md — short and procedural                                             */
/* -------------------------------------------------------------------------- */

function renderBrief(
  task: CaseTask,
  target: CaseTargetDoc,
  policy: EvidencePolicyDoc,
  tools: AllowedToolsDoc,
  proc: InvestigationProcedure,
): string {
  const lines: string[] = [];
  lines.push(`# Case: ${task.caseId}`);
  lines.push("");
  lines.push(task.question);
  lines.push("");
  lines.push(`**Target** — ${target.describe} (\`${target.key}\`)`);
  lines.push(`**Deficiency** — \`${task.deficiency}\` (${task.severity})`);
  lines.push("");

  lines.push(`You may inspect (read-only, within ${tools.workspace.repositoryRoot}):`);
  for (const s of tools.workspace.inspectScopes.length
    ? tools.workspace.inspectScopes
    : ["(the relevant repository, as you plan)"]) {
    lines.push(`- ${s}`);
  }
  lines.push("");
  lines.push("You may not:");
  for (const d of [...tools.deny, ...policy.mustNot]) lines.push(`- ${d}`);
  lines.push("");

  lines.push("Admissible evidence:");
  lines.push(
    `- sources: ${policy.allowedSources.join(", ")} — minimum aggregate strength **${policy.minimumStrength}**`,
  );
  lines.push(
    `- you may write only: ${policy.writableFields.map((f) => `\`${f}\``).join(", ") || "(nothing)"}`,
  );
  lines.push("");

  lines.push("## Method");
  lines.push("Work in phases; keep each phase's output separate and machine-readable.");
  let currentPhase = "";
  for (const step of proc.steps) {
    if (step.phase !== currentPhase) {
      currentPhase = step.phase;
      lines.push("");
      lines.push(`### ${PHASE_ROLE[step.phase]} → \`${CASE_OUTPUT[step.phase]}\``);
    }
    lines.push(`- ${step.instruction}`);
  }
  lines.push("");

  lines.push("## Plan your own retrieval");
  lines.push("Start from these angles, then navigate — do not wait to be handed context:");
  for (const h of proc.searchHints) lines.push(`- ${h}`);
  lines.push("");

  lines.push("## Produce");
  for (const p of task.produce) lines.push(`- ${p}`);
  lines.push("");
  lines.push(
    "`output/proposal.json` is required only when the evidence supports one. It is honest — and often correct — to finalize with **no proposal**:",
  );
  lines.push(
    "- `supported` · `conflicted` · `insufficient_evidence` · `blocked_by_missing_source` · `proposal_generated`",
  );
  lines.push("");
  lines.push("Anvil validates, measures, and reconciles what you emit. You never edit AIR.");
  lines.push("Use the helper commands (`anvil case ...`) instead of hand-writing large JSON.");
  return `${lines.join("\n")}\n`;
}

/* -------------------------------------------------------------------------- */
/* openCase                                                                   */
/* -------------------------------------------------------------------------- */

function writeJson(dir: string, rel: string, value: unknown): void {
  const full = join(dir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * Materialise a case for one deficiency: an isolated directory the executor works
 * inside. Reads AIR only to assemble the target's facts and prior evidence; never
 * mutates it. Throws if the deficiency has no implemented skill (there is nothing
 * to investigate against).
 */
export function openCase(
  air: AirDocument,
  deficiency: Deficiency,
  options: OpenCaseOptions = {},
): MaterializedCase {
  const skill = skillFor(deficiency.code);
  if (!skill) {
    throw new Error(
      `No skill implements deficiency '${deficiency.code}'; cannot open a case for it.`,
    );
  }
  const root = options.root ?? ".refinement";
  const prior = evidenceForTarget(air, deficiency);
  const context = assembleContext(air, deficiency, prior);
  const proc = procedureFor(skill);
  const caseKey = caseId(skill.name, targetKey(deficiency.target));

  // Containment: resolve inspect scopes within an explicit repository root, rejecting
  // any that escape it. The repository is read-only; the case dir is the only writable place.
  const workspace = resolveWorkspace({
    repositoryRoot: options.repositoryRoot,
    repositoryRevision: options.repositoryRevision,
    inspect: options.inspect,
  });
  const policy = buildPolicyDoc(skill);

  // Immutable run: a fresh, content+time-addressed run directory per open. A new run
  // never silently consumes a previous run's output.
  const identity = buildRunIdentity({
    caseKey,
    air,
    skillVersion: skill.version,
    policy,
    executor: options.executor,
    repositoryRevision: workspace.repositoryRevision,
    now: options.now,
  });
  const dir = join(root, "cases", caseKey, identity.runId);
  const task = buildTask(caseKey, skill, deficiency, proc);
  const targetDoc = buildTargetDoc(context, prior);
  const tools = buildToolsDoc(workspace);
  const materialized: MaterializedCase = {
    caseId: caseKey,
    caseKey,
    runId: identity.runId,
    dir,
    skill,
    context,
    identity,
    workspace,
    task,
    target: targetDoc,
    policy,
    tools,
    procedure: proc,
  };

  const onExisting = options.onExisting ?? "reject";
  if (isPopulatedRun(dir)) {
    if (onExisting === "reject") {
      throw new Error(
        `Run '${dir}' already exists. Pass onExisting: 'resume' to reuse it or 'replace' to overwrite — a new run never consumes stale output implicitly.`,
      );
    }
    // Resume reuses the run as-is; only replace rewrites the canonical inputs + views.
    if (onExisting === "resume") return materialized;
    if (onExisting === "replace") rmSync(join(dir, "output"), { recursive: true, force: true });
  }

  // The one canonical document; CASE.md and expected-output.schema.json are views of it.
  const doc = buildCaseDocument(materialized, deficiency);
  mkdirSync(join(dir, "workspace"), { recursive: true });
  mkdirSync(join(dir, "output"), { recursive: true });
  writeFileSync(join(dir, "workspace", ".gitkeep"), "", "utf8");
  writeFileSync(join(dir, "output", ".gitkeep"), "", "utf8");
  writeJson(dir, CASE_FILES.doc, doc);
  writeJson(dir, CASE_FILES.expectedSchema, doc.expectedOutput);
  writeFileSync(
    join(dir, CASE_FILES.brief),
    renderBrief(task, targetDoc, policy, tools, proc),
    "utf8",
  );

  return materialized;
}

/** A run directory that already carries its canonical input document (a real prior run). */
function isPopulatedRun(dir: string): boolean {
  return existsSync(join(dir, CASE_FILES.doc));
}

/** Assemble the canonical `case.json` from the materialised parts. */
function buildCaseDocument(m: MaterializedCase, deficiency: Deficiency): CaseDocument {
  return {
    version: 1,
    identity: m.identity,
    task: m.task,
    target: m.target,
    workspace: m.workspace,
    skill: { name: m.skill.name, version: m.skill.version },
    policy: m.policy,
    tools: { helpers: m.tools.helpers, deny: m.tools.deny },
    procedure: {
      skill: m.procedure.skill,
      question: m.procedure.question(deficiency.target),
      searchHints: m.procedure.searchHints,
      steps: m.procedure.steps.map((s) => ({ phase: s.phase, instruction: s.instruction })),
    },
    expectedOutput: expectedOutputSchema({
      skill: m.skill.name,
      skillVersion: m.skill.version,
      deficiency: deficiency.code,
      target: deficiency.target,
      writableFields: m.policy.writableFields,
    }),
  };
}

function buildTask(
  caseKey: string,
  skill: RefinementSkill,
  deficiency: Deficiency,
  proc: InvestigationProcedure,
): CaseTask {
  return {
    caseId: caseKey,
    skill: skill.name,
    skillVersion: skill.version,
    deficiency: deficiency.code,
    severity: deficiency.severity,
    question: proc.question(deficiency.target),
    produce: [
      CASE_OUTPUT.research,
      CASE_OUTPUT.extract,
      CASE_OUTPUT.synthesize,
      CASE_OUTPUT.critique,
      CASE_OUTPUT.test,
    ],
    phases: proc.steps.reduce<CaseTask["phases"]>((acc, s) => {
      if (!acc.includes(s.phase)) acc.push(s.phase);
      return acc;
    }, []),
  };
}
