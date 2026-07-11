# Slack backtest (archived Swagger 2.0 + RPC-over-HTTP naming test)

- **Spec**: `examples/slack/swagger.json` — 14 operations trimmed verbatim
  from `slackapi/slack-api-specs`'s `slack_web_openapi_v2.json` (chat,
  conversations, users, reactions). The **full** spec (174 paths) was also
  compiled directly.
- **Format note**: this spec is **Swagger 2.0** and the repo is **archived /
  read-only since March 2024** — a test of both the `swagger2openapi`
  conversion path and handling a stale, not-actively-maintained real spec.
- **Reference MCP**: `korotovsky/slack-mcp-server` (community). It maps
  Slack's flat Web API method names to tools by a near-mechanical `.`→`_`
  transform (`conversations.history` → `conversations_history`) and gates
  every write behind an explicit env-var opt-in (read-only by default).

## Compile

```
$ anvil compile --source <id> --manifest examples/slack/anvil.yaml --service slack ...
Compiled 14 operations ... approved: 14  review_required: 0
```

Swagger 2.0 converted cleanly via the existing `swagger2openapi` path; the
archived/stale status made no difference (the spec is still valid Swagger,
just unmaintained). No conversion bugs.

## The real bug: RPC-over-HTTP paths broke the CLI command — FIXED

Slack's Web API is RPC-over-HTTP: `/chat.postMessage` is a *single* path
segment `namespace.method`, not a REST resource path. Anvil took the whole
`chat.postMessage` as the resource, producing `slack chat.postMessage send`
— a CLI command with a literal dot in it, a redundant appended verb, and
drift from the clean MCP tool name `slack_chat_post_message`. And collapsing
the namespace naively then *collided* `conversations.archive` with
`admin.conversations.archive` (Slack ships both).

Fixed by decomposing an RPC dotted segment into resource + action, preserving
the full namespace (`admin_conversations` vs `conversations` — distinct, no
collision), and cleaning the collision-disambiguation tokens the same way.
See `deficiencies.md` #14, #16.

## Naming comparison (after the fix)

| Slack method | Anvil `mcp.toolName` | korotovsky's tool | Match? |
| --- | --- | --- | --- |
| `conversations.history` | `slack_conversations_history` | `conversations_history` | ✅ identical (modulo service prefix) |
| `reactions.add` | `slack_reactions_add` | `reactions_add` | ✅ identical |
| `users.list` | `slack_users_list` | `users_list` (as `channels_list`-style) | ✅ |
| `chat.postMessage` | `slack_chat_post_message` | `conversations_add_message` (renamed) | ⚠️ Anvil keeps Slack's own method name; korotovsky renamed it |
| `admin.conversations.archive` | `slack_admin_conversations_archive` | (admin tools not exposed) | — distinct from the non-admin one |

The `.`→`_` mapping korotovsky does by hand is exactly what Anvil now derives
from the operationId automatically — the CLI command (`slack conversations
history`) and the MCP tool (`slack_conversations_history`) agree, which is
the whole point.

## Safety comparison

Every Slack write (`chat.postMessage`, `reactions.add`, `conversations.*`)
is a mutation in Anvil; `chat.postMessage` is high-risk (comms, non-idempotent
— a retry double-posts) and confirmation-required. korotovsky's server
reaches the same posture differently: writes disabled by default, opt-in per
env var, with channel-level allowlisting. Anvil's per-operation confirmation
+ approval gate is the aligned-by-construction equivalent. `reactions.add` is
declared naturally idempotent (re-adding the same reaction is a Slack no-op).
