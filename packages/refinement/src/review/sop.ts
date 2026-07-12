import { DEFICIENCY_CATALOG, SEVERITIES } from "../deficiency.js";

/**
 * Generate the **artifact-review SOP** — the progressive-disclosure instruction
 * package a cheap reviewer model (Haiku-class) follows when judging a generated
 * bundle's semantic layer. Like `generateRefinementSkill`, it is produced from
 * code (and from the live deficiency catalog) so the manual the reviewer reads
 * can never drift from the codes the machinery accepts.
 *
 * The SOP is *specialized per artifact class*: MCP tool surface, CLI surface,
 * skill doc, and cross-surface agreement each get their own checklist, because
 * "is this description truthful?" means something different on each surface.
 *
 * Levels: L0 `SKILL.md` (role, invariant, read order) → L1 one reference per
 * artifact class → L2 severity rubric + deficiency-code mapping → L3 the exact
 * output contract with calibration examples.
 */
export function generateReviewSop(): Record<string, string> {
  return {
    "SKILL.md": skillMd(),
    "reference/mcp-surface.md": mcpSurfaceRef(),
    "reference/cli-surface.md": cliSurfaceRef(),
    "reference/skill-surface.md": skillSurfaceRef(),
    "reference/cross-surface.md": crossSurfaceRef(),
    "reference/severity-and-codes.md": severityAndCodesRef(),
    "reference/output-contract.md": outputContractRef(),
  };
}

/* -------------------------------------------------------------------------- */
/* L0 — SKILL.md                                                              */
/* -------------------------------------------------------------------------- */

function skillMd(): string {
  return `---
name: artifact-review
description: Use this SOP to review the semantic layer of an Anvil-generated bundle — whether the MCP tool surface, CLI surface, and skill doc are truthful to the AIR model and teach its safety posture correctly. Every finding must cite verbatim evidence; findings without verifiable evidence are discarded.
---

# Reviewing an Anvil bundle's agent surfaces

Anvil compiles one model (AIR) into three aligned surfaces: a CLI, an MCP
server, and a skill package. Deterministic gates already check structure. Your
job is the layer no deterministic check can judge: **is the text an agent will
read truthful, distinct, and safe to act on?** A tool description that reads
like a query on a destructive mutation passes every schema check and still gets
someone's data deleted.

You are a **witness, not an authority**. You point at offending text; Anvil's
deterministic core verifies your citations, converts your findings into its
deficiency machinery, and discards anything you cannot ground.

## The one invariant: no evidence, no finding
Every finding MUST quote the offending text verbatim (\`evidence.excerpt\`) and
name the bundle-relative file it appears in (\`evidence.file\`). The pipeline
mechanically re-checks the quote against the file; **a finding whose excerpt
does not appear in the named file is discarded and counted against you**. A
discarded finding is worse than no finding. Never paraphrase inside
\`evidence.excerpt\`; paraphrase belongs in \`claim\`.

## What is authoritative
The AIR classifications in \`catalog.json\` / \`air.json\` — \`effect\`, \`action\`,
\`risk\`, \`reversible\`, \`idempotency\`, \`retrySafe\`, \`confirmationRequired\`,
\`state\` — are the ground truth about what an operation *is*. Free text
(descriptions, docs, the skill) must agree with them. When free text and
classification disagree, the finding is about the text, judged against the
classification. You never propose changing a classification.

## Read order
1. \`context/catalog.json\` — the operation index: every operation's names
   (CLI command, MCP tool), description, and safety classification. Build your
   mental table of operations from this FIRST, noting which are \`approved\`
   (only approved operations are exposed; concentrate there).
2. \`context/air.json\` — the input contracts (required params/fields) for the
   operations you will check schemas against.
3. \`context/skill/SKILL.md\` and \`context/skill/reference/*\` — the taught surface.
4. \`context/docs/*\` — the human/CLI-facing docs.
5. \`context/schemas/*.schema.json\` — the per-operation input schemas the MCP
   tools validate against.

Then work the four checklists, one artifact class at a time:
- \`reference/mcp-surface.md\` — tool names, descriptions, input schemas.
- \`reference/cli-surface.md\` — commands, safety flags, examples.
- \`reference/skill-surface.md\` — the skill doc's safety teaching and honesty.
- \`reference/cross-surface.md\` — the three surfaces must agree.

## Restraint is part of the job
Report defects the checklists name, at the severity the rubric assigns
(\`reference/severity-and-codes.md\`). Do not report style preferences, missing
niceties the checklists do not name, or the same defect once per surface (one
finding per defect; use \`artifact: "cross"\` when the defect IS the
disagreement). When you are not sure the text would mislead an agent, prefer
no finding. An empty \`findings\` array is a valid, honest review.

## Output
Write STRICT JSON to \`output/review.json\` matching
\`reference/output-contract.md\` exactly. No prose outside the JSON. Do not
modify any other file.
`;
}

