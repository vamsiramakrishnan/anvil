# Observing a running application

Every other Anvil gate is hermetic. `anvil selftest` drives the bundle against
its own generated mock; `anvil conformance` drives both the MCP server and the
CLI against that mock; `anvil simulate` drives an in-process simulator. All
three prove the same thing: **the bundle is faithful to AIR**.

None of them can prove AIR is faithful to the running system, because none of
them ever meets it. A Spring Boot service whose springdoc document drifted from
its controllers, or a WCF endpoint whose WSDL still declares an operation
retired two releases ago, passes every one of those gates and then fails in
production.

`anvil observe` is the lane that meets the application.

## What it does

Two passes, both propose-only.

**Contract drift.** It asks the application for the contract it publishes about
*itself* — springdoc's `/v3/api-docs`, Swashbuckle's `/swagger/v1/swagger.json`,
a WSDL — compiles it, and diffs it against the bundle's AIR through the same
`diffContracts` that powers `anvil drift`. The application is the authority on
its own shape. If it disagrees with what you compiled, that is a fact.

**Implementation drift.** It drives the operator's opt-in reads against the real
application, through the bundle's **own generated MCP server** pointed at it
with `ANVIL_BASE_URL`. Driving through the bundle rather than around it is the
point: that exercises the exact executor path the CLI, the MCP server, and all
four SDKs share, so what the lane observes is what a caller would actually get.
It then compares what came back to what AIR declares comes back.

## Running it

```bash
anvil observe generated/widgets --config observe.json
```

```json
{
  "baseUrl": "http://localhost:8080",
  "contractPath": "/v3/api-docs",
  "contractHeaders": { "Authorization": "Bearer ${WIDGETS_TOKEN}" },
  "probeReads": ["widgets.widgets.get"],
  "inputs": { "widgets.widgets.get": { "widget_id": "w1" } },
  "env": { "WIDGETS_API_KEY": "${WIDGETS_API_KEY}" }
}
```

`${VAR}` resolves from the environment at request time, so a config file — a
thing people commit — never carries a secret. The report records the target as a
host only, because a base URL can carry a query-string credential.

The two credential settings are deliberately separate, and the names say which
is which. `contractHeaders` authenticates the **contract fetch** — a plain HTTP
GET Anvil makes itself. `env` authenticates the **probes**, which do not go
through that path at all: they run through the bundle's own generated MCP
server, which resolves credentials the way every other Anvil surface does, from
the auth profile the operation declares. Set the environment variable that
profile reads. Injecting headers around it would route probe traffic through a
path no real caller uses, which is the opposite of what this lane is for.

Useful flags: `--write <manifest>` saves the proposal instead of printing it,
`--capture <file>` saves the contract the application served, and `--json` emits
the whole report as an operator envelope.

## What it will not do

- **It never drives a mutation.** Not a configurable posture — a mutation named
  in `probeReads` is refused loudly and fails the lane, because an operator who
  listed one believes it is being exercised.
- **Reads are opt-in, one id at a time.** A read can still cost money, page
  someone, or return personal data.
- **It never edits AIR.** The output is an Anvil manifest proposal you review
  and feed to `anvil compile --manifest`, exactly like `anvil enrich`.

## What an observation actually licenses

This is the part worth being careful about. Recorded traffic is the
highest-reliability evidence kind Anvil has (`SOURCE_RELIABILITY` rates it
0.95), which means it is strong enough to *loosen* a safety control through the
reconciler. That is correct in general and dangerous here, because this lane
only ever drives **reads**.

A successful `GET` proves the endpoint exists and what it returned. It proves
nothing about whether some `POST` is idempotent. So the lane raises exactly one
claim — the one a read genuinely earns:

| Observation | Claim | Direction |
| --- | --- | --- |
| The application does not serve an operation the contract declares | `deprecated` | tighten |

Everything else — undeclared response fields, absent declared fields, a contract
that declares no response shape at all — is **reported, not proposed**. It is
evidence for a human or a `anvil case` investigation, not a patch.

The proposal itself then goes through the same asymmetric-trust reconciler
`anvil enrich` uses, so there is one gate, not two that could drift apart.

## The Spring Boot flow, end to end

```bash
# 1. Capture what the app publishes, as local bytes with a recorded digest.
curl -s http://localhost:8080/v3/api-docs > widgets.json
anvil source add widgets.json --name widgets-live

# 2. Compile, inspect, approve — the ordinary loop.
anvil compile --source <snapshot-id> --entrypoint widgets.json --out generated/widgets
anvil inspect generated/widgets
anvil approve generated/widgets widgets.widgets.get

# 3. Prove the bundle is faithful to the model.
anvil certify generated/widgets
anvil selftest generated/widgets
anvil conformance generated/widgets

# 4. Prove the model is faithful to the application.
anvil observe generated/widgets --config observe.json
```

Step 4 is the new one, and it is the only step in that list that can fail
because *the application* changed.

Anvil deliberately does not fetch during source capture — `anvil source add`
ingests local bytes only, which is what makes a snapshot id mean something. So
step 1 stays an explicit act. When `anvil observe` later notices the published
contract has moved, `--capture` hands you the exact bytes it read, with the
digest its findings are bound to, and you re-enter at step 1.

## The same lane for WebLogic, .NET, and messaging

The lane cares about one thing: can the application be reached over HTTP, and
does it publish a contract? That question, not the runtime, decides.

| System | Contract endpoint | Observable |
| --- | --- | --- |
| Spring Boot | springdoc `/v3/api-docs` | Yes — both passes |
| ASP.NET Core | Swashbuckle `/swagger/v1/swagger.json` | Yes — both passes |
| WCF | `?wsdl` | Yes — both passes |
| WebLogic (JAX-WS / JAX-RS) | `?wsdl` or an OpenAPI route | Yes — both passes |
| Queue with an HTTP API | the provider's own OpenAPI | Yes — both passes |
| Native JMS / IBM MQ | none | **No** — there is no HTTP surface to observe, and the legacy bridge is still design-time only (`executionAllowed: false`) |

For the last row, see `legacy-estates.md`. Observation cannot fill a gap that
has no wire to observe.
