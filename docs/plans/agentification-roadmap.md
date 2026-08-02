# Agentification roadmap — execution specs

Five phases that convert Anvil's weakest agentification areas into working
capability. Each phase section is written to be executable by a small-model
agent without architectural judgment: exact files, the existing pattern to
mirror, acceptance criteria, and verification commands. The architectural
decisions are made *here*; the executing agent's job is faithful mechanics.

## Global rules (every phase, non-negotiable)

1. **Read before writing.** Every slice lists "read first" files. Read them
   completely before editing anything — the codebase's conventions (comment
   density, naming, test fixture shapes) must be matched, not approximated.
2. **Asymmetric trust is never weakened.** No new code path may auto-approve
   a safety-loosening change or invent business logic without evidence. When
   in doubt, route to `review`/`review_required` — a false review is cheap,
   a false auto-approval is not.
3. **The three surfaces stay in agreement.** Anything that changes what an
   operation means must flow from AIR through the generators — never patch
   one surface directly.
4. **Every behavior change gets a test in the same style as its neighbors.**
   Copy the fixture/assert idioms of the closest existing test file.
5. **Formatting**: run `npx biome check --write <changed files>` before
   finishing. **Verification**: run the commands listed in the slice; all
   must pass. Do not mark a slice done with a failing check.
6. **Generated docs**: if a change affects `anvil skill` / `anvil refine
   skill` output, rebuild the changed package AND `@anvil/cli`
   (`pnpm --filter <pkg> build && pnpm --filter @anvil/cli build`), then
   regenerate (`node packages/cli/dist/bin-anvil.js refine skill
   skills/refinement`), or the drift-guard tests will fail. When a
   drift-guard diff looks backwards, remember: vitest labels the `expect()`
   argument "Received" — the stale checked-in file — and the `.toBe()`
   argument "Expected".
7. **Scope discipline.** Each slice's "out of scope" list is binding. Do not
   refactor adjacent code, rename existing symbols, or "improve" things the
   slice doesn't name.

---

## Phase 1 — LLM harness agent (light up the vacant intelligence seam)

**Why**: `HarnessAgent` (`packages/harness/src/agent.ts:60`) was explicitly
designed pluggable "so a real LLM agent (Claude Code, Codex) can replace the
built-in heuristic without touching orchestration" — but only the four-regex
`HeuristicHarnessAgent` ships. The validation/reconciliation rails
(`reconcile.ts` thresholds, conflict gate) already make an unreliable
extractor safe to use; the seam is simply vacant.

**Design (decided, do not revisit)**:
- New file `packages/harness/src/llm-agent.ts`: `AgentCliHarnessAgent
  implements HarnessAgent`, `readonly name = "agent-cli"`.
- **Same orchestration as the heuristic**: pick the search tool with
  `pickSearchTool`, call `input.source.call(tool, { query })` exactly as
  `HeuristicHarnessAgent.probe` does. The LLM's only job is replacing the
  regex *extraction* over the returned text — it never chooses tools and
  never sees credentials.
- Extraction: build a prompt containing the operation summary (id,
  canonicalName, method+path, effect kind) and the source text, instructing
  the model to emit ONLY a JSON array of
  `{ predicate, value, direction, quote }` where `predicate` ∈
  `"idempotency.mode" | "deprecated" | "errors.rate_limited" | "description"`,
  `direction` ∈ `"tighten" | "loosen"`, and `quote` is a VERBATIM substring
  of the source text supporting the claim.
- Run the model via `AgentProcessRunner` (imported from
  `@anvil/refinement` — it is exported via `case/index.ts:38`), defaulting
  to command `claude`, args `["-p"]`, prompt on stdin, with
  `allowlistedEnv` and a timeout. Constructor accepts
  `{ runner?, command?, args?, timeoutMs? }` so tests inject a fake runner.
