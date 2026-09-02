---
name: anvil-commands
description: Every anvil command with usage, options, and mutation markers — derived from the live Commander tree. Read this before running an unfamiliar command.
---

# anvil commands

### `anvil source`  *(mutates)*
`anvil source [options] [command]`

Import and lock API source graphs as immutable content-addressed snapshots.

Layer 0 — capture what the customer actually supplied, before any compilation. `anvil source add <dir | file...>` imports explicit entrypoint files (plus every local $ref reachable from them) or a whole directory (files declaring `openapi:`/`swagger:` become entrypoints; unrelated YAML/JSON is excluded), records each entrypoint's own format and version, hashes the verbatim bytes deterministically, and atomically locks a snapshot under .anvil/sources/<snapshot-id>/ (source.json plus byte-identical raw/ copies). The snapshot-id is content-derived; `--name` attaches a human label that never controls identity or a path, and `--origin` declares a gateway origin (apigee, mulesoft, kong, api_connect, wso2) independent of the spec format. References escaping the import root are rejected; remote refs are recorded as external, never fetched. Anything readable is snapshotted — broken input locks an `invalid` (or `unclassified`) snapshot with its diagnostics inside and exits non-zero, and only `valid` snapshots may be compiled. `list` and `show` are read-only (list reports corrupt slots explicitly); `validate <snapshot-id>` re-hashes raw/ against the locked source.json, so tampering is caught before it can contaminate a compile.

#### `anvil source add`
`anvil source add [options] <targets...>`

Import, discover, freeze, and lock a spec directory or explicit files.

Options:
- `--name <label>` — human label (never controls identity or a path)
- `--origin <kind>` — declared gateway origin (apigee, mulesoft, kong, api_connect, wso2)
- `--environment <env>` — gateway environment recorded as metadata
- `--gateway-product <product>` — gateway product recorded as metadata
- `--organization <org>` — owning organization recorded as metadata
- `--workspace <workspace>` — gateway workspace recorded as metadata
- `--root <dir>` — workspace root for .anvil/sources
- `--json` — emit the snapshot, lock directory, and diagnostics as JSON

#### `anvil source list`
`anvil source list [options]`

List every locked snapshot, and every corrupt slot.

Options:
- `--root <dir>` — workspace root for .anvil/sources
- `--json` — emit the listing as JSON

#### `anvil source show`
`anvil source show [options] <snapshot-id>`

Show one locked snapshot in full.

Options:
- `--root <dir>` — workspace root for .anvil/sources
- `--json` — emit the snapshot as JSON

#### `anvil source validate`
`anvil source validate [options] <snapshot-id>`

Re-hash raw/ against the locked source.json to detect tampering.

Options:
- `--root <dir>` — workspace root for .anvil/sources
- `--json` — emit the verdict and diagnostics as JSON

### `anvil agentify`  *(mutates)*
`anvil agentify [options] <spec>`

One-shot discovery: lock the source, compile, assess readiness, and propose capabilities — then stop for review.

Convenience orchestration of the discovery flow — the same library calls as running `anvil source add` (locks a content-addressed snapshot under .anvil/sources), `anvil compile` (writes the bundle, default generated/<service-id>), `anvil assess` (the readiness triage; blocked operations are surfaced prominently but do not stop the flow), and `anvil capability propose` (read-only re-discovery over the stored groupings) individually, so the compiled AIR is byte-identical to the four-command path. It then STOPS for human review. It deliberately does NOT approve any capability or operation (every grouping stays `proposed`, every unproven mutation stays `review_required`), does NOT certify, and does NOT publish — no certification.json or publication.json is ever written. A broken spec stops at the snapshot layer with structured diagnostics and exit 1; nothing downstream runs.

Options:
- `--manifest <file>` — Anvil manifest with semantic overrides
- `--service <id>` — override the derived service id
- `--out <dir>` — bundle output directory (default generated/<service-id>)
- `--root <ws>` — workspace root for .anvil/sources
- `--json` — emit one machine-readable object with all four stages

### `anvil adopt`
`anvil adopt [options] <endpoint>`

Capture an existing MCP server's surface and classify what its tools mean.

Connects to an MCP server, captures its advertised tools, and lowers each one to an AIR operation with a conservative safety classification: absent a readOnlyHint a tool is treated as a non-idempotent mutation that requires confirmation and is never auto-retried, because MCP's tool contract carries no idempotency, confirmation, or effect semantics of its own. Writes the content-addressed surface snapshot, the AIR, the derived capability contracts, the surface signature, and the adoption plan — then `anvil inspect` the result to see what the server has been exposing. The endpoint is an http(s) URL (streamable HTTP) or a command line to spawn (stdio; prefix `stdio:` to force it). Read-only: adoption captures and classifies, it never calls a tool and never regenerates the provider's server.

Options:
- `--mode <mode>` — adopt | facade | replace — what an eventual build would emit (default: adopt)
- `--service <id>` — service id for the derived AIR (default: from the server name)
- `--out <dir>` — write the adoption artifacts here
- `--header <name:value...>` — header for an HTTP endpoint; ${VAR} resolves from the environment
- `--json` — emit the adoption outcome as JSON

### `anvil compile`  *(mutates)*
`anvil compile [options] [spec]`

Compile a locked source snapshot into a full tool bundle (CLI + MCP + skill + deploy).

Compiles from an immutable Layer 0 source snapshot: everything the compiler reads — the spec and every local $ref — comes from the locked bytes, and the AIR is bound back to the snapshot's identity. Pass `--source <snapshot-id>` to compile an already-locked snapshot (add `--entrypoint <path>` to disambiguate a multi-entrypoint source), or pass a spec path to import-and-lock it first, then compile that snapshot. Parses or lowers the supported API contract formats, classifies effects and idempotency, applies the manifest, validates safety, and writes the bundle. Non-idempotent mutations are escalated to review_required — they are not exposed until approved.

Options:
- `--source <snapshot-id>` — compile an already-locked snapshot instead of a spec file
- `--entrypoint <path>` — snapshot-relative entrypoint when a source has several
- `--manifest <file>` — Anvil manifest with semantic overrides, workflows, and exact-id capability reviews
- `--service <id>` — override the derived service id
- `--out <dir>` — bundle output directory (default generated/<service-id>)
- `--endpoint <url>` — MCP endpoint recorded in the generated artifacts
- `--human-approval <policy>` — require explicit human approval on gated mutations: none | unsafe | all (per-op manifest `human_approval` overrides)
- `--root <ws>` — workspace root for .anvil/sources

### `anvil status`
`anvil status [options] <path>`

Show source, projection, approval, assurance, target, and release-plan status.

Read-only. Resolves the canonical AIR and locked-source coordinate, verifies generated CLI/MCP/catalog/runtime projections against it, checks static assurance plus current-hash selftest/conformance/simulation evidence, checks deployment-plan freshness, detects stale target setup signatures, and chooses one deterministic next safe action. A local publication.json means only that a plan was prepared; it never means deployed or live. Exit is non-zero only when a core projection is missing, corrupt, or misaligned.

Options:
- `--root <dir>` — workspace root containing .anvil/sources
- `--json` — emit one StatusReport JSON document
- `--require <action>` — exit non-zero unless the next safe action is <action> (repair-core | resolve-contract | resolve-gateway-policy | resolve-blocked | inspect-approve | certify | selftest | conformance | simulate | retarget | release | operator-action-required); use --require release to gate a pipeline

### `anvil inspect`
`anvil inspect [options] <path>`

Show the operation catalog and each operation's safety posture.

Read-only. Use before approving to see effect, risk, idempotency, retry-safety, and state.

Options:
- `--json` — emit the operation catalog as JSON

### `anvil assess`
`anvil assess [options] <path> [operation...]`

Report which operations are agent-ready; gate a pipeline with --check.

