# Anvil documentation

Start with the input you have and the result you need. Compilation, review,
local verification, and deployed execution are separate stages.

## Run one integration

| Starting point | Guide | First result to inspect |
|---|---|---|
| An API contract | [Payments quickstart](../apps/docs/src/content/docs/start/quickstart.md) | Operation names, policy, refusal and dry-run request |
| A gateway export | [Gateway estates](gateways.md) | Captured source and vendor evidence |
| Application or broker configuration | [Legacy inventory](legacy-inventory.md) | Inventory and unresolved capabilities |
| An existing MCP server | [MCP adoption](adopting-mcp-servers.md) | Captured tool declarations and reviewed semantics |
| A running application | [Observation](observing-running-apps.md) | Observations within the declared scope |

Check [source formats](SOURCE_FORMATS.md) before assuming an input can be
executed. Parsing and lowering can succeed while the wire path remains blocked.

## Review and verify

| Decision | Guide | Evidence |
|---|---|---|
| What does this operation mean? | [Manifest](MANIFEST.md) | Reviewed semantic overlay |
| Can the agent investigate a missing fact? | [Refinement SDK](refinement-sdk.md) | Bounded task, evidence and proposal |
| Do related tools need joint review? | [Group refinement](group-refinement.md) | Member and non-member evaluation results |
| Can this legacy capability execute? | [Runtime bridges](legacy-runtime-bridges.md) | Reviewed binding and declared bridge prerequisites |
| Do the generated surfaces agree? | [Simulation and backtesting](simulation-and-backtesting.md) | Results scoped to bundle bytes and test conditions |
| Can this bundle advance? | [CI workflow](CI.md) | Fresh evidence for the same bundle hash |
| Which decision failed? | [Troubleshooting](TROUBLESHOOTING.md) | Refusal code, current state, next action |

## Use the result

- [Client SDKs](client-sdks.md): TypeScript, Python, Go and Java applications.
- [Target profiles](targets.md): platform-specific packaging and its limits.
- [Wire protocols](wire-protocols.md): what executes and what is refused.
- [Review console](console.md): inspect pending decisions in the workspace.
- [Fleet operations](fleet.md): manage repeated work across integrations.
- [Legacy SDK](legacy-sdk.md): programmatic legacy inventory and review.
- [Legacy refinement](legacy-refinement.md): evidence-backed capability proposals.

## Understand or extend the implementation

[Product boundary](PRODUCT_BOUNDARY.md) defines ownership.
[Architecture](ARCHITECTURE.md) maps packages and data flow.
[Mechanisms](mechanisms.md) explains compiler checks and their motivating defects.
[Glossary](GLOSSARY.md) defines the vocabulary.
[Repository instructions](../AGENTS.md) describe development gates.
[Documentation maintenance](WRITING.md) covers sources, claims, and validation.

`docs/adr/` records decisions. `docs/design/` and `docs/plans/` contain proposals.
Audits and backtesting reports record the revision and conditions they examined.
Use them as evidence or design history; check current source and tests before
turning a historical finding into a present-tense capability claim.

## Use a coding agent

Start any terminal-capable agent at [AGENTS.md](../AGENTS.md). The same compile,
inspect, review and verification commands apply across hosts. Installation and
permission-dialog behavior remain host-specific; use the target's cookbook.
