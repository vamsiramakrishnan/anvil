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

### `anvil compile`  *(mutates)*
`anvil compile [options] [spec]`

Compile a locked source snapshot into a full tool bundle (CLI + MCP + skill + deploy).

Compiles from an immutable Layer 0 source snapshot: everything the compiler reads — the spec and every local $ref — comes from the locked bytes, and the AIR is bound back to the snapshot's identity. Pass `--source <snapshot-id>` to compile an already-locked snapshot (add `--entrypoint <path>` to disambiguate a multi-entrypoint source), or pass a spec path to import-and-lock it first, then compile that snapshot. Parses OpenAPI/Swagger, classifies effects and idempotency, applies the manifest, validates safety, and writes the bundle. Non-idempotent mutations are escalated to review_required — they are not exposed until approved.

Options:
- `--source <snapshot-id>` — compile an already-locked snapshot instead of a spec file
- `--entrypoint <path>` — snapshot-relative entrypoint when a source has several
- `--manifest <file>` — Anvil manifest with semantic overrides
- `--service <id>` — override the derived service id
- `--out <dir>` — bundle output directory (default generated/<service-id>)
- `--endpoint <url>` — MCP endpoint recorded in the generated artifacts
- `--human-approval <policy>` — require explicit human approval on gated mutations: none | unsafe | all (per-op manifest `human_approval` overrides)
- `--root <ws>` — workspace root for .anvil/sources

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

### `anvil capability`  *(mutates)*
`anvil capability [options] [command]`

Review capability groupings: propose, inspect, approve, reject, or diff.

The capability review lifecycle. `propose` re-runs discovery and prints each grouping with its provenance and tool-budget verdict (read-only); `list` and `show` inspect stored capabilities (small summaries by default; add --operations/--auth/--evidence/--json for detail); `diff` reports drift between a stored capability and fresh discovery. `approve`/`reject` persist the review decision to the AIR file. Approval enforces the tool budget: a capability disclosing more than 20 tools is blocked without --allow-large (more than 15 warns). Only an approved capability can be built with `anvil build`.

#### `anvil capability propose`
`anvil capability propose [options] <path>`

(Re)run discovery; print proposals with provenance and budget findings.

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
- `--allow-large` — waive the >20-tool budget block
- `--note <note>` — review note persisted with the decision

#### `anvil capability reject`
`anvil capability reject [options] <path> <capability-id>`

Record why the grouping is not the right unit.

Options:
- `--reason <reason>` — rejection reason persisted with the decision

#### `anvil capability diff`
`anvil capability diff [options] <path> <capability-id>`

Report drift between a stored capability and fresh discovery.

### `anvil refine`  *(mutates)*
`anvil refine [options] [command]`

Detect, propose, measure, and apply refinements to AIR (the quality flywheel).

`anvil refine plan` runs Anvil's deterministic detectors and reports a refinement plan — documentation gaps, weak naming/routing, unproven safety semantics, and mock/eval coverage holes — grouped by severity, category, and the narrow skill that owns each fix. `anvil refine skills` lists those skills as typed contracts (trigger, evidence policy, output boundary, validation), whose executor is kept separate from their semantics. `anvil refine run` routes each in-scope deficiency to its skill, proposes an evidence-backed semantic patch, validates it, then MEASURES only the eval families it affects — with a safety guard that must never regress — and reconciles the result through an auto-approval policy into a reviewable refinement pack (--severity/--skill/--safe-only/--out). `anvil refine review <pack-dir>` prints the human review. `anvil refine apply` applies only the auto-approved refinements to AIR (the sole mutating step; --dry-run to preview), which `anvil compile` then reprojects across the CLI, MCP, and skill at once.

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

#### `anvil refine review`
`anvil refine review [options] <pack-dir>`

Print a refinement pack's human review.

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
- `--command <command>` — agent CLI to drive (default: claude)
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
- `--write <manifest>` — write the proposed manifest here instead of printing it
- `--json` — emit the per-operation decisions as JSON

### `anvil estate`
`anvil estate [options] [command]`

Inventory and import gateway estates (Apigee, Kong, WSO2, MuleSoft, API Connect).

