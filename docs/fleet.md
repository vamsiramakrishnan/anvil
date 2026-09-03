# The fleet runtime

`anvil serve mcp <dir>` serves ONE bundle to ONE process. An estate of
dozens of bundles served to several agents needs more: many bundles on one
MCP surface, a name for who is calling, bounded rate/spend per caller, and a
way to notice when a deployed bundle's behavior stops matching what it was
compiled to claim. The fleet runtime is those four pieces, layered onto the
same safety hot path every other Anvil surface already shares — nothing here
is a second execution primitive.

**Single-bundle behavior is unchanged unless you opt in.** Every piece below
defaults to exactly what a bundle already did before the fleet runtime
existed: unmounted (`anvil serve mcp <dir>` without `--fleet`), anonymous
with every scope (no principal directory configured), and unlimited (no rate
or spend config set).

## Multi-bundle serving

```bash
anvil serve mcp <workspace-root> --fleet
```

`<workspace-root>` names a directory, not a single bundle — discovery is the
same `discoverBundles` function [`@anvil/console`](../packages/console)
uses to browse a workspace ([lifted into `@anvil/generators`](../packages/generators/src/bundle-discovery.ts)
so the two can never disagree about what counts as a bundle). A bundle is
any directory carrying a canonical `air.yaml`/`air.json`.

Every discovered bundle's tools are mounted onto ONE MCP server, each under
a stable prefix derived from the bundle's workspace-relative path (its `id`
from discovery) — **once there are two or more bundles**:

```text
billing/          ->  billing__list_invoices, billing__create_refund, ...
shipping/v2/       ->  shipping_v2__list_shipments, ...
```

The prefix comes from the bundle's own directory, folded to an MCP-safe
name — never from `air.service.id` alone, since two bundles can legitimately
share a service id across environments. An approved operation's OWN tool
name (`op.mcp.toolName`, the `anvil/operation_id` in `_meta`) is never
renamed to make room for a fleet — only the wire name a caller dials gets a
prefix in front of it.

**With exactly one bundle discovered, nothing is prefixed.** There is
nothing to disambiguate, so `--fleet` against a workspace root that holds a
single bundle serves that bundle under its own tool names — the wire name,
`_meta`, `annotations`, and every `CallToolResult` are the same values the
bundle would produce served without `--fleet`. This is exactly what "single-
bundle behavior is unchanged unless you opt in" means for the two-writes-not-
one case where `--fleet` IS passed against a one-bundle workspace; it is
proven directly, not just documented, by a test that builds the same bundle
both ways and diffs the two responses
([`fleet.test.ts`](../packages/mcp-runtime/src/fleet.test.ts), "a
single-bundle fleet answers tools/list and tools/call byte-identically to
the same bundle served alone").

**Collisions are refused, never silently resolved.** If two bundles would
mount the same prefixed tool name, `buildFleetServer`
([`packages/mcp-runtime/src/fleet.ts`](../packages/mcp-runtime/src/fleet.ts))
throws `FleetToolCollisionError` naming both bundle ids and the tool name —
the CLI reports it and refuses to start rather than dropping or aliasing
either tool.

Composition happens through the SDK's own public wire contract: each
bundle's `McpServer` is built exactly as `anvil serve mcp` builds it (same
function, same options, same execution semantics — see
[`buildMcpServer`](../packages/mcp-runtime/src/server.ts)), connected to an
internal MCP `Client` over an in-process transport pair
(`InMemoryTransport.createLinkedPair`), and the fleet server re-registers
each discovered tool under its prefixed name, forwarding every call to that
internal client. A bundle served through the fleet answers `tools/call`
byte-identically to the same bundle served alone.

### `/readyz`

The fleet starts a small HTTP listener (`ANVIL_FLEET_READYZ_PORT`, default
`8787`) serving `/readyz`, which lists every mounted bundle's own certified
state:

```json
{
  "ready": false,
  "bundles": [
    { "id": "billing", "serviceId": "billing", "toolCount": 12,
      "certifiedHash": "sha256:...", "certificationStatus": "passed", "ready": true },
    { "id": "shipping", "serviceId": "shipping", "toolCount": 8,
      "ready": false }
  ]
}
```

`certifiedHash`/`certificationStatus` come from each bundle's own
`certification.json` (`anvil certify`), read by the CLI — `@anvil/mcp-runtime`
never touches the filesystem or depends on `@anvil/generators` (that
dependency runs the other way, so the deployed serving path stays thin).
An uncertified bundle still serves; `/readyz` just says so, and the whole
fleet's `ready` folds to `false` until every mounted bundle is certified
`passed`.

## Principals

A `Principal` (`{ id, scopes[] }`,
[`packages/runtime/src/policy.ts`](../packages/runtime/src/policy.ts)) names
WHO is calling — resolved once per MCP session, threaded through
`ExecuteContext.principal`, and checked against an operation's own
`auth.scopes` **before any upstream call**, alongside every other pre-flight
gate (approval, wire, retry bounds, idempotency carrier). A principal
missing a required scope is refused with `policy_denied`
(`details.code: "policy/scope_denied"`) — never retried, and never a byte
reaches the upstream host.

