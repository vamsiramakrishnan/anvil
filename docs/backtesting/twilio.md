# Twilio backtest (scale + POST-reuse test)

- **Spec**: `examples/twilio/openapi.json` — 15 operations trimmed verbatim
  from `twilio/twilio-oai`'s `twilio_api_v2010.json` (the core Api2010 REST
  API; messages, calls, incoming phone numbers). The **full** spec (121
  paths, 197 operations) was also compiled directly as a scale test.
- **Reference MCP**: `twilio-labs/mcp` (official). Notably, Twilio's own
  answer to its ~1,800-endpoint surface is a compact two-tool
  `twilio__search` / `twilio__retrieve` façade — because one-tool-per-endpoint
  "is unusable unloaded" at that scale (their words), requiring `--services`/
  `--tags` filtering.

## Scale test: the full spec compiles in under 2 seconds

```
$ anvil compile --source <full-spec> --service twilio ...
Compiled 197 operations from <id> (openapi) → generated/twilio-full (236 files).
  real 1.7s
```

197 operations, 148 schemas, no hang, no crash — the bundle/materialize
schema architecture (see `stripe.md` / `deficiencies.md` #10–#12) is what
makes this fast; a naive full-inline compiler would have struggled here too.

## Two real, generalizable naming bugs this surfaced — both FIXED

### `.json` REST format suffix leaked into the resource name
Twilio's list/create paths carry a `.json` suffix (`/Messages.json`) while
fetch/delete carry it on the id segment (`/Messages/{Sid}.json`). The result
was the *same* resource rendering two ways — `twilio Messages.json list` but
`twilio Messages get` — and a wire-format detail leaking into the
agent-facing name. Fixed by stripping a REST format suffix from the derived
resource name (the wire path `sourceRef.path` keeps `.json`). See
`deficiencies.md` #14.

### POST reused for update collided create and update onto one name
Twilio (like several REST APIs) uses `POST` for update, not just create
(`UpdateMessage` and `CreateMessage` are both `POST`, distinguished only by
operationId). `actionFor(POST)="create"` collapsed them onto `twilio Messages
create`, forcing an ugly `_post` disambiguation suffix and mislabeling the
update as a create. Fixed by honoring the operationId's leading verb for the
one case HTTP method can't express — a POST named `Update*`/`Delete*` — while
deliberately NOT trusting a leading verb in general (Stripe's `GetCustomers`
is really a *list*). See `deficiencies.md` #15.

## Naming comparison (after the fixes)

| Operation | Anvil `mcp.toolName` | Twilio SDK / spec | Match? |
| --- | --- | --- | --- |
| Send SMS | `twilio_create_message` | `CreateMessage` / `messages.create` | ✅ same verb+resource |
| List messages | `twilio_list_message` | `ListMessage` | ✅ (Twilio uses `List`, not `Get`, for collections — Anvil keeps it) |
| Fetch one | `twilio_fetch_message` | `FetchMessage` | ✅ |
| Update/redact | `twilio_update_message` | `UpdateMessage` | ✅ (and correctly flagged **destructive** — its own summary says it redacts/cancels) |

## Safety comparison

- `CreateMessage`/`CreateCall`/`CreateIncomingPhoneNumber` are all
  non-idempotent, billable, irreversible comms/financial actions — Anvil
  marks them confirmation-required and never auto-retried. The official
  Twilio MCP documents no dry-run or per-call confirm for these (its safety
  guidance is operational — don't run untrusted MCP servers alongside it), so
  Anvil's per-operation confirmation gate is a genuine differentiator here.
- `UpdateMessage` is a standout validation: Anvil read its OpenAPI summary
  ("used to redact body text and cancel not-yet-sent messages"), matched the
  `cancel` signal, and classified it `destructive`/irreversible — even though
  it's nominally an "update" and a `POST`. The name reflects Twilio's verb
  (`update`), the safety posture reflects the real danger.
