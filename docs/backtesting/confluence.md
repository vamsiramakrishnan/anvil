# Confluence Cloud v2 backtest

- **Spec**: the real confluence spec (fetched by `reproduce.sh confluence`) — 18 operations trimmed
  verbatim from
  `https://dac-static.atlassian.com/cloud/confluence/openapi-v2.v3.json`
  (pages, spaces, comments, labels, attachments, versions), chosen to overlap
  mcp-atlassian's real Confluence toolset.
- **Reference MCP**: sooperset/mcp-atlassian (`confluence_*` tools).
- **Manifest**: `docs/backtesting/reproduce/manifests/confluence.anvil.yaml` — same honest,
  no-idempotency-key-exists stance as Jira for every create.

## Compile → inspect → lint → package, run for real

```
$ anvil compile --source <id> --manifest docs/backtesting/reproduce/manifests/confluence.anvil.yaml --service confluence --out generated/confluence
Compiled 18 operations ... approved: 18  review_required: 0
$ anvil lint generated/confluence      # exit 0 — 4 unproven_idempotency + 4 no_declared_scopes, all expected
```

No new compiler bugs surfaced — the Jira fixes (circular-schema truncation,
POST-search reclassification, CLI/MCP naming agreement) held up unchanged
against a second, independently-shaped real Atlassian spec. That in itself is
a meaningful backtest result: it means the fixes were general, not curve-fit
to Jira's specific spec.

## The one real finding here is about the *API*, not Anvil

mcp-atlassian's `confluence_search` tool takes a CQL query — but Confluence's
**v2** REST API (the one Atlassian currently publishes an OpenAPI spec for)
has **no CQL/free-text search endpoint at all**. CQL search only exists on
the legacy v1 content API, which Atlassian does not publish a current spec
for. Anvil can only compile what the vendor documents; there is no v2
operation to compile into a `confluence_search`-equivalent tool. This is a
real capability gap in Confluence's own API surface versus its actual mature
MCP server, not something the compiler can paper over — logged in
`deficiencies.md` for completeness.