- Parse stdout with a zod schema. **Discard mechanically** any entry whose
  `quote` is not a literal substring of the source text (same rule as
  `anvil review`'s "ungrounded findings are discarded mechanically").
- **Trust mapping (the safety-critical part)**: the model widens *recall*,
  never *trust*. Confidence/reliability on emitted claims comes ONLY from
  the source profile (`profileFor(...).floor`, or `.strong` when the strong
  marker — a verbatim `Idempotency-Key` quote — is present), exactly
  mirroring `HeuristicHarnessAgent`. The model's own numbers are never
  used. Loosening claims therefore still cannot clear `LOOSEN_THRESHOLD`
  from a docs-class source, no matter what the model says.
- Any runner failure, timeout, non-JSON output, or schema mismatch →
  return `[]` (fail closed to "no findings", never throw).
- CLI: `anvil enrich` gains `--agent <name>` (`heuristic` default,
  `agent-cli` opt-in), `--agent-command <bin>`, `--agent-timeout <ms>`.
  Wire through `runEnrichment`'s existing `options.agent`.

**Read first**: `packages/harness/src/agent.ts`, `reconcile.ts`,
`profiles.ts`, `packages/refinement/src/case/process-runner.ts`,
`packages/cli/src/commands/enrich.ts`, `packages/harness/src/harness.test.ts`.

**Tests** (`packages/harness/src/llm-agent.test.ts`): fake runner returning
canned JSON → findings produced with profile-derived confidence; entry with
fabricated quote → dropped; malformed JSON → `[]`; timeout result → `[]`;
loosen claim from a docs-class source stays below `LOOSEN_THRESHOLD` end to
end through `reconcile`.

**Out of scope**: changing `HeuristicHarnessAgent`, `reconcile.ts`,
thresholds, or making `agent-cli` the default.

**Verify**: `pnpm --filter @anvil/harness typecheck && pnpm --filter
@anvil/harness test && pnpm --filter @anvil/cli typecheck`.

---

## Phase 2 — interaction archetypes + classify-pagination + wire the dead fields

**Why**: `streaming`, `longRunning`, and `action: "search"` exist in AIR and
drive nothing downstream (verified: zero references in generators,
mcp-runtime, runtime). `Operation.pagination` is fully typed
(`schema.ts:651`) with a detector (`undocumented_pagination`,
`detect.ts:334`) and no skill closing it. Agents fail differently on search
vs. transactional vs. long-running operations; the toolchain must say so.

### Slice 2a — `interactionArchetype` on AIR + compiler classification

- `packages/air/src/enums.ts`: add `InteractionArchetype = z.enum([
  "transaction", "search", "query_passthrough", "long_running", "bulk",
  "file_transfer"])` with a doc comment per member (follow the enum doc
  style at `enums.ts:60-108`).
- `packages/air/src/schema.ts`: add optional `archetype:
  InteractionArchetype.optional()` to `Operation` (absent = unclassified;
  never default it).
- `packages/compiler/src/classify.ts`: after the existing effect/action
  classification, set archetype deterministically: `longRunning === true` →
  `long_running`; `effect.kind === "read"` and action `search`/`list` →
  `search`; `effect.kind === "mutation"` → `transaction`. Leave others
  unset. (`query_passthrough` assignment arrives in Phase 3 — do NOT
  attempt its detection here.)
- Tests in the compiler's existing classify test file style.

**Out of scope**: any generator/runtime consumption (that's 2c), bulk/file
heuristics.

### Slice 2b — `classify-pagination` refinement skill

Mirror `classify-idempotency` end to end — it is the worked example and the
checklist below is exactly the set of files that change (learned the hard
way). **First read `packages/refinement/src/deficiency.ts` and use the exact
`suggestedSkill` name the catalog already gives `undocumented_pagination`
— the registry tests enforce trigger ↔ catalog agreement.**

1. `skills/registry.ts`: new skill; `targetKind: "operation"`; evidence
   `minimumStrength: "corroborated"`, `minimumVerification:
   "allow_unverified"` (pagination misclassification breaks calls but does
   not loosen retry/idempotency safety — it is not a safety semantic, so
   the classify-idempotency-grade bar would be overkill; match
   describe-field's bar instead). Output fields: `pagination_style`,
   `pagination_cursor_param`, `pagination_next_field`,
   `pagination_items_field`. Constraints: `do_not_invent_business_rules`.
2. `skills/executor.ts`: heuristic case filtering claim values to the
   `Pagination` style enum members (`cursor|page|offset|link`), free-string
   fields grounded-string-only — copy `classifyIdempotency`'s `take()`
   shape.
3. `skills/validate.ts`: new check `pagination_binding_resolves`: when
   `pagination_style` ∈ {cursor, page, offset}, a proposed
   `pagination_cursor_param` must name an existing `op.input.params` entry;
   `pagination_items_field` when proposed must be a non-empty string. Add
   the check id to `skills/contract.ts`'s `ValidationCheckId`,
   `case/schema.ts`'s zod enum, and `skilldoc.ts`'s `CHECK_DOC`.
4. `apply.ts`: extend the `"operation"` case with write paths for the four
   `pagination_*` keys onto `op.pagination` (create the object if absent),
   recording `SemanticChange`s — copy the idempotency block's shape.
5. **No new auto-approval rule.** `classifyApproval` falls through to its
   default review tier for unknown skills; leave it that way.
6. Test updates (this exact list, from the classify-idempotency
   experience): `refinement.test.ts` `expectedImplemented`,
   `assess.test.ts` remediation string, `apply.test.ts` write-path tests,
   `skills/skills.test.ts` end-to-end block (valid proposal validates; no
   admissible evidence → null; cursor style naming a nonexistent param →
   rejected by `pagination_binding_resolves`),
   `packages/cli/src/commands/refine.bugbash.test.ts` skill-name list.
7. Rebuild refinement + cli, regenerate `skills/refinement` (global rule 6).

### Slice 2c — surface archetype/pagination/long-running in generated output

- **Do not invent parameters.** `op.pagination` *names* params that already
  exist in the spec; generation teaches, it never synthesizes.
- `packages/generators/src`: locate where MCP tool descriptions and the
  skill reference docs are rendered per operation (grep for `toolName` /
  description assembly; read before editing). Append, when present:
  pagination (`paginated (cursor): pass '<cursorParam>'; items at
  '<itemsField>'`), `long-running: returns before completion; poll for
  status`, and for archetype `search` a one-line "narrow with filters
  before paging" hint. Keep wording terse and factual.
- Extend the nearest existing generator snapshot/drift tests to cover an
  operation with pagination + longRunning set.

**Verify (whole phase)**: `pnpm --filter @anvil/air test && pnpm --filter
@anvil/compiler test && pnpm --filter @anvil/refinement test && pnpm
--filter @anvil/generators test && pnpm --filter @anvil/cli test`.

---

## Phase 3 — query-language passthrough (blocked by default, templates as the safe path)

**Why**: a `POST /query { sql: string }` endpoint is today an ordinary
operation with a string field — the safety model cannot see that its real
risk is arbitrary logic injected through one parameter. The disposition
ladder and approval gating already exist; this phase makes the archetype
visible and lands raw passthrough on the conservative rung.

### Slice 3a — detection + blocking (do this first; it is the safety payload)

- `packages/refinement/src/deficiency.ts` + `detect.ts`: new deficiency
  `query_language_passthrough` (catalog disposition:
  `humanDecisionRequired`; read the catalog's existing entries and copy
  their shape). Detector: a string-typed param or body field whose name
  matches `/^(sql|query|q|jql|cql|kql|xpath|dsl|filter|where|expression)$/i`
  AND whose schema has no `enum`, no `maxLength`, and no `pattern` — i.e.
  genuinely unconstrained. Message must name the field and say why it is
  agent-hostile (arbitrary logic through one parameter).
- `packages/compiler/src/classify.ts`: same predicate assigns `archetype:
  "query_passthrough"` (extends 2a's classifier; keep the predicate in ONE
  shared helper so detector and classifier cannot drift — put it in
  `@anvil/air` next to the enums and import from both sides).
- Lint: make the compiler's validate/lint stage emit an **error-severity**
  diagnostic for a `query_passthrough` operation, so `anvil lint` exits
  non-zero and the operation cannot be approved thoughtlessly. Read how
  existing error-severity diagnostics are produced first and mirror one.
- Tests on both sides (detector fires / does not fire on a constrained
  enum param; classifier sets archetype; lint goes red).

### Slice 3b — constrained query templates (the safe alternative)

- `packages/compiler/src/manifest.ts`: new `QueryTemplateManifest` section
  (`queryTemplates: Record<name, { operation: string; template: string;
  params: Record<name, { schema, description? }>; read_only: true;
  max_rows?: number }>`). `template` uses `{param}` placeholders; every
  placeholder MUST have a matching params entry (validate with superRefine,
  mirroring `CapabilityReviewManifest`'s style; reject templates containing
  placeholders with no declaration or params never used).
- Compile step: each template produces a NEW derived operation (id
  `<baseOp>.tpl.<name>`) whose input params are the template's typed
  params, `archetype: "transaction"` removed — set `archetype: "search"`,
  `effect: { kind: "read", action: "search" }` forced (templates are
  read-only v1; a template on a mutation base op is a manifest validation
  error), state `review_required` (a person approves each template), and a
  `queryTemplate: { baseOperationId, template, targetParam }` block stored
  on the operation (add this optional field to AIR's `Operation`).
- `packages/runtime`: read the request-construction path first (where an
  operation's params become the outgoing HTTP request). When
  `op.queryTemplate` is present, render the template by substituting each
  `{param}` with the validated arg value and send the rendered string as
  the base operation's target param. Substitution is literal-value only —
  values are JSON-encoded as strings; no expression evaluation of any
  kind.
- Tests: manifest validation (orphan placeholder rejected, mutation base
  rejected), compile derivation (derived op shape, review_required), and a
  runtime rendering test through the existing runtime test harness style.

**Verify**: `pnpm --filter @anvil/air test && pnpm --filter @anvil/compiler
test && pnpm --filter @anvil/refinement test && pnpm --filter @anvil/runtime
test`.

---

## Phase 4 — token economy + envelope commonality filter

### Slice 4a — token-aware truncation with continuation guidance

- `packages/mcp-runtime/src/server.ts`: after a successful execute, if the
  serialized result text exceeds a character budget (default 50_000 chars;
  configurable via server options; disable with 0), truncate at the budget
  and append a structured marker object/text:
  `[truncated: served N of M chars. Narrow the request<, or page with
  '<cursorParam>'> ]` — including the pagination hint only when
  `op.pagination` names a cursor param (Phase 2 made that reliable).
  Truncation must never split a UTF-16 surrogate pair. The marker must be
  unmistakable as tool output, not data.
- Tests in mcp-runtime's existing test style: under-budget untouched;
  over-budget truncated with marker; pagination hint present when the op
  has pagination; budget 0 disables.

### Slice 4b — envelope commonality pre-filter in capability composition

- `packages/cli/src/capability-composition.ts` (read the candidate
  assembly around `dataPointCandidates` / `structural_leaf_overlap`
  first): compute, per leaf coordinate, the fraction of SOURCES whose
  operations carry it. A coordinate present in ≥ 80% of all sources (and
  ≥ 3 sources) is classified a **transport envelope coordinate**: excluded
  from `structural_leaf_overlap` candidate generation and reported in a
  new top-level report field `suppressedEnvelopeCoordinates: [{ pointer,
  sourceCount, memberCount }]` — suppression must be visible in the
  report and the human-readable output, never silent (global rule: no
  silent caps). Threshold constants named and exported, not inline
  literals.
- Evidence this matters: the FLEXCUBE 29-service run — `/fcubsWarningResp`
  alone produced a 139-member candidate, 64% of all candidate members in
  the report (see `.claude/skills/principal-architect/reference/findings-log.md`).
- Tests: fixture with an envelope coordinate on all sources + one genuine
  overlap → envelope suppressed & reported, genuine candidate survives;
  2-source fixture → no suppression (below source floor).

**Verify**: `pnpm --filter @anvil/mcp-runtime test && pnpm --filter
@anvil/cli test`.

---

## Phase 5 — workflow execution + agent-task benchmark

### Slice 5a — execute field-mapping workflows as single MCP tools

- Scope: ONLY workflows where every step's operation is `approved`, every
  binding is a plain output-field reference (the `$.output.<field>` shape
  `workflow-candidates.ts` emits), and **no step is a mutation with
  `confirmation.required`** unless the composite itself is invoked with
  the same confirmation the runtime already demands for that operation —
  the composite inherits the *strictest* member confirmation. No retries
  across step boundaries, ever (a mid-workflow retry is a new safety
  surface; v1 fails the whole call on any step failure with a structured
  error naming the failed step and preserving prior step outputs in the
  error payload).
- `packages/mcp-runtime/src/server.ts` (read fully first): register one
  additional tool per eligible workflow (name from workflow id), whose
  input schema is step 1's input schema; execute steps sequentially via
  the existing per-operation execute path, resolving each binding from the
  prior step's parsed JSON output.
- Workflows that are not eligible are skipped with a logged reason —
  visible, not silent.
- Tests: two-step happy path threads the bound field; step-2 failure
  surfaces structured error with step name; unapproved member → tool not
  registered; confirmation-required member → composite demands
  confirmation.

### Slice 5b — deterministic agent-task benchmark (`anvil benchmark`)

- v1 is deterministic (no LLM): for each approved operation, derive tasks
  from `skill.intentExamples`; score whether the MCP tool schema + mock
  (simulator-backed, reusing the selftest/conformance bootstrap — read
  `packages/cli/src/commands/selftest.ts` and `conformance.ts` first)
  allows the task to complete: tool discoverable, required params
  satisfiable from the example, call succeeds against the mock, paginated
  ops honor the cursor param. Emits `benchmark.report.json` with
  per-operation pass/fail + reasons and an aggregate score; non-zero exit
  under `--check <threshold>`.
- This becomes the scoreboard: run it on the FLEXCUBE bundles later to
  price every subsequent roadmap item.
- New command follows the exact registration pattern of
  `commands/conformance.ts` (annotate, `{ mutates: false }`).

**Verify**: `pnpm --filter @anvil/mcp-runtime test && pnpm --filter
@anvil/cli test`, then full `pnpm build && pnpm typecheck && pnpm lint &&
pnpm deadcode && pnpm test` before the phase commits.

---

## Explicitly not in this roadmap

NL2SQL translation inside Anvil (the agent translates at runtime; Anvil
makes the target safe), per-vendor domain modules, any expansion of
auto-approval, LLM-driven benchmark scoring (v2, after the deterministic
scoreboard exists).
