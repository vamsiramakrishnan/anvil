# GitHub REST API backtest

- **Spec**: `examples/github/openapi.json` — 25 operations trimmed verbatim
  from `github/rest-api-description` (790 real paths total; the curated
  subset covers issues, pull requests, reviews, repo contents, and search),
  chosen to overlap the official `github/github-mcp-server`'s toolset.
- **Reference MCP**: `github/github-mcp-server` (official, ~31k★, 60+ tools).
- **Manifest**: `examples/github/anvil.yaml`.

## Compile → inspect → lint → approve → package, run for real

```
$ anvil compile --source <id> --manifest examples/github/anvil.yaml --service github --out generated/github
Compiled 25 operations ... approved: 25  review_required: 0
$ anvil lint generated/github          # exit 0
```

No crashes, no circular-schema cases in this curated subset. This is the
most structurally different spec backtested so far — GitHub's operationIds
are `namespace/kebab-action` (`issues/create-label`, `pulls/create-review`)
rather than Jira's bare camelCase — and every fix from the Jira/Confluence
pass held up unchanged.

## What's different here vs. Atlassian

GitHub is the first product in this backtest where several real mutations
turn out to be **naturally idempotent without a client-supplied key**,
because GitHub itself enforces server-side uniqueness: a duplicate-name
label 422s instead of duplicating, and a second PR for the same head→base
branch pair is flatly rejected. `examples/github/anvil.yaml` declares
`strategy: natural` for exactly those operations, with the specific GitHub
behavior cited as the grounding evidence — demonstrating the manifest
process is per-operation judgment grounded in real API behavior, not a
blanket "vendor X ⇒ policy Y" rule.

Full findings (including a cosmetic naming-collision redundancy) are in
`deficiencies.md`.