Reads a vendor gateway export — a bare config document, or a ZIP/JAR archive (decoded through the hardened archive harness: zip-slip, symlink, and bomb defences with every rejection reported) — and normalizes it through the vendor adapter into the one compiler pipeline. `inventory` lists the estate's APIs without compiling anything; `import` compiles one API into a normal Anvil bundle, where the usual approval gate applies: risky operations land review_required and are not exposed until approved.

#### `anvil estate inventory`
`anvil estate inventory [options] <export>`

List the APIs in a gateway export without compiling anything.

Options:
- `--vendor <vendor>` — gateway vendor (kong | apigee | wso2 | mulesoft | api_connect)
- `--entry <path>` — archive entry holding the config, when the archive has several
- `--json` — emit the inventory snapshot as JSON

#### `anvil estate import`  *(mutates)*
`anvil estate import [options] <export>`

Import one API from a gateway export and compile it into a bundle.

Options:
- `--vendor <vendor>` — gateway vendor (kong | apigee | wso2 | mulesoft | api_connect)
- `--api <id>` — API id from `estate inventory` (optional when the estate has one)
- `--entry <path>` — archive entry holding the config, when the archive has several
- `--service <id>` — override the derived service id
- `--out <dir>` — bundle output directory (default generated/<service-id>)
- `--json` — emit a machine-readable import report (for CI oracles)

### `anvil sources`
`anvil sources [options] [command]`

List enrichment sources, or scaffold a sources.yaml with `sources init`.

The published MCP servers Anvil enriches from. `anvil sources` (or `sources list`) shows the built-in profiles — GitHub, GitLab, Confluence, Jira, Notion, Postman — with the default server for each and whether its evidence can loosen safety (code hosts) or only tighten/corroborate (docs, Postman). `anvil sources init <dir>` scaffolds a sources.yaml for a compiled service and lists the interview questions to finish it.

#### `anvil sources list`
`anvil sources list [options]`

List the built-in enrichment source profiles.

#### `anvil sources init`
`anvil sources init [options] <path>`

Scaffold a sources.yaml for a service, with the interview questions to finish it.

Reads the compiled AIR and proposes a sources.yaml: the two evidence poles every enrichment wants — a CODE host (the only tier that can loosen safety) and a DOC host (tightens/corroborates, supplies intent phrases) — plus any product vendor it detects (Salesforce, SAP) and a Postman source when the spec came from a collection. It also emits the exact QUESTIONS a coding harness should put to the user (which repo, which space, which env vars) — the interview is agent-native: propose, then refine with the operator. Propose-only; `--write <file>` saves the scaffold, `--json` emits the questions + proposal for a harness.

Options:
- `--write <file>` — write the scaffolded sources.yaml here
- `--json` — emit the proposal + interview questions as JSON

### `anvil approve`  *(mutates)*
`anvil approve [options] <path> <operation-ids...>`

Approve operations so they are exposed by the generated artifacts.

Only approved operations appear in the MCP server, CLI catalog, and compiled runtime manifest. Approve deliberately, after inspecting risk.

### `anvil lint`
`anvil lint [options] <path>`

Show safety diagnostics; exit non-zero if there are errors.

Surfaces unproven idempotency, missing confirmation, duplicate names, and incoherent retry policy.

### `anvil build`  *(mutates)*
`anvil build [options] <path> <capability-id>`

Compile one approved capability into an aligned CLI + MCP + skill bundle.

Narrows the AIR document to the capability's approved operations and reachable schemas, then reuses the whole-service generator, so the capability bundle is the same aligned projection of a smaller model. Refuses (with a structured error) a capability that is missing, not lifecycle-approved, or would build empty. Stamps a content-addressed bundle.json (capabilityHash + contractHash shared by every surface); rebuilding unchanged input reproduces identical hashes.

Options:
- `--out <dir>` — bundle output directory (default generated/<capability-id>)
- `--endpoint <url>` — MCP endpoint recorded in the generated artifacts

### `anvil review`  *(mutates)*
`anvil review [options] <dir>`

Model-driven semantic review of a bundle's agent surfaces (MCP/CLI/skill).

Drives a cheap reviewer model (default Haiku via the `claude` CLI) through Anvil's artifact-review SOP over a generated bundle: MCP tool descriptions must be truthful to each operation's effect/risk, the CLI surface must teach confirm/idempotency/dry-run on mutating commands, the skill doc must teach the safety posture and document no phantom operations, and all three surfaces must agree. Every finding must cite verbatim evidence from the bundle; ungrounded findings are discarded mechanically. Writes review.report.json into the bundle. Useful for spec sources with no reference server to backtest against.