Read-only. Runs Anvil's deterministic detectors and projects every operation's readiness disposition — ready, refinementRequired, humanDecisionRequired, blocked, or excluded — from the deficiency catalog's per-code policy plus the lifecycle state, with each gap's agent impact and an honest remediation (a suggested skill that is not implemented says so). The result is a versioned artifact (schemaVersion, contractHash of the assessed AIR, overallDisposition, readyPercent); `--json` emits it whole, and `--severity` narrows the detail into a view without touching the totals. A report that completed exits 0 even with blockers; gating is explicit: `--check [--fail-on blocked|human-decision|refinement-required]` (default blocked) exits non-zero when the overall or any operation disposition meets the threshold. Drill into one operation with `anvil assess <dir> <operation>` (or the plan-style `... operation <name>`). Reuses the same detectors as `anvil refine plan`, so the per-operation triage never disagrees with the deficiency list.

Options:
- `--severity <severity>` — narrow the report to a minimum severity
- `--check` — gate: exit non-zero at/past the --fail-on threshold
- `--fail-on <disposition>` — the disposition threshold --check fails at (default blocked)
- `--json` — emit the versioned artifact (or the filtered view) as JSON

### `anvil distill`
`anvil distill [options] <path>`

Strip a surface to its eigenbasis: the minimal spanning set of operations.

Deterministic, read-only whole-surface analysis (a peer of `assess`). Reads collapse by (resource, action) to one canonical, most-general read per cluster; every write is kept as its own basis vector; same-signature mutations are flagged for review, never auto-dropped. Reports the basis, the reconstructible read projections, the redundant clusters, any intents reachable ONLY through reconstructible ops (which a mechanical strip would lose), and capabilities whose basis still exceeds the tool budget. `--json` emits the full artifact for the Stage-2 coding-harness loop; `--check` gates on over-budget capabilities. It proposes only — approval stays an explicit, reviewed step.