/* -------------------------------------------------------------------------- */
/* L1 — per-artifact-class checklists                                         */
/* -------------------------------------------------------------------------- */

function mcpSurfaceRef(): string {
  return `# MCP tool surface

What an agent sees per tool: the tool name (\`mcpTool\` in catalog.json), a
description seeded from the operation's \`description\`, and an input schema
projected from AIR (\`schemas/<operation-id>.schema.json\`).

**Mechanical context you must account for:** at serve time the runtime appends
deterministic safety suffixes to every tool description from the AIR flags —
"This is a[n irreversible] <risk> mutation.", "Requires an idempotency key.",
"Requires confirm=true.", "Retry-safe."/"Not retry-safe.", or "Read-only.".
Do NOT report a missing suffix; that is generated. Your subject is the seed
\`description\` text itself and whether it tells the truth *before* the suffix
arrives — agents skim, and a first sentence that misleads is not rescued by a
trailing disclaimer.

## Checklist
1. **Effect truthfulness** — a \`mutation\` must read as an action with a
   consequence. A mutation whose description opens like a lookup ("Retrieves…",
   "Returns…", "Lists…", "Gets…") is a safety-semantic contradiction →
   \`contested_safety_semantic\`, severity per the rubric (usually \`blocking\`
   for irreversible/high-risk, \`high\` otherwise). Symmetrically, a \`read\`
   described as if it changes state misleads agents into over-caution →
   \`cross_surface_disagreement\` is NOT the code; use
   \`contested_safety_semantic\` only for safety direction, otherwise
   \`missing_operation_description\`/\`weak_operation_name\` per fit.
2. **Risk visibility** — for an irreversible or high/financial-risk mutation,
   the description text must let a reader infer the consequence ("permanently
   deletes", "charges the customer"). A neutral description on a destructive
   operation that hides what is at stake → \`confirmation_posture_incomplete\`.
3. **Name conventions** — the tool name must be derived from the canonical
   name (snake_case, typically \`<service>_<canonical_name>\`), and must not
   contradict the effect (a mutation named \`get_*\` misroutes) →
   \`weak_operation_name\`.
4. **Input contract fidelity** — the schema's \`required\` array must match the
   AIR input contract (required params + required body fields in \`air.json\`).
   A required field missing from the schema, or a phantom required field →
   \`cross_surface_disagreement\` with evidence from the schema file.
5. **Distinctness** — sibling tools an agent must choose between need
   descriptions that distinguish them → \`indistinct_operation_descriptions\`.
6. **Vacancy** — an empty description, or one that restates the name and adds
   nothing → \`missing_operation_description\` / \`weak_operation_name\`.

Evidence for this surface: quote from \`catalog.json\` (use \`path\` like
\`operations[3].description\`), \`air.json\`, or \`schemas/<op>.schema.json\`.
`;
}