Options:
- `--model <model>` — reviewer model passed to the driver
- `--driver-command <bin>` — headless agent CLI to drive
- `--json` — emit the full review report as JSON

### `anvil certify`  *(mutates)*
`anvil certify [options] <path>`

Run the certification gates over a bundle and write certification.json.

Four deterministic gates judge the bundle as emitted: CONTRACT (AIR re-validates and the MCP tool list, CLI catalog, and runtime manifest expose exactly the same approved operations), SAFETY (risky mutations confirm, no retry without a proven basis or idempotency, coherent secret handling), SEMANTIC (approved operations are described, distinct, and routable by intent; blocking dispositions stop certification), and RUNTIME (mocks, evals, conformance test, and deploy artifacts are present and consistent). The certification binds to a content hash of the bundle, so any tamper invalidates it. Exit 0 only when every gate passes.

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

With --live <config.json>, probes a REAL deployed MCP endpoint instead of the mock: it verifies the deployed server serves exactly the certified surface and that its confirmation gate refuses in production, and invokes only the reads the config opts into — it never drives a real mutation. The config names the endpoint (mcpUrl) and auth headers, whose ${VAR} values resolve from the environment; the onus of correct config is on the operator. Writes conformance.live.report.json.

Options:
- `--live <config>` — probe a real deployed MCP endpoint named in this JSON config
- `--json` — emit the full report as JSON

### `anvil simulate`  *(mutates)*
`anvil simulate [options] <dir>`

Drive the full safety matrix through the simulator and report coverage.

Mechanistic coverage for a bundle's approved surface. Enumerates the matrix (each operation × the safety dimensions that apply: auth scope gating, confirmation refusal, required-idempotency + replay, injected faults, pagination) and drives every cell through the deterministic simulator, checking each against an independent contract expectation. Then runs the mutation battery — deliberately weakening each safety control and proving the surface signature detects it. Reports per-dimension coverage and mutants killed. Deterministic: same seed + contract → same cells. Writes simulation.report.json. Exit 0 only when every cell holds and every applicable safety mutant is killed.

Options:
- `--seed <n>` — deterministic simulator seed
- `--json` — emit the full report as JSON

### `anvil publish`  *(mutates)*
`anvil publish [options] <dir>`

Gated publish: verify the certification, then emit the deployment plan.

Publication requires a PASSING certification whose bundle hash matches the current bundle content — a stale certificate fails. On success it prints the Cloud Run deployment plan (same as `anvil deploy cloud-run`) and writes publication.json into the bundle. `--allow-uncertified` waives the gate for non-prod environments only; publishing to prod (via --env prod or ANVIL_ENV=prod) fails closed without a valid certification, flag or no flag. No cloud credentials are held and no API calls are made.

Options:
- `--target <target>` — publish target
- `--env <env>` — target environment (default from ANVIL_ENV, else dev)
- `--allow-uncertified` — waive the certification gate (non-prod only)
- `--json` — emit the publication record as JSON

### `anvil deploy`
`anvil deploy [options] [command]`

Print the Cloud Run deployment plan for a bundle.

Anvil generates the deploy artifacts (Dockerfile, service YAML, env/secret contracts); it does not hold cloud credentials.

#### `anvil deploy cloud-run`
`anvil deploy cloud-run [options] <dir>`

The Cloud Run deployment plan (Terraform owns config, Cloud Build the pipeline).

Options:
- `--env <env>` — target environment

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
`anvil run <dir> [args...]`

Invoke an operation through the safety runtime.

Supports --dry-run, --confirm, --idempotency-key, --schema, --examples, --errors, --policy, --explain, --json, --trace. Unsafe mutations refuse without --confirm; failures are structured envelopes with stable exit codes (2 input, 3 needs-flags, 4 auth, 5 policy, 6 upstream state, 7 upstream availability).

### `anvil serve`
`anvil serve [options] [command]`

Serve the generated MCP server over stdio.

Boots the MCP server for local agent use. The same server deploys to Cloud Run for remote use.

#### `anvil serve mcp`
`anvil serve mcp [options] <dir>`

Serve the bundle's MCP server on stdio.

### `anvil package`
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
