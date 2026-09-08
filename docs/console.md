# Console

Use `anvil console` to explore compiled bundles, review operations, preview
requests, and inspect generated artifacts. It reads the same files and calls
the same review and runtime libraries as the CLI.

```bash
anvil console ./generated --open
anvil console ./generated/payments --open
anvil console . --port 4177 --json
```

The console binds `127.0.0.1`. Open the printed URL on the same machine.
`--json` prints the URL, port, and workspace root and keeps the server running.

## Start from the workspace

The workspace discovers directories containing `air.yaml` or `air.json`.
Search by bundle name or source format. Filter for pending decisions or
blocked operations. Sort by name or by pending work. Refresh after a CLI
command changes files.

The pending count includes generated or review-required operations, proposed
capabilities, and undecided review-tier refinements. A pack with no pending
review does not inflate that count. A malformed bundle is listed as a problem;
other bundles remain available.

**Add a source** builds a copyable terminal command for an API contract, gateway
export, or offline legacy export. It does not execute that command. Gateway
and legacy sources start with inventory; their routes and candidates still
need reviewed contracts or bindings. Compile outputs must sit beneath the
workspace root to appear here.

Use the bundle selector to switch services. `Ctrl+K` or `Cmd+K` opens the
bundle and view finder. The interface supports light and dark themes and
narrow screens. Bundle changes discard pending responses from the previous
view, so a delayed response cannot replace the selected bundle's data.

## Explore and preview an operation

Open **Operation catalog**. Search names, resources, CLI commands, or MCP tool
names. Filter by approval state and effect. Results are paginated. Filters and
the selected operation are encoded in the URL; request inputs are not.

Each operation provides four sections:

| Section | What it shows |
| --- | --- |
| Request preview | Named input reference, JSON editor, explicit confirmation and idempotency controls, and the runtime's request plan or refusal |
| Schemas | The shared CLI/MCP input schema and the modeled output schema |
| Policy & evidence | Effect, risk, retries, idempotency, auth requirements, scopes, review notes, claims, and diagnostics |
| Use this tool | CLI inspection command, MCP tool name, intent examples, and a link to generated skill and SDK files |

A preview calls the runtime with `dryRun: true`. It checks approval, required
input presence, confirmation, idempotency, and applicable wire/query gates.
It uses the first server URL declared by the bundle. An unapproved operation
is refused; the UI links to its decision queue.

A successful preview is a request plan. It does not prove full JSON Schema
conformance, credentials, host policy, upstream connectivity, or live behavior.
The console installs no credential resolver, ledger, observer, or working
upstream transport for previews. The preview route accepts no live-execution
flag. Inputs stay in component memory and are discarded when the operation
changes; editing inputs clears the previous result.

The preview binds to the bundle digest displayed when the operation loaded.
If the files change, reload the operation before trying again.

## Review decisions

**Decision queue** brings together operations, proposed capabilities, workflow
problems, refinement deficiencies, review-tier pack items, and tool-confusion
clusters. Select an item to inspect its reasons and evidence before deciding.

Bulk selection uses policies. The barrier excludes blocked operations,
non-idempotent mutations, destructive or irreversible effects, confirmation-
gated operations, oversized capabilities, and pack refinements with a
non-positive measured routing delta. Each excluded row explains why.

Keyboard controls: `j`/`k` move, `x` selects, `a` approves, `r` rejects, `/`
focuses the filter, and `?` opens the key map.

| Action | Shared implementation |
| --- | --- |
| Approve operations | `approveOperationsInBundle`, also used by `anvil approve` |
| Approve or reject a capability | The bundle capability review functions used by the CLI |
| Record a pack decision | `recordPackDecision`; writes the receipt the CLI verifies |
| Apply a reviewed pack | `applyPackToBundle`; writes AIR only |
| Export a cluster task | The refinement task export functions |
| Import a submission | `importRefinementSubmission`; rejects a negative measured routing delta |
| Regenerate projections | `reprojectBundleAtomically`, the same staged replacement used after CLI approval |

Pack receipts bind to the source contract. Decide and apply a pack before
changing operation or capability approval, or generate a new pack afterwards.
A stale pack is refused.

## Inspect evidence and generated files

**Evidence & artifacts** separates three facts:

1. Static checks run in memory against the current bundle.
2. A recorded certification may be missing, failing, stale, or current.
3. Selftest, conformance, and simulation reports each have their own status
   and digest freshness.

Opening this view writes no certification or test report. Run the named CLI
lanes to produce executable evidence. Deployment readiness still needs checks
against the live endpoint.

The artifact browser lists generator-owned paths and known evidence records.
Search by path or language to inspect CLI, MCP, skill, SDK, deployment, and
report files. Contents are rendered as text, with a copy action. Previews are
limited to 256 KiB. Arbitrary workspace files and symlink-backed content are
refused.

After applying a refinement, choose **Regenerate bundle…** and review the
confirmation. The console reads current AIR, checks that the bundle digest
has not changed, stages generated outputs, verifies their bytes and surface
agreement, and replaces the bundle through the shared transaction. It does
not approve additional operations. Reports remain on disk; reports tied to
older bytes must be rerun. Target setup may also need regeneration.

Changed receipt-bound gateway bundles are refused by the same reprojection
gate as CLI approval. Carry those changes through a supplemental manifest
and re-import instead.

## Compare contracts and investigate routing

**Estate inspector** shows operations, capability budgets, workflow planner
verdicts, and the served surface before and after supersession. Operation names
link to the catalog. Compare against another bundle to inspect contract drift.

**Routing analysis** shows measured tool-confusion clusters, routing hubs, and
mis-routed intents. Export a case file for a harness, then import its proposal
through the scored admission gate. Refusals include the routing delta.

The nightly refinement loop emits ordinary bundles and packs. Its output can
be opened directly:

```bash
node tools/corpus/refine-loop.mjs --work ./refine-loop-workspace
anvil console ./refine-loop-workspace --open
```

## Local security boundary

Every POST requires the per-process token and the console's own origin before
its JSON body is read. Bodies are capped at 1 MiB and validated against the
route schema. The server emits no CORS headers. Paths remain confined to the
workspace and reads do not write. Preview and regeneration requests also
check the current bundle digest.

The console does not deploy services, send live upstream requests, issue
credentials, approve workflows, or invent reviewer identity for capability
decisions. Pack receipts carry reviewer identity because their shared contract
records it.

## Verification

`pnpm test` includes contract, socket-level security, request-preview,
regeneration, artifact-access, navigation-race, and UI tests. `pnpm test:e2e`
uses Chromium against the real built CLI and console. It verifies decisions
on disk, previews, artifact inspection, keyboard navigation, and narrow layouts.