function cliSurfaceRef(): string {
  return `# CLI surface

What an operator/agent sees: the command coordinate per operation (\`cli\` in
catalog.json), the docs (\`docs/README.md\`, \`docs/OPERATIONS.md\`), and worked
examples. The generated CLI engine mechanically *enforces* \`--confirm\`,
\`--idempotency-key\`, and \`--dry-run\` on mutating commands; your subject is
whether the documented surface **teaches** that posture truthfully — an agent
reading the docs must not be surprised by a refusal, and must never believe a
destructive command is casual.

## Checklist
1. **Command truthfulness** — the command phrase must not contradict the
   effect. A mutation living under a command that reads like a query (e.g.
   \`svc account get\` performing a delete) → \`contested_safety_semantic\`.
2. **Safety flags taught on mutating commands** — docs/examples for a
   confirmation-required mutation must show \`--confirm\` (and
   \`--idempotency-key\` where the mode requires one, \`--dry-run\` as the
   preview). A doc example that invokes a risky mutation bare →
   \`confirmation_posture_incomplete\`, citing the example text.
3. **Examples runnable in principle** — an example must name a real command
   from the catalog with plausibly-shaped arguments. An example for a command
   that does not exist → \`phantom_operation_documented\`.
4. **Safety table honesty** — \`docs/OPERATIONS.md\` rows (effect, risk,
   idempotency, confirm) must match catalog.json for the same operation; a
   contradicting row → \`cross_surface_disagreement\` (or
   \`contested_safety_semantic\` when the disagreement is about safety).
5. **Exposure honesty** — docs must not present non-\`approved\` operations as
   callable → \`cross_surface_disagreement\`.

Evidence: quote from \`docs/*\` or \`catalog.json\`.
`;
}

function skillSurfaceRef(): string {
  return `# Skill doc surface

The skill package (\`skill/SKILL.md\` + \`skill/reference/*\` + \`skill/examples/*\`)
is the operating manual an agent loads before touching the API. It is the
highest-leverage surface: an error here becomes agent behavior.

## Checklist
1. **Safety posture taught correctly.** The skill must convey Anvil's contract:
   - only approved operations are exposed;
   - unsafe mutations refuse to run without \`--confirm\` (and that refusal is
     correct behavior, not an obstacle to route around);
   - non-idempotent mutations are NEVER retried automatically — the skill must
     not advise retrying writes;
   - idempotency keys: same key = safe replay, new key = new operation.
   A skill that omits, inverts, or waters down any of these (e.g. "you can
   safely re-run this command if it fails" on a non-retry-safe mutation, or
   "pass --confirm by default to avoid prompts") →
   \`confirmation_posture_incomplete\` (confirmation/retry teaching) with the
   offending or conspicuously-absent-context text quoted.
2. **No phantom operations.** Every operation, command, or tool the skill
   documents must exist in catalog.json (match by CLI command, MCP tool name,
   or operation id). A documented operation with no catalog entry →
   \`phantom_operation_documented\` (severity \`high\`+; \`blocking\` if the
   phantom is described as destructive or the skill teaches calling it in a
   workflow).
3. **Exposure honesty.** The skill documents the *approved* surface. Teaching a
   non-approved operation as callable → \`cross_surface_disagreement\`.
4. **Examples match real operations.** \`skill/examples/*\` and inline examples
   must reference real operations with inputs shaped like the schema; a
   contradiction → \`cross_surface_disagreement\`.
5. **Progressive disclosure intact.** SKILL.md stays a small router (what/when,
   safety rules, where to look) and defers detail to \`reference/*\`. A SKILL.md
   that inlines the entire catalog, or reference files that contradict
   SKILL.md → \`schema_too_large_for_disclosure\` (info) for bloat,
   \`cross_surface_disagreement\` for contradiction.
6. **Routing phrases.** Capabilities/operations the skill indexes should carry
   intent phrasing an agent can match a request against; absence →
   \`operation_lacks_intent_examples\` / \`capability_missing_routing_phrases\`
   (low — mention only when clearly absent, not merely thin).

Evidence: quote from \`skill/SKILL.md\`, \`skill/reference/*\`, or
\`skill/examples/*\`.
`;
}

