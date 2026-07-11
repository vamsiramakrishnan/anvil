# anvil commands

### `anvil compile`  *(mutates)*
`anvil compile <spec> [--manifest f] [--service id] [--out dir] [--endpoint url]`

Compile a spec into a full tool bundle (CLI + MCP + skill + deploy).

Parses OpenAPI/Swagger, classifies effects and idempotency, applies the manifest, validates safety, and writes the bundle. Non-idempotent mutations are escalated to review_required — they are not exposed until approved.

### `anvil inspect`
`anvil inspect <dir|air.yaml> [--json]`

Show the operation catalog and each operation's safety posture.

Read-only. Use before approving to see effect, risk, idempotency, retry-safety, and state.

### `anvil assess`
`anvil assess <dir|air.yaml> [<operation>] [--severity S] [--explain] [--json]`

Triage which operations are agent-ready, and explain every blocking gap.

Read-only. Runs Anvil's deterministic detectors and gives every operation a readiness disposition — ready, refinement_required, human_decision_required, blocked, or excluded — with a service-level score and summary. Reuses the same detectors as `anvil refine plan`, so the per-operation triage never disagrees with the deficiency list. Drill into one operation, filter by minimum severity, or `--explain` why each gap matters to an agent. Exits non-zero when any operation is blocked.

### `anvil lint`
`anvil lint <dir|air.yaml>`

Show safety diagnostics; exit non-zero if there are errors.

Surfaces unproven idempotency, missing confirmation, duplicate names, and incoherent retry policy.

### `anvil approve`  *(mutates)*
`anvil approve <dir|air.yaml> <operation-id...>`

Approve operations so they are exposed by the generated artifacts.

Only approved operations appear in the MCP server, CLI catalog, and compiled runtime manifest. Approve deliberately, after inspecting risk.

### `anvil enrich`
`anvil enrich <dir|air.yaml> --sources <file> [--write <manifest>] [--json]`

Connect to published MCP servers (GitHub, Confluence, …) and propose a manifest patch.

Anvil is an MCP client here: it connects to the MCP servers those systems already publish, gathers evidence per operation, and proposes idempotency/confirmation/etc. Propose-only — nothing touches AIR. Loosening safety requires high-reliability (implementation/traffic) evidence; review the patch, then `anvil compile --manifest`.

### `anvil sources`
`anvil sources`

List the enrichment sources (published MCP servers) Anvil can connect to.

Shows the built-in profiles — GitHub, GitLab, Confluence, Jira, Notion, Postman — with the default server Anvil runs for each and whether its evidence can loosen safety (code hosts) or only tighten/corroborate (docs, Postman).

### `anvil refine`  *(mutates)*
`anvil refine <plan|skills|skill|run|review|apply> <dir|air.yaml> [flags]`

Detect, propose, measure, and apply refinements to AIR (the quality flywheel).

`anvil refine plan` runs Anvil's deterministic detectors and reports a refinement plan — documentation gaps, weak naming/routing, unproven safety semantics, and mock/eval coverage holes — grouped by severity, category, and the narrow skill that owns each fix. `anvil refine skills` lists those skills as typed contracts (trigger, evidence policy, output boundary, validation), whose executor is kept separate from their semantics. `anvil refine run` routes each in-scope deficiency to its skill, proposes an evidence-backed semantic patch, validates it, then MEASURES only the eval families it affects — with a safety guard that must never regress — and reconciles the result through an auto-approval policy into a reviewable refinement pack (--severity/--skill/--safe-only/--out). `anvil refine review <pack-dir>` prints the human review. `anvil refine apply` applies only the auto-approved refinements to AIR (the sole mutating step; --dry-run to preview), which `anvil compile` then reprojects across the CLI, MCP, and skill at once.

### `anvil case`  *(mutates)*
`anvil case <open|list|inspect|add-evidence|validate-claims|synthesize|validate-proposal|investigate|finalize|close> ...`

Run a bounded investigation for one deficiency as an isolated case.

The investigation framework. `anvil case list <dir>` shows the deficiencies a case can be opened for; `anvil case open <dir> <target-key>` materializes an isolated case workspace (CASE.md + task/target/evidence-policy/allowed-tools/expected-output.schema + workspace/ + output/) that gives a coding agent a *case, not a prompt*. Inside a case, the agent works only with rails that enforce Anvil semantics — repository search and language tooling are the agent's own job, not Anvil's: `inspect`, `add-evidence` (enforces the source AND predicate policy), `validate-claims` (strength + contradictions + predicate policy), `synthesize` (composes the proposal from gathered claims), `validate-proposal` (deterministic validation), and `finalize` (records an honest status — proposal_generated / conflicted / insufficient_evidence / …). `anvil case investigate <case>` drives the live coding agent; `anvil case close <case> <air>` re-enters Anvil's rails — validating and reconciling the proposal into a refinement, bound to the case identity. The agent owns investigation and synthesis; Anvil owns admissibility, safety, validation, and application. AIR is never edited by a case.

