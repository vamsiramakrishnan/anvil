# ADR-0027 — Gateway-estate adoption uses deterministic gates with proposal-only agents

**Status:** Accepted

## Context

A large gateway export can contain thousands of valid APIs across revisions and
environments. Deterministic adapters can inventory routes, identify missing
contracts and policy gaps, and preserve deployment identity. They cannot infer
business intent or decide that UI/BFF-shaped endpoints form a useful agent
capability.

A coding agent can investigate callers, handlers, persistence, tests, and
authorization evidence. It is useful for semantic discovery, but it is not an
authority for gateway identity, import lineage, operation approval, or release
gates. Applying one behavior to the whole estate either loses useful
investigation or creates an estate-wide auto-approval path.

## Decision

Anvil uses one versioned, coordinate-aware adoption plan as the handoff between
mechanism, reviewers, and optional coding agents.

- `estate inventory`, `estate audit`, and `estate plan` are deterministic.
  `estate plan --init-selection` materializes every
  API/version/revision/environment coordinate as `decision: triage` and
  `semanticLane: deterministic_only`. It never recommends or selects an API and
  refuses to overwrite an existing selection file.
- A WSO2 native `apictl export apis` directory stays a collection of
  independently evidenced per-API projects. The plan covers the complete
  collection, but import resolves one exact API/version/revision/environment
  and never flattens the projects into an invented aggregate. WSO2 semantic API
  version (`api.yaml data.version`) and control-plane revision
  (`working-copy`/`revision-N`) are separate identity axes.
- Gateway diagnostics carry API, artifact, and route ownership when the source
  proves it. Subjectless means truly global. Audit folds a scoped blocker into
  only the matching API disposition/workstream; import applies global findings
  plus findings whose API and artifact constraints match the selection. Thus a
  malformed or duplicate project does not poison an unrelated import, while a
  failure that prevents a safe project boundary still fails closed.
- A reviewer owns selected/deferred decisions, business intent, accountable
  owner, contract location, gateway URL, and any supplemental manifest. Import
  remains API-by-API and uses the exact revision, environment, stable gateway
  identity, and `--strict-identity`.
- Each coordinate independently chooses one semantic lane:
  `deterministic_only`, `agent_assisted`, or `manual_review`. The default is
  deterministic-only; an estate may mix all three without changing the
  authority model.
- `agent_assisted` starts only after receipt-bound import and only for a
  deficiency exposed by `anvil case list`, which means an implemented CASE
  skill exists. The agent gathers evidence and produces a proposal. It cannot
  edit AIR, approve operations, suppress findings, promote a baseline, or bypass
  inspect, lint, receipt-bound re-import, verification, and release policy.
- Accepted semantic evidence is encoded in the supplemental manifest by a
  reviewer and compiled through a new immutable import receipt. Deterministic
  gates and receipt verification remain the only authorities for exposure.
- After receipt verification, single-bundle capability grouping is a separate
  governed loop: an agent may propose a user-job boundary, deterministic checks
  verify operation membership, workflow dependencies, identity groups, and
  disclosure budget, and a human approves the capability before `anvil build`.
- Cross-bundle `anvil capability compose` is a separate audit/review loop. It
  can identify exact duplicate/projection evidence and preserve intersected
  auth/safety constraints, but similarity never assigns authority. Even after
  digest-bound evidence and human review it emits only `reviewed_plan_only`
  records with `generatedMcp:false` and `buildReady:false`; its report is never
  AIR, approval, build, publish, or deploy input.
- Release configuration for a built single-bundle capability then binds the
  target environment, Gemini Enterprise surface and location, connector IdP,
  upstream credentials, and durable write ledger before certification,
  executable proof, and an operator-applied deployment plan. The agent cannot
  approve, deploy, or manufacture live proof.
- The default agent-facing service id and the physical deployment namespace are
  both derived from the full stable
  gateway/API/version/revision/environment coordinate. A reviewer may choose a
  clearer service id in the selection file, but two selected coordinates may
  not share one service id.
- A reviewed plan is the re-export baseline. `estate plan --baseline ... --check`
  emits a separate candidate and fails on source, API-coordinate, finding,
  adapter, gateway-identity, or selection drift. The CLI refuses to overwrite
  the reviewed baseline. `planHash` content-addresses the stable adoption plan;
  `reportHash` separately binds the full change/lineage envelope so report
  metadata cannot be altered while repeat checks retain the same `planHash`.

There is no estate-wide auto-selection, agent fan-out, approval, or exposure
operation. Owner workstreams can schedule coordinates in parallel, but every
coordinate retains its own decision, evidence, receipt, and gate state.

## Consequences

- Large estates get a resumable queue and bounded human summary without losing
  the complete machine-readable audit and plan.
- WSO2 estates get native directory ingestion and per-project failure isolation
  rather than a preprocessing script that merges 1,000 archives.
- Revision and environment collisions remain visible instead of being folded
  into one API id or output directory.
- Teams can spend agent investigation only where it adds semantic value while
  keeping routine APIs on deterministic rails.
- Re-exports are reviewable drift events, not implicit baseline updates.
- Business intent, ownership, real contracts, gateway identity, and opaque
  policy semantics remain honest human/evidence blockers when they cannot be
  proven.

## Rejected alternatives

- **Compile or investigate the entire estate automatically:** expensive,
  semantically noisy, and creates pressure to treat proposals as truth.
- **Let the coding agent approve its own patch:** collapses evidence gathering,
  policy, and authorization into one unreviewable actor.
- **Key adoption by API id only:** revisions and environments would collide and
  could overwrite one another.
- **Treat the latest export as the baseline automatically:** hides removals,
  policy changes, ownership drift, and selection changes.
