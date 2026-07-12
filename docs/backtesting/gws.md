# Google Workspace backtest (Gmail) — the format-conversion test

- **Spec**: the real gmail spec (fetched by `reproduce.sh gmail`) — 11 methods trimmed verbatim
  from Google's real **Discovery Document** for Gmail (`gmail.users.messages.*`,
  `drafts.*`, `labels.*`, `getProfile`). The full Gmail Discovery doc (79
  methods) was also compiled directly.
- **Format**: Google API **Discovery Document** (`discovery#restDescription`)
  — the format *every* Google Workspace and Cloud API is published in (Gmail,
  Calendar, Drive, Sheets, BigQuery, …). It is NOT OpenAPI: a nested
  `resources.<r>.methods.<m>` tree, bare `$ref: "TypeName"` schema
  references, and Discovery-specific parameter shapes (`location`, `repeated`).
- **Reference MCP**: `taylorwilsdon/google_workspace_mcp` — `verb_product_
  resource` names (`search_gmail_messages`, `send_gmail_message`) with a
  read-only mode (requests only `*.readonly` scopes).

## The finding: Discovery format was unsupported — so a Discovery adapter was built

Anvil supported OpenAPI 3.x, Swagger 2.0, GraphQL, gRPC/proto, and SOAP/WSDL
— but not Google Discovery. Feeding it the raw Gmail Discovery doc was
handled *gracefully* (a clear `source/no_declared_format` diagnostic, an
`unclassified` snapshot, refused compilation — no crash), but the API simply
could not be compiled.

Anvil already has a protocol-adapter architecture
(`packages/compiler/src/protocols/`) that lowers non-REST formats into a
pre-dereference OpenAPI 3.0 document, so a Discovery adapter fits there
exactly — and unlocks the entire Google API surface at once, not just Gmail.
`packages/compiler/src/protocols/discovery.ts` does the mechanical lowering:

- `resources.<r>.methods.<m>` (walked recursively) → flat `paths` + verbs
- Discovery `parameters` → OpenAPI parameters (`location` → `in`, `repeated`
  → array type)
- `request`/`response` `$ref`s → JSON request body / 200 response
- every `schemas` entry → `components.schemas`, with every **bare**
  `$ref: "Name"` rewritten to `$ref: "#/components/schemas/Name"` so the
  shared dereferencer resolves it identically to any OpenAPI source
- `auth.oauth2.scopes` → an OAuth2 security scheme

Detection is by the `kind: "discovery#restDescription"` discriminator (a cheap
substring pre-check before any JSON parse). See `deficiencies.md` #17.

## Compile

```
$ anvil compile --source <id> --manifest docs/backtesting/reproduce/manifests/gmail.anvil.yaml --service gmail ...
Compiled 11 operations from <id> (discovery) → generated/gmail (72 files).
  approved: 11  review_required: 0
```

The full 79-method Gmail Discovery doc also compiles cleanly (35 reads, 44
mutations split medium/high/destructive), with all 56 schemas resolved and no
dangling bare `$ref`s.

## Naming + safety comparison

| Gmail method | Anvil `cli` / `mcp.toolName` | google_workspace_mcp | Notes |
| --- | --- | --- | --- |
| `messages.send` | `gmail messages send` / `gmail_gmail_users_messages_send` | `send_gmail_message` | Both read as "send a message"; Anvil keeps Google's own method id, the reference server hand-curates a shorter name |
| `messages.list` | `gmail messages list` / …`messages_list` | `search_gmail_messages` | read/none in both |
| `messages.send` risk | **mutation/high** (COMMS) | (write, gated by scope) | Anvil auto-detects "send" as high-risk comms |
| `messages.delete` | **mutation/destructive** | (write) | |

- Anvil's classifier read `send`/`trash`/`delete` correctly from the method
  names — sending mail is high-risk, non-idempotent (a retry sends a second
  copy), and confirmation-required; the reference server's equivalent safety
  is its read-only scope mode. Same posture, reached by Anvil's per-operation
  confirmation gate instead of an all-or-nothing scope switch.
- The one naming wart: Anvil's tool name is verbose
  (`gmail_gmail_users_messages_send`) because Google's method id
  (`gmail.users.messages.send`) is itself deeply namespaced; the reference
  server's `send_gmail_message` is a hand-curated shortening. This is the same
  "trust the vendor's id vs. invent a shorter alias" trade-off seen with
  Jira's `doTransition` — logged, not a bug.