### `anvil capability`  *(mutates)*
`anvil capability <propose|list|show|approve|reject|diff> <dir|air.yaml> [id] [flags]`

Review capability groupings: propose, inspect, approve, reject, or diff.

The capability review lifecycle. `propose` re-runs discovery and prints each grouping with its provenance and tool-budget verdict (read-only); `list` and `show` inspect stored capabilities (small summaries by default; add --operations/--auth/--evidence/--json for detail); `diff` reports drift between a stored capability and fresh discovery. `approve`/`reject` persist the review decision to the AIR file. Approval enforces the tool budget: a capability disclosing more than 20 tools is blocked without --allow-large (more than 15 warns). Only an approved capability can be built with `anvil build`.

### `anvil build`  *(mutates)*
`anvil build <dir|air.yaml> <capability-id> [--out dir]`

Compile one approved capability into an aligned CLI + MCP + skill bundle.

Narrows the AIR document to the capability's approved operations and reachable schemas, then reuses the whole-service generator, so the capability bundle is the same aligned projection of a smaller model. Refuses (with a structured error) a capability that is missing, not lifecycle-approved, or would build empty. Stamps a content-addressed bundle.json (capabilityHash + contractHash shared by every surface); rebuilding unchanged input reproduces identical hashes.

### `anvil run`  *(mutates)*
`anvil run <dir|air.yaml> <resource> <action> [flags]`

Invoke an operation through the safety runtime.

Supports --dry-run, --confirm, --idempotency-key, --schema, --examples, --errors, --policy, --explain, --json, --trace. Unsafe mutations refuse without --confirm; failures are structured envelopes with stable exit codes (2 input, 3 needs-flags, 4 auth, 5 policy, 6 upstream state, 7 upstream availability).

### `anvil serve`
`anvil serve mcp <dir>`

Serve the generated MCP server over stdio.

Boots the MCP server for local agent use. The same server deploys to Cloud Run for remote use.

### `anvil package`
`anvil package skill <dir>`

Locate and verify the portable skill package.

The skill is also served over MCP as anvil://skill/<service>/... resources.

### `anvil deploy`
`anvil deploy cloud-run <dir> [--env prod]`

Print the Cloud Run deployment plan for a bundle.

Anvil generates the deploy artifacts (Dockerfile, service YAML, env/secret contracts); it does not hold cloud credentials.

### `anvil source`  *(mutates)*
`anvil source <add|list|show|validate> [args] [--json]`

Import and lock API source specs as content-addressed snapshots.

Layer 0 — capture what the customer actually supplied, before any compilation. `anvil source add <path|dir>` detects the spec format (OpenAPI 3.0/3.1 or Swagger 2.0, YAML or JSON) without compiling, hashes the file set deterministically, and locks a snapshot under .anvil/sources/<id>/ (source.json plus verbatim raw/ copies). A directory of specs becomes one snapshot with many files. `list` and `show` are read-only; `validate <id>` re-hashes raw/ and confirms it still matches the locked source.json, so tampering or drift is caught before it can contaminate a compile. The sourceHash is content-derived only — re-importing unchanged content yields the same hash — and broken input produces structured diagnostics, never a crash.

### `anvil certify`  *(mutates)*
`anvil certify <dir|air.yaml> [--json]`

Run the certification gates over a bundle and write certification.json.

Four deterministic gates judge the bundle as emitted: CONTRACT (AIR re-validates and the MCP tool list, CLI catalog, and runtime manifest expose exactly the same approved operations), SAFETY (risky mutations confirm, no retry without a proven basis or idempotency, coherent secret handling), SEMANTIC (approved operations are described, distinct, and routable by intent; blocking dispositions stop certification), and RUNTIME (mocks, evals, conformance test, and deploy artifacts are present and consistent). The certification binds to a content hash of the bundle, so any tamper invalidates it. Exit 0 only when every gate passes.

### `anvil publish`  *(mutates)*
`anvil publish <dir> --target cloud-run [--env ENV] [--allow-uncertified]`

Gated publish: verify the certification, then emit the deployment plan.

Publication requires a PASSING certification whose bundle hash matches the current bundle content — a stale certificate fails. On success it prints the Cloud Run deployment plan (same as `anvil deploy cloud-run`) and writes publication.json into the bundle. `--allow-uncertified` waives the gate for non-prod environments only; publishing to prod (via --env prod or ANVIL_ENV=prod) fails closed without a valid certification, flag or no flag. No cloud credentials are held and no API calls are made.