Options:
- `--json` — emit the distillation artifact as JSON
- `--check` — gate: exit non-zero if a capability's basis exceeds the tool budget
- `--as-enrich-plan` — emit a targeted enrichment plan (the surface's open questions) instead of the report
- `--write <file>` — write the output (report or enrich plan) to a file

### `anvil capability`  *(mutates)*
`anvil capability [options] [command]`

Review capability groupings: propose, inspect, approve, reject, or diff.

The capability review lifecycle. `propose` re-runs discovery and prints each grouping with its provenance and tool-budget verdict (read-only); `list` and `show` inspect stored capabilities (small summaries by default; add --operations/--auth/--evidence/--json for detail); `diff` reports drift between a stored capability and fresh discovery. `approve`/`reject` persist the review decision to the AIR file. Approval enforces the effective disclosure budget — the surface actually served: direct members plus authored workflow dependencies, minus operations an approved workflow supersedes, plus one tool per approved workflow. More than 20 tools is blocked without --allow-large and an audit note; more than 15 warns. Composing a workflow that supersedes its own steps therefore LOWERS what a capability spends. Only an approved capability can be built with `anvil build`.

#### `anvil capability propose`
`anvil capability propose [options] <path>`

(Re)run discovery; print proposals with provenance and budget findings.

Two grounds for a grouping, one at a time. By default this re-runs spec discovery: groupings come from OpenAPI tags and the resource heuristic — a vendor's REFERENCE taxonomy, organised by resource, which real tasks routinely cut across. OBSERVED TRAFFIC (--from-records <dir>): instead reads the execution-record spool a deployed server wrote (set ANVIL_RECORDS_DIR on the generated MCP/HTTP server) and groups operations that were used inside the same traceId — a task observed rather than guessed, carried as recorded_traffic evidence stating the trace count rather than a confidence nobody could defend. An operation appearing in nearly every distinct trace shape (auth, health check, token refresh) co-occurs with everything, so it is filtered out statistically before any grouping is formed and named in the report; a shape seen fewer than 5 times is an anecdote and is not proposed. Each grouping carries a ready-to-review manifest snippet (manifestSnippet in the report; --snippet <grouping-id> prints one) — copy it into the estate's anvil.yaml `capabilities:` section to author the grouping as a manifest-sourced capability, then recompile and review it through the ordinary approve gate. Read-only and propose-only: it never writes AIR, a manifest, an approval, or a build, and --out must be outside the bundle.

Options:
- `--from-records <dir>` — group by co-occurrence in a serving-path record spool (ANVIL_RECORDS_DIR) instead of by spec
- `--out <file>` — write the observed-capability report here (--from-records only)
- `--snippet <grouping-id>` — print the chosen grouping's ready-to-review manifest snippet, verbatim (--from-records only)
- `--json` — emit the proposals as JSON

#### `anvil capability list`
`anvil capability list [options] <path>`

List the stored capabilities and their review lifecycle.

#### `anvil capability show`
`anvil capability show [options] <path> <capability-id>`

Show one capability: small summary by default, sections on request.

Options:
- `--operations` — list the member operations
- `--auth` — summarize the members' auth requirements
- `--evidence` — list the evidence claims
- `--json` — emit the capability and its budget check as JSON

#### `anvil capability approve`
`anvil capability approve [options] <path> <capability-id>`

Record the approval decision; the tool budget gates it.

Options:
- `--allow-large` — waive the >20-tool budget block (requires a non-empty --note)
- `--note <note>` — review note persisted with the decision

#### `anvil capability reject`
`anvil capability reject [options] <path> <capability-id>`

Record why the grouping is not the right unit.

Options:
- `--reason <reason>` — rejection reason persisted with the decision

#### `anvil capability diff`
`anvil capability diff [options] <path> <capability-id>`

Report drift between a stored capability and fresh discovery.

#### `anvil capability compose`  *(mutates)*
`anvil capability compose [options] <bundles...>`

Audit cross-source output overlap and initialize a bound review.

Deterministic and offline. Accepts two or more verified generated bundle directories without modifying them, then writes new audit/review artifacts outside those inputs. It extracts output data-point signatures and reports evidence candidates with auth and safety constraints intersected rather than weakened. Structural similarity never selects an authoritative source. `--init-review` writes an unresolved manifest; edit it with local digest-bound evidence and rerun using `--review`. The command never approves, builds, deploys, or generates a multi-source MCP server.

Options:
- `--out <file>` — write the versioned composition audit JSON here
- `--init-review <file>` — write a new unresolved review-manifest scaffold; refuses an existing file
- `--review <file>` — apply an edited, digest-bound review manifest on a deterministic rerun
- `--json` — also emit the complete audit report as JSON on stdout

### `anvil refine`  *(mutates)*
`anvil refine [options] [command]`

Detect, propose, measure, and apply refinements to AIR (the quality flywheel).

`anvil refine plan` runs Anvil's deterministic detectors and reports a refinement plan — documentation gaps, weak naming/routing, unproven safety semantics, and mock/eval coverage holes — grouped by severity, category, and the narrow skill that owns each fix. `anvil refine skills` lists those skills as typed contracts (trigger, evidence policy, output boundary, validation), whose executor is kept separate from their semantics. `anvil refine run` routes each in-scope deficiency to its skill, proposes an evidence-backed semantic patch, validates it, then MEASURES only the eval families it affects — with a safety guard that must never regress — and reconciles the result through an auto-approval policy into a reviewable refinement pack (--severity/--skill/--safe-only/--out). `export-task` and `import-proposal` expose those same rails as portable JSON, so any coding harness can investigate without importing Anvil's TypeScript package. They also carry GROUP scope: `export-task <dir> group:<cluster-id>` reads the benchmark report's measured confusion clusters and exports one hash-bound task asking the harness for a higher-order shape — EITHER a workflow whose supersedes (⊆ its own steps) shrinks the served surface, OR an authored capability over the members, OR an honest decline with a reason. On import, a validated group proposal is SCORED before review: the deterministic lexical router re-routes the same intent tasks over the current vs hypothetical served surface; a negative delta is refused with the numbers, and a non-negative delta attaches as evidence (routing-delta.json) on a proposal that still lands at review — the measured uplift is information for the human, never an approval. `anvil refine review <pack-dir>` prints the human review. `approve`/`reject` write hash-bound decisions, and `apply-pack` applies those exact reviewed bytes without rerunning investigation. `anvil refine apply` remains the shortcut for auto-approved refinements.

#### `anvil refine plan`
`anvil refine plan [options] <path>`

Detect what AIR is missing or weak (read-only).

Options:
- `--json` — emit the refinement plan as JSON

#### `anvil refine skills`
`anvil refine skills [options]`

List the typed refinement skill contracts (read-only).

Options:
- `--json` — emit the skill contracts as JSON

#### `anvil refine skill`
`anvil refine skill [options] [out-dir]`

Emit the progressive-disclosure harness skill package.

#### `anvil refine run`
`anvil refine run [options] <path>`

Build a refinement pack: propose, validate, measure, reconcile.

Options:
- `--severity <severity>` — only refine at/above this severity
- `--skill <name>` — only run one skill
- `--safe-only` — skip refinements that touch safety semantics
- `--out <dir>` — write the refinement pack here
- `--json` — emit the refinement pack as JSON

#### `anvil refine export-task`
`anvil refine export-task [options] <path> <target-key>`

Export one hash-bound, process-neutral coding-harness task.

Options:
- `--out <file>` — write the portable task JSON here
- `--skill <name>` — select a skill when one target has multiple deficiencies
- `--repo-root <dir>` — Git repository the harness may inspect
- `--inspect <paths>` — comma-separated repository-relative inspect scopes
- `--traffic-report <file>` — observed-capability report (`anvil capability propose --from-records --out`); its groupings ride into a group task as related-operation context

#### `anvil refine import-proposal`
`anvil refine import-proposal [options] <path> <task-file> <submission-file>`

Validate and measure a portable harness submission into a refinement pack.

Options:
- `--out <dir>` — write the measured refinement pack here
- `--repo-root <dir>` — Git repository named by the task
- `--json` — emit a structured success or rejection envelope

#### `anvil refine review`
`anvil refine review [options] <pack-dir>`

Print a refinement pack's human review.

#### `anvil refine approve`
`anvil refine approve [options] <pack-dir> <refinement-id...>`

Approve review-tier refinements with a bound receipt.

Options:
- `--reviewer <identity>` — stable reviewer identity (for example, email or handle)
- `--reason <text>` — why this decision is justified

#### `anvil refine reject`
`anvil refine reject [options] <pack-dir> <refinement-id...>`

Reject review-tier refinements with a bound receipt.

Options:
- `--reviewer <identity>` — stable reviewer identity (for example, email or handle)
- `--reason <text>` — why this decision is justified

#### `anvil refine apply-pack`
`anvil refine apply-pack [options] <path> <pack-dir>`

Apply an existing measured pack plus its receipt-bound human decisions.

Options:
- `--receipt <file>` — additional receipt file (repeatable; pack-dir/receipts/*.json is loaded by default)
- `--dry-run` — print the semantic diff without writing AIR

#### `anvil refine apply`
`anvil refine apply [options] <path>`

Apply only the auto-approved refinements to AIR (the sole mutating step).

Options:
- `--severity <severity>` — only refine at/above this severity
- `--skill <name>` — only run one skill
- `--safe-only` — skip refinements that touch safety semantics
- `--dry-run` — print the semantic diff without writing AIR

### `anvil case`  *(mutates)*
`anvil case [options] [command]`

Run a bounded investigation for one deficiency as an isolated case.

The investigation framework. `anvil case list <dir>` shows the deficiencies a case can be opened for; `anvil case open <dir> <target-key>` materializes an isolated case workspace (CASE.md + task/target/evidence-policy/allowed-tools/expected-output.schema + workspace/ + output/) that gives a coding agent a *case, not a prompt*. Inside a case, the agent works only with rails that enforce Anvil semantics — repository search and language tooling are the agent's own job, not Anvil's: `inspect`, `add-evidence` (enforces the source AND predicate policy), `validate-claims` (strength + contradictions + predicate policy), `synthesize` (composes the proposal from gathered claims), `validate-proposal` (deterministic validation), and `finalize` (records an honest status — proposal_generated / conflicted / insufficient_evidence / …). `anvil case investigate <case>` drives the live coding agent; `anvil case close <case> <air>` re-enters Anvil's rails — validating and reconciling the proposal into a refinement, bound to the case identity. The agent owns investigation and synthesis; Anvil owns admissibility, safety, validation, and application. AIR is never edited by a case.

#### `anvil case list`
`anvil case list [options] <path>`

List the deficiencies a case can be opened for (those with a skill).

Options:
- `--json` — emit the rows as JSON

#### `anvil case open`
`anvil case open [options] <path> <target-key>`

Materialize a fresh, immutable case run for one target.

Options:
- `--out <dir>` — case root directory
- `--inspect <fields>` — comma-separated AIR fields to pre-inspect
- `--repo-root <dir>` — repository root recorded for filesystem evidence
- `--executor <executor>` — executor identity recorded in the case

#### `anvil case battery`
`anvil case battery [options]`

Run the investigator benchmark battery.

Run either the deterministic baseline-vs-investigation battery (default, scripted, fast) or, when explicitly enabled, the real-agent investigator effectiveness battery. The default mode is deterministic and does not invoke an external agent.

Options:
- `--real` — invoke a real coding agent for the effectiveness battery
- `--json` — emit JSON report
- `--command <command>` — agent CLI to drive (default: claude)
- `--model <model>` — model passed through to the agent CLI
- `--check` — fail on scripted battery expectation mismatches
- `--allow-degraded-native` — proceed even when native execution cannot enforce split

#### `anvil case inspect`
`anvil case inspect [options] <case-dir>`

Print the case's target inspection.

#### `anvil case add-evidence`
`anvil case add-evidence [options] <case-dir>`

Record one evidence claim (the source and predicate policy gate it).

Options:
- `--predicate <predicate>` — the semantic predicate the claim is about
- `--source <kind>` — the evidence source kind
- `--value <value>` — the claimed value (JSON when it parses, else a string)
- `--path <file>` — file the evidence points at (verified against --lines)
- `--lines <range>` — line coordinate for --path, as `a-b` or `a`
- `--uri <uri>` — external coordinate for non-filesystem evidence
- `--ref <ref>` — revision/reference the coordinate was read at
- `--note <note>` — free-form annotation
- `--confidence <n>` — claim confidence in [0,1]

#### `anvil case validate-claims`
`anvil case validate-claims [options] <case-dir>`

Judge the gathered claims: strength, contradictions, predicate policy.

#### `anvil case synthesize`
`anvil case synthesize [options] <case-dir> [pairs...]`

Compose the proposal from gathered claims (field=value pairs).

#### `anvil case validate-proposal`
`anvil case validate-proposal [options] <case-dir> <path>`

Deterministically validate the case's proposal against AIR.

#### `anvil case investigate`
`anvil case investigate [options] <case-dir>`

Drive a live coding agent against the case.

Options:
- `--command <command>` — agent CLI to drive (default: claude; codex is protocol-aware)
- `--model <model>` — model passed through to the agent CLI
- `--allow-degraded-native` — proceed even when native tooling is degraded

#### `anvil case finalize`
`anvil case finalize [options] <case-dir>`

Record an honest terminal status for the run.

Options:
- `--status <status>` — terminal status to record
- `--summary <summary>` — one-line summary recorded with the status
- `--blocked-sources <json>` — JSON list of blocked sources, e.g. '[{"source":"..","reason":".."}]'

#### `anvil case delete`
`anvil case delete [options] <case-dir>`

Discard one case run directory.

#### `anvil case close`
`anvil case close [options] <case-dir> <path>`

Re-enter Anvil's rails: reconcile the proposal into a refinement.

Options:
- `--json` — emit the refinement as JSON

### `anvil enrich`
`anvil enrich [options] <path>`

Connect to published MCP servers (GitHub, Confluence, …) and propose a manifest patch.

Anvil is an MCP client here: it connects to the MCP servers those systems already publish, gathers evidence per operation, and proposes idempotency/confirmation/etc. Propose-only — nothing touches AIR. Loosening safety requires high-reliability (implementation/traffic) evidence; review the patch, then `anvil compile --manifest`.

Options:
- `--sources <file>` — sources.yaml naming the MCP servers to consult
- `--plan <file>` — an enrichment plan from `anvil distill --as-enrich-plan`: probe only its targeted operations, routing each question to the matching source pole (code loosens, docs tighten)
- `--write <manifest>` — write the proposed manifest here instead of printing it
- `--json` — emit the per-operation decisions as JSON
- `--agent <name>` — harness agent to use (heuristic|agent-cli; default: heuristic)
- `--agent-command <bin>` — CLI command for agent-cli (default: claude)
- `--agent-timeout <ms>` — timeout in milliseconds for agent-cli (default: 30000)

### `anvil estate`
`anvil estate [options] [command]`

Assess explicitly tiered gateway inputs and adopt selected APIs.

Run `estate support [vendor]` first: WSO2 supports native estates, Kong one native declarative state, and Apigee/MuleSoft/API Connect normalized interchange. Reads an adapter-supported offline gateway artifact: a bare document, a ZIP/JAR decoded through the hardened archive harness, or a native WSO2 apictl collection directory. The container reader is not a general native-artifact translator; run `estate audit` and read the gateway skill reference for each adapter's exact input boundary. `inventory`, `audit`, and `plan` assess the estate without exposing it; `import` resolves one exact API/version/revision/environment coordinate into a receipt-bound bundle. Risky operations remain unexposed. Review accepted semantics in a supplemental manifest and re-import; receipt-bound output cannot be approved in place.

#### `anvil estate support`
`anvil estate support [options] [vendor]`

Show the versioned native-vs-normalized gateway support contract.

Reports what artifact shapes Anvil actually accepts, separately from the semantics an adapter models and the fixtures/scale proof behind that claim. Mashery is research-only and is not selectable by inventory/import.

Options:
- `--json` — emit the stable machine-readable support registry

#### `anvil estate connect`
`anvil estate connect [options] <export>`

Probe the chosen vendor adapter and confirm whether the export is understandable.

Options:
- `--vendor <vendor>` — vendor (kong | apigee | wso2 | mulesoft | api_connect)
- `--entry <path>` — archive entry holding the config, when the archive has several
- `--gateway-id <id>` — stable gateway control-plane/org/instance id included in the probe digest (default unscoped)
- `--json` — emit the connect report as JSON

#### `anvil estate inventory`
`anvil estate inventory [options] <export>`

List the APIs in a gateway export without compiling anything.

Options:
- `--vendor <vendor>` — gateway vendor (kong | apigee | wso2 | mulesoft | api_connect)
- `--entry <path>` — archive entry holding the config, when the archive has several
- `--gateway-id <id>` — stable gateway control-plane/org/instance id included in the inventory digest (default unscoped)
- `--query <text>` — filter the view by API id or name (case-insensitive)
- `--owner <owner>` — filter the view by exact API owner
- `--lifecycle <state>` — filter the view by exact lifecycle state
- `--limit <count>` — maximum API rows in the view (default 50)
- `--all` — return every matching API instead of applying --limit
- `--summary` — emit counts and diagnostics without per-API rows
- `--json` — emit the inventory snapshot as JSON

#### `anvil estate audit`
`anvil estate audit [options] <export>`

Audit a whole gateway estate without compiling or exposing any API.

Builds a deterministic, machine-readable adoption report over the complete inventory: adapter capability gaps, contract fidelity, route ambiguity, authentication evidence, opaque policy findings, accountable owners, and exact next actions. A completed audit exits zero by default even when it finds blockers; use --check to make it a CI gate.

Options:
- `--vendor <vendor>` — gateway vendor (kong | apigee | wso2 | mulesoft | api_connect)
- `--entry <path>` — archive entry holding the config, when the archive has several
- `--gateway-id <id>` — stable gateway control-plane/org/instance id included in the audit baseline (default unscoped)
- `--json` — emit the complete audit report as one JSON document
- `--check` — exit non-zero when findings meet --fail-on
- `--fail-on <level>` — CI threshold: blocked | review-required (used with --check)

#### `anvil estate plan`  *(mutates)*
`anvil estate plan [options] <export>`

Build a resumable, baseline-aware adoption plan for a gateway estate.

Inventories and audits the complete adapter-supported document, then emits one deterministic adoption-plan artifact for bulk triage while import remains API-by-API. Use --init-selection to create an overwrite-safe coordinate queue whose rows all start in triage; reviewers may mix deterministic_only, agent_assisted, and manual_review per API. The plan captures explicit triage/selected/deferred decisions, accountable owners, dispositions, baseline fingerprints, owner workstreams, stage status, and concrete next actions. Ready rows include an import command template with every reviewed coordinate filled; replace only <export> with the local path. Optional CASE/distill investigation lanes are proposal-only; inspect, lint, receipt-bound import, and verify remain authoritative. Pass a reviewed prior plan with --baseline and --check to fail on re-export, adapter, finding, API, or selection drift.

Options:
- `--vendor <vendor>` — gateway vendor (kong | apigee | wso2 | mulesoft | api_connect)
- `--entry <path>` — archive entry holding the config, when the archive has several
- `--gateway-id <id>` — stable gateway control-plane/org/instance id used by every strict import command
- `--selection <path>` — versioned YAML/JSON selection file with API decisions, intent, owner, contract, and gateway URL
- `--init-selection <path>` — write a new coordinate-aware triage selection file (never auto-selects; refuses existing files)
- `--select <id>` — select one exact inventory API id (repeatable; ambiguous revisions/environments require --selection)
- `--baseline <path>` — reviewed prior adoption-plan JSON; selections are inherited when no new selection is supplied
- `--out <path>` — write the complete deterministic adoption-plan JSON here
- `--check` — require --baseline and exit non-zero when source, API, finding, adapter, or selection state changed
- `--json` — emit the complete adoption plan as JSON instead of the bounded human view

#### `anvil estate import`  *(mutates)*
`anvil estate import [options] <export>`

Import one API from a gateway export and compile it into a bundle.

Options:
- `--vendor <vendor>` — gateway vendor (kong | apigee | wso2 | mulesoft | api_connect)
- `--api <id>` — API id from `estate inventory` (optional when the estate has one)
- `--gateway-id <id>` — stable gateway control-plane/org/instance id when the export does not carry one
- `--strict-identity` — require --gateway-id and block unproven required issuer/audience/carrier/principal dimensions
- `--environment <id>` — deployment environment; required when the selected API exists in several
- `--api-version <version>` — semantic API version; required when a gateway exposes several versions independently of revisions
- `--revision <revision>` — gateway revision; required when the selected API has several (for native WSO2: working-copy or revision-N)
- `--entry <path>` — archive entry holding the config, when the archive has several
- `--spec <path>` — original OpenAPI/Swagger contract; lock it and apply gateway policies instead of compiling route-only synthesis
- `--attest-spec-override <reason>` — explicit WSO2 attestation when --spec cannot exactly match one embedded Definitions contract; recorded in the private receipt
- `--manifest <path>` — supplemental Anvil manifest, including exact-id capability reviews, applied in the receipt-bound compile
- `--gateway-url <url>` — operator-attested public HTTPS gateway base URL; required with --spec so generated tools cannot bypass the gateway
- `--root <dir>` — workspace root for the locked source under .anvil/sources
- `--service <id>` — reviewed agent-facing service id (default derives from gateway/API/revision/environment)
- `--out <dir>` — bundle output directory (default generated/<service-id>/<environment-revision-identity>)
- `--replace-derived` — replace verified derived output for the same stable gateway coordinate when approval made it stale or export/inventory evidence changed; verified later lifecycle artifacts are explicitly discarded
- `--json` — emit a machine-readable import report (for CI oracles)

#### `anvil estate verify`
`anvil estate verify [options] <import-id>`

Verify an immutable gateway import receipt and its bound evidence.

Options:
- `--root <dir>` — workspace root for .anvil/imports and .anvil/sources
- `--bundle <dir>` — also verify the generated output files against the receipt
- `--json` — emit a machine-readable integrity report

### `anvil legacy`
`anvil legacy [options] [command]`

Inventory offline legacy application and messaging evidence.

Discover evidence-backed EJB, WCF, resource-adapter, and messaging invocation candidates from caller-supplied offline exports. Collection never connects to a server or broker, loads an assembly, executes bytecode, opens an archive, reads a queue, or invents business semantics.

#### `anvil legacy inventory`  *(mutates)*
`anvil legacy inventory [options] <source>`

Build a content-addressed legacy estate inventory without invoking the estate.

Reads one regular file or hardened-expanded directory without following symbolic links. The default auto collector recognizes Java EE/WebLogic/WebSphere/JBoss descriptors, .NET Framework/WCF configuration, and supported broker or AsyncAPI exports. Physical bindings remain evidenced claims, and disagreements remain conflicts for review.

Options:
- `--environment <id>` — deployment environment coordinate
- `--application <id>` — application coordinate
- `--estate <id>` — estate id (default: source directory or file name)
- `--estate-name <name>` — human-readable estate name
- `--source-id <id>` — stable evidence-system id (default: <estate>:<environment>)
- `--source-kind <kind>` — evidence authority (deployed_artifact | deployed_configuration | broker_configuration | artifact_repository | source_repository | runtime_observation | operator_attestation | service_catalog | documentation | naming_inference)
- `--revision <revision>` — immutable source revision or export digest label
- `--collector <collector>` — collector lane (auto | java-ee | dotnet | messaging)
- `--out <file>` — write the complete report without overwriting different content
- `--check` — exit non-zero when any candidate contains a conflict
- `--json` — emit the complete machine-readable report

#### `anvil legacy refine`
`anvil legacy refine [options] [command]`

Turn one inventory candidate into a reviewed business and transport binding.

Export a hash-bound task for a coding harness, validate its evidence-backed proposal, then record a separate human approval or rejection. A reviewed binding remains a non-executable plan until a deployment-local bridge adapter is implemented.

##### `anvil legacy refine task`  *(mutates)*
`anvil legacy refine task [options] <inventory> <candidate-id>`

Export one deterministic candidate-refinement task.

Options:
- `--out <file>` — write without overwriting different content
- `--json` — emit the complete task report

##### `anvil legacy refine review`  *(mutates)*
`anvil legacy refine review [options] <inventory> <task> <submission>`

Import and deterministically assess one harness proposal.

Options:
- `--out <file>` — write the review pack without overwriting different content
- `--json` — emit the complete review pack

##### `anvil legacy refine approve`  *(mutates)*
`anvil legacy refine approve [options] <inventory> <review>`

Approve the exact assessed proposal and emit a non-executable binding plan.

Options:
- `--reviewer <identity>` — reviewer identity recorded in the receipt
- `--reason <text>` — why this exact proposal is approved
- `--out <file>` — write the decision without overwriting different content
- `--json` — emit the complete decision report

##### `anvil legacy refine reject`  *(mutates)*
`anvil legacy refine reject [options] <inventory> <review>`

Reject the exact assessed proposal and retain an auditable receipt.

Options:
- `--reviewer <identity>` — reviewer identity recorded in the receipt
- `--reason <text>` — why this exact proposal is rejected
- `--out <file>` — write the decision without overwriting different content
- `--json` — emit the complete decision report

#### `anvil legacy bridge`
`anvil legacy bridge [options] [command]`

Plan and assess a deployment-local bridge for an approved binding.

Produces a deterministic, non-executable runtime contract from an approved legacy binding. It never loads a driver, connects to the estate, accepts credentials, or treats a plan as live readiness.

##### `anvil legacy bridge plan`  *(mutates)*
`anvil legacy bridge plan [options] <decision>`

Create a content-addressed bridge contract and conformance requirements.

Options:
- `--driver <file>` — statically assess a driver descriptor without loading it
- `--out <file>` — write without overwriting different content
- `--json` — emit the complete bridge plan

#### `anvil legacy plan`  *(mutates)*
`anvil legacy plan [options] <manifest>`

Validate and address a fail-closed legacy evidence collection plan.

Turns a strict collection-plan manifest into a deterministic plan ID. Repository evidence must be revision-pinned, and unsafe acquisition modes are not expressible.

Options:
- `--out <file>` — write without overwriting different content
- `--json` — emit the complete collection-plan report

#### `anvil legacy graph`  *(mutates)*
`anvil legacy graph [options] <inventory>`

Project an inventory into a typed, evidence-linked graph.

Options:
- `--out <file>` — write without overwriting different content
- `--json` — emit the complete evidence graph

#### `anvil legacy gaps`  *(mutates)*
`anvil legacy gaps [options] <inventory>`

Measure semantic coverage and request the evidence still needed.

Separates collector yield from semantic completeness. Missing, conflicting, unsupported, and safety-refused evidence remain explicit acquisition work.

Options:
- `--plan <file>` — assess against an addressed collection plan
- `--check` — exit non-zero unless semantic coverage is complete
- `--out <file>` — write without overwriting different content
- `--json` — emit coverage and gap-plan JSON

#### `anvil legacy explain`  *(mutates)*
`anvil legacy explain [options] <inventory> <candidate-id>`

Trace one candidate to every observation, claim, and source artifact.

Options:
- `--out <file>` — write without overwriting different content
- `--json` — emit the complete candidate explanation

#### `anvil legacy diff`  *(mutates)*
`anvil legacy diff [options] <before> <after>`

Compare legacy inventories by deployment occurrence and logical lineage.

Options:
- `--out <file>` — write without overwriting different content
- `--json` — emit the complete deterministic inventory diff

### `anvil enrich-sources`
`anvil enrich-sources [options] [command]`

List enrichment sources, or scaffold a sources.yaml with `enrich-sources init`.

The published MCP servers Anvil enriches from. `anvil enrich-sources` (or `enrich-sources list`) shows the built-in profiles — GitHub, GitLab, Confluence, Jira, Notion, Postman — with the default server for each and whether its evidence can loosen safety (code hosts) or only tighten/corroborate (docs, Postman). `anvil enrich-sources init <dir>` scaffolds a sources.yaml for a compiled service and lists the interview questions to finish it.

#### `anvil enrich-sources list`
`anvil enrich-sources list [options]`

List the built-in enrichment source profiles.

#### `anvil enrich-sources init`
`anvil enrich-sources init [options] <path>`

Scaffold a sources.yaml for a service, with the interview questions to finish it.

Reads the compiled AIR and proposes a sources.yaml: the two evidence poles every enrichment wants — a CODE host (the only tier that can loosen safety) and a DOC host (tightens/corroborates, supplies intent phrases) — plus any product vendor it detects (Salesforce, SAP) and a Postman source when the spec came from a collection. It also emits the exact QUESTIONS a coding harness should put to the user (which repo, which space, which env vars) — the interview is agent-native: propose, then refine with the operator. Propose-only; `--write <file>` saves the scaffold, `--json` emits the questions + proposal for a harness.

Options:
- `--write <file>` — write the scaffolded sources.yaml here
- `--json` — emit the proposal + interview questions as JSON

### `anvil approve`  *(mutates)*
`anvil approve [options] <path> <operation-ids...>`

Approve operations so they are exposed by the generated artifacts.

Only approved operations appear in the MCP server, CLI catalog, compiled runtime, and skill. Approve deliberately after inspecting risk. The AIR and every generated projection are staged, checked for exact bytes and surface agreement, then swapped into place together. Receipt-bound gateway imports refuse in-place approval and provide the exact manifest re-import command so import-to-approval lineage stays immutable.

### `anvil console`  *(mutates)*
`anvil console [options] [path]`

Open the local review console over a workspace of compiled bundles.

Serves a browser page on 127.0.0.1 that projects every bundle beneath the workspace root — the decision queue, the inspector, packs, benchmark confusion, and drift — and lets a reviewer approve operations, approve or reject capabilities, record and apply pack decisions, and export or import harness tasks. Every decision calls the same library function the CLI command calls and produces the same receipt: `anvil approve`, `anvil capability approve|reject`, `anvil refine approve|reject|apply-pack|export-task|import-proposal`. Mutations require a per-process token the served page carries and a same-origin request; nothing outside the workspace root is read or written.

Options:
- `--port <n>` — port on 127.0.0.1 (default: a free port)
- `--open` — open the console in the default browser
- `--json` — print one { url, port, root } document, then keep serving

### `anvil lint`
`anvil lint [options] <path>`

Show safety diagnostics; exit non-zero if there are errors.

Surfaces unproven idempotency, missing confirmation, duplicate names, and incoherent retry policy.

### `anvil build`  *(mutates)*
`anvil build [options] <path> <capability-id>`

Compile one approved capability into an aligned CLI + MCP + skill bundle.

Narrows the AIR document to the capability's approved operations and reachable schemas, then reuses the whole-service generator, so the capability bundle is the same aligned projection of a smaller model. Refuses (with a structured error) a capability that is missing, not lifecycle-approved, or would build empty. Stamps a content-addressed bundle.json (capabilityHash + contractHash shared by every surface); rebuilding unchanged input reproduces identical hashes.

Options:
- `--out <dir>` — bundle output directory (default generated/<capability-artifact-id>/<deployment-namespace>)
- `--endpoint <url>` — MCP endpoint recorded in the generated artifacts

### `anvil sdk`
`anvil sdk [options] <path>`

Show or emit the generated client SDKs (TypeScript, Python, Go, Java).

Every approved operation becomes one method in each language, projected from the same AIR that produced the CLI, the MCP server, and the skill — same wire coordinates, same confirmation and idempotency gates, same retry posture, same error taxonomy. Without --out this prints the method table and the gates each call must satisfy; with --out it writes the SDK trees (the same bytes `anvil compile` puts under the bundle's sdk/). Only approved operations are ever emitted.

Options:
- `--lang <languages>` — comma-separated subset of typescript, python, go, java (default: all)
- `--out <dir>` — write the SDK trees here instead of printing the method table
- `--json` — emit the SDK manifest as JSON

### `anvil review`  *(mutates)*
`anvil review [options] <dir>`

Model-driven semantic review of a bundle's agent surfaces (MCP/CLI/skill).

Drives a cheap reviewer model (default Haiku via the `claude` CLI) through Anvil's artifact-review SOP over a generated bundle: MCP tool descriptions must be truthful to each operation's effect/risk, the CLI surface must teach confirm/idempotency/dry-run on mutating commands, the skill doc must teach the safety posture and document no phantom operations, and all three surfaces must agree. Every finding must cite verbatim evidence from the bundle; ungrounded findings are discarded mechanically. Native execution is unsandboxed and therefore fails closed unless --allow-degraded-native is supplied; its HOME is isolated and credentials are delivered only through the Claude credential profile. Writes review.report.json into the bundle.

Options:
- `--model <model>` — reviewer model passed to the driver
- `--driver-command <bin>` — headless agent CLI to drive
- `--allow-degraded-native` — explicitly allow the unsandboxed native reviewer (isolated HOME; host files remain reachable)
- `--json` — emit the full review report as JSON

### `anvil target`  *(mutates)*
`anvil target [options] <profile> <dir>`

Generate an agent-platform connector kit (e.g. Gemini Enterprise) for a bundle.

Validates and generates one explicit Gemini Enterprise registration journey. `custom-mcp` is console-first; its raw setUpDataConnector files are experimental references. `agent-gateway` emits guarded Agent Registry, gateway, engine-binding, and rollback artifacts. `both` is available only when explicitly requested for compatibility. Connector OAuth protects /mcp and is separate from Gemini Enterprise sign-in / Workforce Identity Federation. No files are written when validation fails.

Options:
- `--surface <surface>` — registration surface
- `--server-auth <mode>` — MCP resource-server auth mode
- `--endpoint <url>` — the connector's public HTTPS MCP URL (e.g. https://host/mcp)
- `--project <id>` — 6-30 character GCP project ID (not the numeric project number)
- `--project-number <number>` — provider-assigned numeric GCP project identity used in canonical resources
- `--location <loc>` — Gemini Enterprise app/engine location: global, us, eu, or a region
- `--engine <id-or-resource>` — GE engine id, or full projects/.../locations/.../collections/.../engines/... resource
- `--gateway-location <region>` — Agent Gateway region (required to match the verified app-location matrix)
- `--registry-location <region>` — Agent Registry location referenced by the gateway
- `--idp <provider>` — connector OAuth provider protecting /mcp; not the GE sign-in IdP
- `--tenant <id>` — connector OAuth tenant id / Okta domain
- `--oauth-authorization-url <url>` — explicit connector authorization URL (required for --idp other)
- `--oauth-token-url <url>` — explicit connector token URL (required for --idp other)
- `--oauth-scope <scope...>` — one or more scopes whose resource is this MCP API
- `--inbound-issuer <url>` — issuer the MCP resource server validates
- `--inbound-audience <audience>` — audience identifying this MCP API
- `--wif <pool>` — full locations/global/workforcePools/<pool-id> resource for GE sign-in (separate from /mcp auth)
- `--allow-unauthenticated-mcp` — acknowledge that no-auth leaves the public /mcp endpoint without a bearer-token gate
- `--confirm-engine-egress-reroute` — acknowledge that Agent Gateway binding reroutes all agent egress for the engine
- `--agent-identity-principal-set <resource>` — documented principalSet://agents.global... resource granted registry, gateway, and runtime access
- `--gateway-authorization-policy <resource>` — full projects/<project>/locations/<region>/authzPolicies/<policy> resource attached to the gateway
- `--out <dir>` — compatibility flag; must resolve to the bundle root because target kits are certified in place
- `--json` — emit the plan + compatibility report as JSON

### `anvil deploy`
`anvil deploy [options] [command]`

Inspect Cloud Run, credentials, and durable idempotency deployment plans.

Plan and inspection only: Anvil prints generated Dockerfile/Terraform/env instructions and verifies the generated durable idempotency-store contract. It does not call Cloud Run, Firestore, apply Terraform, or hold cloud credentials.

#### `anvil deploy cloud-run`
`anvil deploy cloud-run [options] <dir>`

The Cloud Run deployment plan (Terraform owns config, Cloud Build the pipeline).

Options:
- `--env <env>` — target environment

#### `anvil deploy credentials`
`anvil deploy credentials [options] <dir>`

The upstream (outbound) credential plan: exact env vars + copy-paste provisioning.

Prints, per auth shape, the exact ANVIL_<PROFILE>_* env vars the runtime resolver reads to reach the upstream — names only — with ready-to-run gcloud/terraform commands and a pre-assembled Secret Manager console link. Nothing here holds or echoes a secret value.

Options:
- `--env <env>` — auth profile / target environment
- `--project <id>` — GCP project id for links and sm:// references
- `--json` — emit one machine-readable credential plan
- `--tfvars` — emit only Terraform auto-tfvars JSON for an external plan work directory

#### `anvil deploy ledger`
`anvil deploy ledger [options] <dir>`

Inspect durable-write coverage and the generated Firestore ledger contract.

Read-only and offline. Lists every approved write and its idempotency posture, verifies deploy/idempotency-store.json plus every compiler-owned generated byte against canonical AIR and persisted generator inputs, and prints the selected Firestore database/collection/ANVIL_LEDGER coordinate. Shared mode (default) uses an existing platform-owned trust-domain database; dedicated mode creates one capability-owned database. Static wiring is not live readiness: after applying the reviewed Terraform plan, require the deployed /readyz probe to return 200. Firestore Native is the built-in managed backend; Firebase client SDKs, AlloyDB, and Spanner are not silently substituted.

Options:
- `--project <id>` — resolve {project_id} in the planned ledger URI
- `--database <id>` — exact Firestore Native database id, including (default)
- `--database-mode <mode>` — shared (existing trust-domain database) or dedicated (create one database)
- `--location <location>` — reviewed immutable Firestore location; required only in dedicated mode
- `--ttl-seconds <seconds>` — completed replay-result retention (60..31536000; defaults from the generated contract)
- `--json` — emit one machine-readable offline readiness report
- `--tfvars` — emit only Terraform input JSON (requires --project and --database; dedicated also requires --location)

### `anvil certify`  *(mutates)*
`anvil certify [options] <path>`

Run static bundle-assurance gates and write certification.json.

Static assurance only: four deterministic gates judge the bundle as emitted. CONTRACT re-validates AIR, generated-surface alignment, and persisted target-kit regeneration; SAFETY checks confirmation, retry/idempotency, and secret handling; SEMANTIC checks descriptions and routing; RUNTIME checks generated mocks, evals, conformance tests, and deploy artifacts. The record binds to a content hash, so generated-byte tampering invalidates it. It does not boot or invoke a surface; use `anvil selftest`, `anvil conformance`, and `anvil simulate` for executable evidence.

Options:
- `--json` — emit the full certification as JSON

### `anvil selftest`  *(mutates)*
`anvil selftest [options] <dir>`

Boot the bundle's mock + MCP servers and prove the generated surface end-to-end.

Loopback self-test for bundles with no reference server to compare against: starts the generated mock upstream (mock/server.mjs) and the generated MCP server (mcp/server.js) pointed at it via ANVIL_BASE_URL, then invokes every approved tool over the real MCP transport. Checks: the tool surface equals the approved operations (surface), every argument reaches the wire faithfully and the response round-trips (fidelity), confirmation gates refuse before any side effect (confirmation-gate), documented upstream errors surface as structured envelopes (error-mapping), and non-idempotent mutations are never auto-retried (retry checks). Writes selftest.report.json into the bundle. Exit 0 only when no check fails.

Options:
- `--json` — emit the full report as JSON

### `anvil conformance`  *(mutates)*
`anvil conformance [options] <dir>`

Prove the CLI, MCP, and skill surfaces agree on every operation, end-to-end.

Tri-surface conformance for a generated bundle. Boots the bundle's mock upstream, then drives every approved operation through BOTH the generated MCP server (mcp/server.js, over the real MCP transport) and the generated CLI entrypoint (cli/<svc>.mjs, as a child process) against that mock. Checks: the skill, CLI catalog, and MCP tool list name the same operations with the same public handles (surface-agreement); the skill documents the exact confirmation/idempotency/retry posture the runtime enforces (skill-claim); the same input reaches the wire identically on both surfaces and matches the AIR contract (wire-agreement); and a confirmation-gated mutation refuses without --confirm, before any side effect, on both surfaces (gate-agreement). Writes conformance.report.json into the bundle. Exit 0 only when no check fails.

With --live <config.json>, probes a REAL deployed MCP endpoint instead of the mock. Before any tool call, the endpoint must attest the exact SHA-256 of the local deploy/runtime artifact. It then verifies the certified surface and production confirmation gate, and invokes only reads explicitly opted into by the operator — never a real mutation. For delegated/OBO identity, at least one successful read is required for every distinct identity and credential contract group; a write-only group remains unverified and the separate identity-live gate fails. /readyz, OIDC discovery, JWKS reachability, and matching tool names alone never prove readiness. The config names the endpoint (mcpUrl) and auth headers, whose ${VAR} values resolve from the environment; the onus of correct config is on the operator. Writes conformance.live.report.json.

Options:
- `--live <config>` — probe a real deployed MCP endpoint named in this JSON config
- `--json` — emit the full report as JSON

### `anvil observe`
`anvil observe [options] <dir>`

Compare a bundle against the running application it was compiled from.

Two passes, both propose-only. CONTRACT DRIFT: fetches the contract the application publishes about itself (springdoc /v3/api-docs, Swashbuckle /swagger/v1/swagger.json, a WSDL) and diffs it against the bundle's AIR through the same differ `anvil drift` uses — the app is the authority on its own shape. IMPLEMENTATION DRIFT: drives the operator's opt-in READS against the real application through the bundle's own generated MCP server, so the exact executor path the CLI, MCP server, and SDKs share is what gets exercised, then reports what the app returned against what AIR declares. A mutation is never invoked, whatever the config lists. Findings become an Anvil manifest proposal weighed by the same asymmetric-trust reconciler `anvil enrich` uses: observed traffic may tighten freely, and the one claim a read genuinely earns is that an operation the contract declares is not there. Review the proposal, then `anvil compile --manifest`. Writes observe.report.json. RECORDED TRAFFIC (--from-records <dir>): instead of probing live, folds the execution-record spool a deployed server wrote (set ANVIL_RECORDS_DIR on the generated MCP/HTTP server; records carry outcomes, error codes, retry and ledger behaviour — no secrets, no payloads) into recorded_traffic evidence through the same reconciler. Traffic corroborates freely; the one patch it earns is deprecation, when every one of enough calls answered not_found. Writes traffic.report.json.

Options:
- `--config <file>` — JSON config naming the running application
- `--from-records <dir>` — fold a serving-path record spool (ANVIL_RECORDS_DIR) into evidence instead of probing live
- `--write <manifest>` — write the proposed manifest here instead of printing it
- `--capture <file>` — save the contract the application served, to re-capture with `anvil source add`
- `--json` — emit the full report as JSON

### `anvil benchmark`
`anvil benchmark [options] <dir>`

Route each intent example over the served tool catalog and score whether the agent reaches the right tool.

Agent-task benchmark. For each approved operation's skill.intentExamples entry, routes the intent over (a) the curated catalog the generated MCP server serves and (b) the bare catalog the source document supplies on its own, then checks required parameters are satisfiable from surface examples. A task passes when the curated route reaches the right tool and its params are satisfiable; the bare score is the baseline that shows what compilation bought. Routing is deterministic (lexical) by default; pass --agent <command> to route with a real model over stdin/stdout. Writes benchmark.report.json, including deterministic mis-route clustering: confusable tool families with their evidence, and routing hubs reported apart — candidates for composition or collapse, never decisions. Exit 0 only when the score meets --check.

Options:
- `--check <threshold>` — exit non-zero if score < threshold (0..1)
- `--agent <command>` — route with a real model: a command that reads the routing prompt on stdin and prints {"tool": "<name>"}

### `anvil simulate`  *(mutates)*
`anvil simulate [options] <dir>`

Drive the full safety matrix through the simulator and report coverage.

Mechanistic coverage for a bundle's approved surface. Enumerates the matrix (each operation × the dimensions that apply: auth scope gating, confirmation refusal, required-idempotency + replay, injected faults, pagination, and disclosure cost against the agent's context budget) and drives every cell through the deterministic simulator, checking each against an independent contract expectation. Then runs the mutation battery — deliberately weakening each safety control and proving the surface signature detects it. Reports per-dimension coverage and mutants killed. Deterministic: same seed + contract → same cells. Writes simulation.report.json. Exit 0 only when every cell holds and every applicable safety mutant is killed.

Options:
- `--seed <n>` — deterministic simulator seed
- `--json` — emit the full report as JSON

### `anvil disclosure`
`anvil disclosure [options] <dir>`

Report where an agent's context budget goes, attributed to fields.

Read-only. A disclosure bill of materials for a compiled bundle: every operation ranked by the exact tokens its MCP tool surface costs an agent in `tools/list`, with that cost attributed to the specific contributors that produced it — the description, each input schema property, the safety metadata — so the output names the field to fix rather than the service to blame. Rolls up per capability and per service, and reports the disclosure ladder's verdict (what laddering already saved, and what remains over the surface budget) alongside tokens-to-reach — what an agent must read, starting cold, before it holds one operation's input schema, with the round trips that cost buys. Tool-surface and reach figures are exact measurements of the bytes the runtime publishes, counted under o200k_base. Response figures are projections read from `simulation.report.json` under a recorded seed and are labelled as such everywhere; a report bound to different bundle content is reported as stale and refused rather than used, and a bundle whose responses were never measured says so rather than reporting zeros. A report that completed exits 0; `--check` gates non-zero on operations whose measured tool surface exceeds the per-tool budget.

Options:
- `--top <n>` — how many operations to detail (default 10; 0 for all)
- `--reach` — detail the tokens-to-reach distribution and its round trips
- `--check` — gate: exit non-zero when a tool surface exceeds its budget
- `--json` — emit the full bill of materials as JSON

### `anvil pack`
`anvil pack [options] [command]`

Build, verify, and install content-addressed system packs.

#### `anvil pack build`  *(mutates)*
`anvil pack build [options] <dir>`

Assemble a bundle into one verifiable, content-addressed pack file.

Reads a generated bundle and assembles it into an Agent System Pack: every generated file becomes a digested artifact, the artifact manifest and pack digests are computed over the content, and the bundle's certification status (certification.json, when present) is carried on the pack envelope. Derived records (*.report.json and other evidence files) stay out, exactly as they stay out of the bundle's identity hash. The output is one deterministic file: the same bundle always packs to byte-identical output.

Options:
- `--out <file>` — where to write the pack (default: <dir>/system.pack.json)

#### `anvil pack verify`
`anvil pack verify [options] <file>`

Recompute every digest in a pack file and report what diverged.

Reads a pack file and verifies it end to end: envelope entries re-hash against their claimed digests, every artifact's content re-hashes against the manifest, and the manifest and pack digests recompute. Failures are reported one per line — a verify that cannot say what diverged is just a slower way of being wrong.

#### `anvil pack install`  *(mutates)*
`anvil pack install [options] <source>`

Verify a pack — digests and certification — then unpack it, transactionally.

Fetches a pack from a local path or an https:// URL, verifies every content digest, the artifact manifest digest, and the pack digest, and checks the pack carries a certification with status 'certified' — all BEFORE a single file lands at the target. An uncertified or failed-certification pack refuses unless --allow-uncertified states the operator's intent in so many words. Unpacking stages into a temporary directory and renames it in, so an interrupted install leaves either nothing or a complete bundle. Refuses to overwrite an existing target.

Options:
- `--out <dir>` — directory to install the bundle into (must not exist)
- `--allow-uncertified` — install even when the pack carries no 'certified' certification (recorded in the output)

### `anvil publish`  *(mutates)*
`anvil publish [options] <dir>`

Prepare a gated deployment plan; make no cloud API calls.

Compatibility note: `publish` prepares a deployment plan; it does not publish, apply, deploy, or contact a cloud API. Fresh static assurance and fresh passing selftest, conformance, and simulation reports must all match the current bundle content. On success it prints the Cloud Run operator plan and writes publication.json with the evidence snapshot. `--allow-uncertified` and `--allow-incomplete-evidence` are explicit non-prod-only waivers; prod always fails closed. Cloud Run is the sole target and therefore the default.

Options:
- `--target <target>` — publish target
- `--env <env>` — target environment (default from ANVIL_ENV, else dev)
- `--allow-uncertified` — waive static assurance for this plan (non-prod only)
- `--allow-incomplete-evidence` — waive missing, stale, corrupt, or failing executable evidence (non-prod only)
- `--json` — emit the publication record as JSON

### `anvil sync`  *(mutates)*
`anvil sync [options] <spec-path> <path>`

Detect semantic drift between the current spec and a stored AIR contract.

Layer 6 — drift and recertification. Re-imports the spec through the Layer 0 snapshot layer (unchanged content is a fast path: same sourceHash, no drift), recompiles it in memory, and diffs the fresh contract against the stored AIR: operations added/removed, field type and requiredness changes, auth scope/type changes, retry/idempotency/confirmation semantics, pagination, and documentation-only edits (info). Safety-loosening drift (a dropped confirmation, new retries, an idempotency claim crossing "none", auth vanishing) is blocking; other safety-semantic drift is high. Reports which capabilities are affected and which certifications must be re-earned even though their bundle bytes are untouched, then writes a drift record to .anvil/drift/<id>.json. Never mutates AIR, never applies spec changes, never touches capability lifecycles. Exits non-zero on high/blocking drift so it can gate a pipeline.

Options:
- `--manifest <file>` — Anvil manifest applied to the in-memory recompile
- `--root <ws>` — workspace root for .anvil/sources and .anvil/drift
- `--json` — emit the drift verdict (and record) as JSON

### `anvil drift`  *(mutates)*
`anvil drift [options] [command]`

List, inspect, and mark reviewed the drift records `anvil sync` stored.

`list` shows every stored drift record with its severity mix and review status; `show <id>` prints one record in full (items grouped by severity, affected capabilities, invalidated certifications). `accept <id> [--note ..]` stamps reviewedAt on the record — bookkeeping only: accepting drift never edits AIR, never restores a certification, and never changes capability lifecycles. Act on drift deliberately with `anvil compile`, `anvil certify`, and the capability review commands.

#### `anvil drift list`
`anvil drift list [options]`

Every stored drift record as a small table.

Options:
- `--root <ws>` — workspace root for .anvil/drift
- `--json` — emit the records as JSON

#### `anvil drift show`
`anvil drift show [options] <id>`

One drift record in full.

Options:
- `--root <ws>` — workspace root for .anvil/drift
- `--json` — emit the record as JSON

#### `anvil drift accept`
`anvil drift accept [options] <id>`

Stamp the record reviewed (bookkeeping only).

Options:
- `--note <note>` — review note stored on the record
- `--root <ws>` — workspace root for .anvil/drift
- `--json` — emit the reviewed record as JSON

### `anvil run`  *(mutates)*
`anvil run [dir] [args...]`

Invoke an operation through the safety runtime.

Supports --dry-run, --confirm, --idempotency-key, --schema, --examples, --errors, --policy, --explain, --json, --trace. Route through MCP with --mcp stdio, --mcp <https-url>, or explicit legacy --mcp sse:<url>; --mcp-token-env <NAME> reads a remote bearer token from that environment variable without putting the token in argv. Unsafe mutations refuse without --confirm; failures are structured envelopes with stable exit codes (2 input, 3 needs-flags, 4 auth, 5 policy, 6 upstream state, 7 upstream availability).

### `anvil job`
`anvil job [options] [command]`

Answer a job awaiting a human decision mid-flight.

#### `anvil job answer`  *(mutates)*
`anvil job answer [options] <dir> <job_id>`

Submit a human decision for a job awaiting approval.

Calls the named APPROVED mutation as the real upstream decision operation — the exact same AIR operation-call path every other mutation uses, authenticated and idempotency-tracked identically. Not a resume of a paused execution: the upstream already tracks its own pending-approval state (AsyncContract.pendingStates including 'awaiting_human_input'); this places the call it is waiting on. --input supplies any of the decision operation's OWN parameters beyond job_id/decision/note (e.g. an application id in a different field name) as a JSON object merged in verbatim.

Options:
- `--operation <id>` — the approved mutation to call as the decision operation
- `--decision <decision>` — approve or reject
- `--note <text>` — optional free-text rationale
- `--input <json>` — JSON object of the decision operation's own extra parameters
- `--confirm` — confirm a non-idempotent decision call
- `--idempotency-key <key>` — caller-supplied idempotency key for the decision call
- `--json` — emit the full result as JSON

### `anvil serve`
`anvil serve [options] [command]`

Serve the generated MCP server over stdio.

Boots the MCP server for local agent use. The same server deploys to Cloud Run for remote use.

#### `anvil serve mcp`
`anvil serve mcp [options] <dir>`

Serve the bundle's MCP server on stdio.

### `anvil package`  *(mutates)*
`anvil package [options] [command]`

Validate and package the portable skill package.

The skill is also served over MCP as anvil://skill/<service>/... resources.

#### `anvil package skill`
`anvil package skill [options] <dir>`

Validate the bundle's skill package against the Agent Skills spec.

Checks SKILL.md frontmatter (spec-legal name and description), that every path SKILL.md references exists, that every markdown file self-describes with frontmatter, that examples parse and cover their schema's required fields, and that no absolute paths leak. With --out, copies the skill to <out>/<skill-name>/ so the directory name matches the frontmatter name (the spec rule).

Options:
- `--out <dir>` — copy the validated skill to <out>/<skill-name>/

### `anvil skill`
`anvil skill [options] [out-dir]`

Emit the skill that lets an agent harness operate anvil.

Generates SKILL.md plus reference/ and evals/ for operating the anvil CLI itself. The command reference is derived by walking anvil's own Commander tree — the same tree that parses this invocation — so the skill never drifts from the CLI.