**Default: the anonymous, every-scope principal.** Unless you configure a
principal directory, every call resolves to
`{ id: "anonymous", scopes: ["*"] }`, which satisfies any `auth.scopes`
requirement — this is what keeps single-bundle behavior byte-identical.

Configure named principals with `ANVIL_PRINCIPALS`, either inline
(`token:id:scope1,scope2;token2:id2:scope3`) or as JSON
(`{"tok_abc": {"id": "alice", "scopes": ["orders.read"]}}`):

- **streamable-http**: the caller's bearer token looks itself up in the
  directory.
- **stdio**: `ANVIL_PRINCIPAL=<token>` names one principal for the whole
  session (one caller per process lifetime).

Every `ExecutionRecord` carries the resolved `principalId` — **never the
token** that resolved it. `principalId` defaults to `"anonymous"` when
nothing is configured, so existing record consumers (`anvil observe
--from-records`, the drift alarm below) see one extra, always-present field
rather than a breaking schema change.

## Rate and spend limits

`packages/runtime/src/limits.ts` adds two independent, per-principal gates,
both checked before any upstream call and both refused with a structured,
**never-retried** error:

- **Rate** — a token bucket per `(principal, operation)`. Configure with
  `ANVIL_RATE_LIMIT_CAPACITY` + `ANVIL_RATE_LIMIT_REFILL_PER_SECOND` (both
  required together; a partial pair is treated as unset). Exceeding it
  refuses with `rate_limited` (`details.code: "policy/rate_limited"`).
- **Spend** — a fixed-window budget per principal, denominated in "cost
  units" estimated from `effect.kind`/`effect.risk`
  (`costTierFor` — there is no real per-call price yet, so every figure this
  produces is explicitly named an *estimate*, never a metered cost).
  Configure with `ANVIL_SPEND_BUDGET` + `ANVIL_SPEND_WINDOW_SECONDS`.
  Exceeding it refuses with `policy_denied`
  (`details.code: "policy/budget_exhausted"`).

Both are **absent by default** — an unconfigured bundle has no rate limiter
and no spend tracker, so nothing here changes behavior unless you opt in.

## The drift alarm

`anvil observe --from-records <dir> --alarm` folds a deployed bundle's
spooled execution records (`ANVIL_RECORDS_DIR`/`JsonlRecordSpool` — the same
records `anvil observe --from-records` already turns into `recorded_traffic`
evidence) against the compiled AIR document's own safety claims, looking for
a **contradiction**:

- an operation compiled `idempotency.mode: "natural"` (repeat calls converge
  on the same effect) that returned a `conflict` on replay — live traffic
  says it isn't naturally idempotent after all;
- an operation whose declared error codes never once appear in traffic
  while an undeclared one does (reported, not yet case-opening — see below).

Below `MIN_SAMPLES_FOR_ALARM` (3) recorded calls for an operation, a single
contradicting response is an anecdote, not a pattern, and is never raised.

**When a contradiction is found, the alarm opens a real refinement case
through the EXISTING case rails** (`anvil case ...`,
[`packages/refinement/src/case`](../packages/refinement/src/case)) — not a
new mechanism. An idempotency-replay contradiction routes through the
already-registered `contested_safety_semantic` deficiency and its
`classify-idempotency` skill (evidence bar: `minimumStrength: "authoritative"`,
`minimumVerification: "verified"` — the highest bar in the codebase, and the
one skill whose evidence policy already names `recorded_traffic` as an
admissible source), with the contradicting records attached as evidence
(`addEvidence`, source `recorded_traffic`).

**Proposing only.** The alarm never patches AIR — its only writes are
`openCase`/`addEvidence`, both scoped to the case directory tree — and
`classify-idempotency`'s proposals are never auto-approved
(`packages/refinement/src/approval.ts`'s `classifyApproval`: idempotency has
no safe "tightening" direction the way `retryable=false` has for errors).
Opening a case here is exactly as far as this alarm goes; every ordinary
skill/evidence/approval step still applies to whatever a human or agent does
with it afterward.

The undeclared-error-code contradiction is reported in the same run but does
not (yet) open a case: its closest existing skill, `enrich-errors`
(triggered by `undocumented_error`), does not admit `recorded_traffic` in
its evidence policy today. The alarm reports the gap honestly rather than
forcing evidence through a skill whose contract does not accept it —
extending `enrich-errors`'s evidence policy is a deliberate, separate
change for a reviewer to make.

```bash
anvil observe <bundle> --from-records <spool-dir> --alarm
anvil observe <bundle> --from-records <spool-dir> --alarm --case-root .refinement
```

## What the fleet runtime does not change

- A single bundle served without `--fleet` behaves exactly as before.
- The approval ladder, the idempotency/retry model, and every existing
  safety gate are untouched — principals and limits are NEW gates ahead of
  them, not replacements.
- The drift alarm never writes AIR. It opens cases; it never applies
  patches.
