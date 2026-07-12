# Jira Cloud backtest

- **Spec**: the real jira spec (fetched by `reproduce.sh jira`) — 26 operations trimmed verbatim from
  `https://developer.atlassian.com/cloud/jira/platform/swagger.v3.json`
  (issues, comments, transitions, watchers, worklogs, links, projects,
  JQL search), chosen to overlap mcp-atlassian's real Jira toolset.
- **Reference MCP**: sooperset/mcp-atlassian (`jira_*` tools) and the official
  Atlassian remote MCP (`*JiraIssue`/`read_jira`/`write_jira` groups).
- **Manifest**: `docs/backtesting/reproduce/manifests/jira.anvil.yaml` — hand-authored from documented
  Jira semantics (no live tenant credentials in this environment; see
  `deficiencies.md` for the `anvil enrich` attempt against the real
  `mcp-atlassian` server and why it connected to zero sources here).

## Compile → inspect → lint → approve → package, run for real

```
$ anvil source add the jira backtest (reproduce.sh jira)openapi.json
$ anvil compile --source <id> --manifest docs/backtesting/reproduce/manifests/jira.anvil.yaml --service jira --out generated/jira
Compiled 26 operations ... approved: 26  review_required: 0
$ anvil lint generated/jira            # exit 0 — warnings only, all expected
$ anvil package skill generated/jira
Skill package is ready at generated/jira/skill
```

## Naming comparison (Anvil-generated vs. mcp-atlassian's real tool names)

| Operation | Anvil `mcp.toolName` | mcp-atlassian | Match? |
| --- | --- | --- | --- |
| Get issue | `jira_get_issue` | `jira_get_issue` | ✅ identical |
| Create issue | `jira_create_issue` | `jira_create_issue` | ✅ identical |
| Add comment | `jira_add_comment` | `jira_add_comment` | ✅ identical |
| Add watcher | `jira_add_watcher` | `jira_add_watcher` | ✅ identical |
| Remove watcher | `jira_remove_watcher` | `jira_remove_watcher` | ✅ identical |
| Transition issue | `jira_do_transition` | `jira_transition_issue` | ⚠️ different (Atlassian's real operationId is the vaguer "doTransition" — Anvil now flags this via `weak_operation_name`, see deficiencies.md #5) |
| Search fields | `jira_get_fields_paginated` | `jira_search_fields` | ⚠️ different, both reasonable |
| JQL search | `jira_search_and_reconsile_issues_using_jql_post` | `jira_search` | ⚠️ Anvil keeps Atlassian's full (typo'd — "Reconsile") operationId; mcp-atlassian's hand-picked short name reads better. Anvil correctly classifies the *safety* posture (`read`, no confirmation) identically either way — see deficiencies.md #2. |

Net: on operations with a clean, human-authored Jira operationId, Anvil's
generated tool names are frequently **identical** to a hand-built reference
server's. Where they diverge, it's because Anvil trusts the vendor's literal
operationId rather than inventing a shorter alias — a defensible default (it
never guesses business meaning) but the gap between "the vendor's
operationId is well-written" and "the vendor's operationId is what an agent
should see" is real and is exactly what `weak_operation_name` is for.

## Safety comparison

- Every write mcp-atlassian gates behind `@check_write_access` (an env-level
  read-only switch) is also a `mutation` in Anvil with `state: approved` only
  after an explicit manifest decision — nothing is exposed by default.
- Neither Anvil nor mcp-atlassian claims idempotency/dry-run for
  `createIssue`, `addComment`, or `addWorklog` — both are honest about the
  real API having no dedupe mechanism there.
- Anvil's `doTransition`/`addWatcher` natural-idempotency calls (this
  session's manifest) match mcp-atlassian's implicit behavior (no
  confirmation friction on either), grounded in Jira's documented workflow
  semantics.

See `deficiencies.md` for the full bug list found and fixed while producing
this bundle (compiler crash on a circular schema, POST-search
misclassification, CLI/MCP naming drift, and the naming-confidence threshold).