function crossSurfaceRef(): string {
  return `# Cross-surface agreement

Anvil's core promise: the CLI command, the MCP tool, and the skill doc agree
about what each operation *means*. All three are generated from one model, so a
disagreement is a serious defect wherever it appears.

## Checklist
1. For each approved operation, line up its catalog row, its schema, its
   docs/OPERATIONS.md row, and every mention in the skill package. Meaning
   (what it does), effect posture (mutation vs read, risk, confirm,
   idempotency, retry), and identity (names) must agree.
2. A disagreement about a **safety semantic** (one surface says confirm/
   destructive/not-retryable, another implies otherwise) →
   \`contested_safety_semantic\` (blocking).
3. A disagreement about **meaning or identity** (descriptions of the same
   operation say different things; a name on one surface points at a different
   operation's semantics) → \`cross_surface_disagreement\` (high).
4. An operation present on one surface and absent from the authoritative
   catalog → \`phantom_operation_documented\`.

File a cross finding ONCE with \`artifact: "cross"\`, quoting the single most
probative excerpt and naming the other coordinate in \`claim\` (e.g. "skill
reference says X; catalog.json operations[2].description says Y"). Do not also
file per-surface duplicates of the same disagreement.
`;
}

/* -------------------------------------------------------------------------- */
/* L2 — severity rubric + code mapping (generated from the live catalog)      */
/* -------------------------------------------------------------------------- */

/** The review-facing meaning of each severity, in catalog order. */
const SEVERITY_RUBRIC: Record<(typeof SEVERITIES)[number], string> = {
  info: "polish; an agent is not misled, just under-served (e.g. disclosure bloat)",
  low: "friction; the agent works harder but lands right (thin examples, weak naming)",
  medium: "the agent must guess (vague/undocumented behavior it will fill in wrongly)",
  high: "the agent will likely act wrongly (misroute, call a phantom, wrong required fields)",
  blocking:
    "an agent following the surface as written could trigger an unconfirmed or misunderstood destructive effect",
};

function severityAndCodesRef(): string {
  const rubric = SEVERITIES.map((s) => `- **${s}** — ${SEVERITY_RUBRIC[s]}`).join("\n");
  const catalog = Object.values(DEFICIENCY_CATALOG)
    .slice()
    .sort((a, b) => a.category.localeCompare(b.category) || a.code.localeCompare(b.code))
    .map((d) => `| \`${d.code}\` | ${d.category} | ${d.defaultSeverity} | ${d.agentImpact} |`)
    .join("\n");
  return `# Severity rubric and deficiency codes

## Severity (choose by agent consequence, not by how offended you are)
${rubric}

Note: conversion into Anvil's deficiency machinery never *lowers* a severity
below the code's catalog default — pick the code first, then only raise.

## Symptom → code mapping
Use the FIRST row that fits. A finding must cite one of the catalog codes
below; a code not in the catalog fails to parse and voids the finding.

| Symptom on the reviewed surface | code |
| --- | --- |
| free text contradicts a safety classification (mutation reads as query; retry/confirm/destructiveness contradicted between text and classification or between surfaces) | \`contested_safety_semantic\` |
| confirmation/consequence not conveyed where the posture requires it (destructive op with consequence-free text; doc/skill example invoking a risky mutation bare; retry/confirm teaching missing or inverted) | \`confirmation_posture_incomplete\` |
| a documented operation/command/tool does not exist in the catalog | \`phantom_operation_documented\` |
| surfaces disagree about a non-safety meaning, identity, or contract (incl. schema required-fields vs AIR, docs teaching unapproved ops) | \`cross_surface_disagreement\` |
| description empty or effectively absent | \`missing_operation_description\` |
| name/description restates the name, or name misleads about intent | \`weak_operation_name\` |
| sibling operations indistinguishable by description | \`indistinct_operation_descriptions\` |
| no intent phrases to route a request by | \`operation_lacks_intent_examples\` / \`capability_missing_routing_phrases\` |
| error semantics undocumented on the surface | \`undocumented_error\` |
| pagination behavior undocumented on the surface | \`undocumented_pagination\` |
| field/enum meaning opaque in schema or docs | \`missing_field_description\` / \`opaque_enum_values\` |
| examples missing for required inputs / not runnable in principle | \`required_field_no_example\` |
| SKILL.md bloated beyond a router (disclosure cost, nothing untrue) | \`schema_too_large_for_disclosure\` |

If a real defect fits no row, do NOT invent a code — describe it in
\`reviewerNotes\` instead. New codes enter only via the deficiency catalog.

## The full catalog (for reference)
| code | category | default severity | agent impact |
| --- | --- | --- | --- |
${catalog}
`;
}

/* -------------------------------------------------------------------------- */
/* L3 — the output contract + calibration                                     */
/* -------------------------------------------------------------------------- */

function outputContractRef(): string {
  return `# Output contract

Write STRICT JSON to \`output/review.json\`. No markdown fences, no prose before
or after, no fields beyond these. Unknown fields, unknown codes, or a finding
without evidence make the whole output unparseable.

\`\`\`json
{
  "findings": [
    {
      "id": "f1",
      "artifact": "mcp",
      "opId": "acct.accounts.delete",
      "code": "contested_safety_semantic",
      "severity": "blocking",
      "evidence": {
        "file": "catalog.json",
        "path": "operations[2].description",
        "excerpt": "Retrieves the account record."
      },
      "claim": "The delete_account tool is an irreversible high-risk mutation (effect=mutation, risk=high, reversible=false) but its description reads like a read-only lookup.",
      "suggestion": "Describe the effect: 'Permanently deletes the account and all associated data.'"
    }
  ],
  "reviewerNotes": "optional free text; anything that fits no code goes here"
}
\`\`\`

## Field rules
- \`id\` — unique per finding (\`f1\`, \`f2\`, …).
- \`artifact\` — \`"mcp"\` | \`"cli"\` | \`"skill"\` | \`"cross"\`.
- \`opId\` — the AIR operation id from catalog.json when the finding is about
  one operation. OMIT it for service-level findings. An \`opId\` that does not
  exist in the bundle voids the finding.
- \`code\` — a catalog code from \`reference/severity-and-codes.md\`.
- \`evidence.file\` — the bundle-relative path exactly as shown under
  \`context/\` (write \`catalog.json\`, not \`context/catalog.json\`).
- \`evidence.excerpt\` — VERBATIM text copied from that file, 8–2000 chars,
  long enough to be unambiguous (a full sentence or JSON value, not a word).
- \`claim\` — the defect, stated so a colleague could verify it against the
  evidence and the catalog row.

## Calibration examples

**Worked finding — flawed mutation description (mcp):** catalog.json shows
\`"effect": "mutation", "risk": "high", "reversible": false\` for an operation
whose description is "Retrieves the account record." → file the example above.
The classification is authoritative; the text is the defect.

**Worked finding — phantom operation (skill):** skill/SKILL.md contains
"Run \`acct purge-all\` to clear test data." but no catalog operation has that
CLI command or any similar id. → \`{"artifact":"skill","code":
"phantom_operation_documented","severity":"high","evidence":{"file":
"skill/SKILL.md","excerpt":"Run \`acct purge-all\` to clear test data."},
"claim":"SKILL.md documents a purge-all command that exists on no surface of
this bundle; catalog.json lists no such operation."}\` (no \`opId\` — the
operation does not exist).

**Worked finding — missing confirm teaching (cli):** docs/OPERATIONS.md marks
\`acct accounts delete\` as Confirm=yes, but docs/README.md's example section
shows \`acct accounts delete --id 42\` with no \`--confirm\` and no mention that
the command will refuse. → \`confirmation_posture_incomplete\`, artifact
\`"cli"\`, quoting the bare example line, \`opId\` set.

**Non-finding (restraint):** a read-only operation's description is one short
but accurate sentence ("Lists accounts for the current project."), and the
checklists ask for truthfulness and distinctness, both satisfied. Brevity
alone is NOT a finding — file nothing. If everything is like this, return
\`{"findings": []}\` and say so in \`reviewerNotes\`.
`;
}
