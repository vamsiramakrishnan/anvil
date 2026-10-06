# Serving Branchyard harnesses

[Branchyard](https://github.com/vamsiramakrishnan/branchyard) runs coding
harnesses on branches and gives each one a skill and an SDK per granted
connector instead of upstream credentials. Anvil is the other half: its fleet
gateway (`anvil serve mcp <workspace> --fleet --http <port>`) holds every
upstream authorization, checks each call against the branch's grant, and
records it. The packaged CLI and SDKs a harness uses call that gateway and
nothing else.

The contract between the two repositories is Branchyard's
`docs/connectors.md`. [ADR-0029](adr/0029-branchyard-connector-gateway.md)
records Anvil's side of it and lists where it differs. Branchyard's effect
ledger (its `docs/effects.md`) adds a second contract: what undoing each
operation means, reported on every call.
[ADR-0030](adr/0030-effect-contract.md) records Anvil's side of that one;
[Effects and undo](#effects-and-undo) below is the reference.

## Prerequisites

- Node.js 22.17 or later, pnpm 10, and a built checkout:
  `pnpm install --frozen-lockfile && pnpm build`.
- Python 3.9 or later for the Python SDK.
- Compiled bundles with approved operations (`anvil compile`, `anvil approve`).

`anvil` below is `node packages/cli/dist/bin-anvil.js` (or `pnpm anvil`).

## Run the fixture

`examples/github-mini/` is a small GitHub-shaped API (issues list, get,
create, and update; issue comments list, create, and delete; releases create,
update, delete, and get by tag; pulls list) with a manifest that approves
every operation, marks `issues.create` as a mutation that needs
confirmation, and declares each write's effect class: creating a comment is
reversible, creating an issue is compensable, and creating a release is
irreversible with a draft form. One script drives the whole flow against a
mock upstream:

```bash
node examples/github-mini/e2e.mjs            # add --keep to keep the work directory
```

It prints one JSON line and exits 0 when every check holds:

```json
{"ok":true,"work":"/tmp/anvil-branchyard-e2e-…","checks":[{"name":"index lists github","ok":true},{"name":"python lists issues through the gateway","ok":true,…},{"name":"issues.create is refused policy_denied","ok":true,…},…]}
```

After the read-only turn it mints a second turn's token granting
`github:write` and exercises the effect contract over MCP and REST (see
[Effects and undo](#effects-and-undo)). The same script runs in Anvil's suite
(`packages/cli/src/branchyard-e2e.test.ts`).

## Drive it step by step

These are the commands `e2e.mjs` runs, in order, for a test harness that wants
to own each process (Branchyard's Rust tests, for example). `$WORK` is a
scratch directory and `$ANVIL` is `node packages/cli/dist/bin-anvil.js`, run
from the Anvil checkout.

1. Start the mock upstream. It prints `{"url":"http://127.0.0.1:<port>"}`,
   accepts only `Authorization: Bearer <token>`, and lists every request it
   served at `GET /__requests`.

   ```bash
   node examples/github-mini/mock-upstream.mjs --port 0 --token e2e-upstream-pat
   ```

2. Compile the spec with its server pointed at the mock. The bundle's
   directory name is its connector id.

   ```bash
   mkdir -p "$WORK/src"
   sed "s#https://api.github.example#$MOCK_URL#" examples/github-mini/openapi.yaml > "$WORK/src/openapi.yaml"
   $ANVIL compile "$WORK/src/openapi.yaml" --manifest examples/github-mini/anvil.yaml --out "$WORK/workspace/github"
   ```

3. Package the connector and write the index for a `github:read` grant.

   ```bash
   $ANVIL package harness "$WORK/workspace/github" --out "$WORK/home/connectors/github"
   echo '[{"connector":"github","operations":["*"],"mode":"read"}]' > "$WORK/grants.json"
   $ANVIL connectors index --grants "$WORK/grants.json" --out "$WORK/home/connectors/INDEX.md" "$WORK/workspace/github"
   ```

4. Make the yard's signing key and JWKS (Branchyard's broker does this for a
   real yard), and the vault key.

   ```bash
   node examples/github-mini/yard-keys.mjs keygen "$WORK/yard"   # writes signing.jwk.json (0600) and jwks.json
   node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))' > "$WORK/vault.key"
   chmod 600 "$WORK/vault.key"
   ```

5. Serve the workspace in branchyard mode. The audience is the gateway's own
   `/mcp` URL, so pick the port first.

   ```bash
   ANVIL_INBOUND_AUTH_MODE=branchyard \
   ANVIL_INBOUND_ISSUER=branchyard:local:e2e \
   ANVIL_INBOUND_AUDIENCE=http://127.0.0.1:$PORT/mcp \
   ANVIL_INBOUND_JWKS_URI=file://$WORK/yard/jwks.json \
   ANVIL_VAULT_KEY_FILE=$WORK/vault.key \
   ANVIL_VAULT_DIR=$WORK/vault \
   ANVIL_AUDIT_FILE=$WORK/audit.jsonl \
   ANVIL_ALLOWED_HOSTS=127.0.0.1 \
   $ANVIL serve mcp "$WORK/workspace" --fleet --http $PORT
   ```

   It is ready when `GET http://127.0.0.1:$PORT/healthz` answers 200.

6. Mint a turn's token (Branchyard's job; the fixture's stand-in is below) and
   write it to a 0600 file.

   ```bash
   node examples/github-mini/yard-keys.mjs mint "$WORK/yard" \
     --iss branchyard:local:e2e --aud http://127.0.0.1:$PORT/mcp --sub local:e2e-person \
     --tenant e2e --branch main --turn 1 \
     --grants '[{"connector":"github","operations":["*"],"mode":"read"}]' > "$WORK/turn.token"
   chmod 600 "$WORK/turn.token"
   ```

7. Connect the person's account. GitHub-mini authenticates with a bearer the
   person already holds, so it is a key connection read from stdin. The
   connect routes take only the person's connect token (`by connect` mints
   it), never the turn's token a harness holds.

   ```bash
   node examples/github-mini/yard-keys.mjs mint "$WORK/yard" \
     --iss branchyard:local:e2e --aud http://127.0.0.1:$PORT/mcp --sub local:e2e-person \
     --tenant e2e --purpose connect --grants '[]' > "$WORK/connect.token"
   chmod 600 "$WORK/connect.token"
   printf '%s\n' e2e-upstream-pat | $ANVIL connect "$WORK/workspace" github \
     --gateway http://127.0.0.1:$PORT/mcp --token-file "$WORK/connect.token" --api-key-stdin
   ```

8. Act as the harness: the packaged Python SDK and CLI with only the two
   variables Branchyard sets.

   ```bash
   export ANVIL_GATEWAY_URL=http://127.0.0.1:$PORT/mcp ANVIL_GATEWAY_TOKEN_FILE=$WORK/turn.token
   PYTHONPATH="$WORK/home/connectors/github/python" python3 -c '
   from anvil_github import GithubClient, AnvilError
   c = GithubClient()
   print(c.list_issue(owner="octo", repo="hello"))
   try:
       c.create_issue(owner="octo", repo="hello", title="x", confirm=True)
   except AnvilError as e:
       print(e.code, e.details["code"])'
   "$WORK/home/connectors/github/bin/github" pulls list --owner octo --repo hello
   ```

   The first call prints the two mock issues. The second prints
   `policy_denied policy/grant_denied`, and the mock's `/__requests` shows no
   `POST`.

9. Read the audit log. Each call is one line (shortened here; every line also
   carries `effect_class`, `ledger_id`, and `staged_for`):

   ```json
   {"time":"…","sub":"local:e2e-person","by_tenant":"e2e","by_branch":"main","by_turn":"1","connector":"github","account":"default","operation":"github.issues.list","decision":"allowed","grant":{"index":0,"connector":"github","operations":["*"],"mode":"read"},"upstream_status":200,"latency_ms":17,"input_sha256":"sha256:…","error_code":null,"rule":null,"dry_run":false,"trace_id":"trace_…"}
   {"time":"…","sub":"local:e2e-person",…,"operation":"github.issues.create","decision":"denied","grant":{"index":0,…,"mode":"read"},"upstream_status":null,…,"error_code":"policy_denied","rule":"policy/grant_denied",…}
   ```

## Reference

### Gateway environment

| Variable | Meaning |
| --- | --- |
| `ANVIL_INBOUND_AUTH_MODE=branchyard` | Verify per-turn EdDSA tokens and enforce their grant. Only `anvil serve mcp --fleet --http` accepts this mode; the generated servers refuse to boot with it. |
| `ANVIL_INBOUND_ISSUER` | The yard's issuer: its server URL, or `branchyard:local:<yard id>`. |
| `ANVIL_INBOUND_AUDIENCE` | The gateway's canonical `/mcp` URL: HTTPS, or HTTP on a loopback host. |
| `ANVIL_INBOUND_JWKS_URI` | The yard's JWKS: `https://…/.well-known/jwks.json`, or `file://…/.branchyard/gateway/jwks.json` (read on every verification). |
| `ANVIL_VAULT_KEY_FILE` | Required. A file only its owner can read holding a 32-byte key (raw, 64 hex characters, or base64). |
| `ANVIL_VAULT_DIR` | Where encrypted connections live. Default `~/.anvil/gateway/vault`. |
| `ANVIL_AUDIT_FILE` | Append one JSON line per call here (created 0600). Unset: no audit log. |
| `ANVIL_GATEWAY_PUBLIC_URL` | The base for `/connect/callback` when it differs from the audience's origin. |
| `ANVIL_CONNECT_<CONNECTOR>_CLIENT_ID`, `_CLIENT_SECRET` | The gateway's OAuth client for one connector. `_AUTHORIZATION_ENDPOINT`, `_TOKEN_ENDPOINT`, `_ISSUER`, `_SCOPES` override what AIR declares. |
| `ANVIL_ALLOWED_HOSTS` | The upstream egress allowlist, as for every serving surface. |

### Token

A compact JWT, `alg: EdDSA`, with `kid` in the header. The gateway checks the
signature, `iss`, `aud`, `exp` (and refuses one more than an hour away), `nbf`,
`iat` (not in the future), and requires `sub` and a well-formed `by_grants`.
`by_tenant`, `by_branch`, and `by_turn` are optional strings, recorded in the
audit log. Any failure is a `401` with `WWW-Authenticate`. A session belongs to
one token: a different token presenting its session id gets `403`.

There are two kinds of token, told apart by `by_purpose`:

- A **turn token** has no `by_purpose`. Branchyard mints one per turn and the
  harness holds it. It is the only token `/mcp` takes, and the connect routes
  refuse it with `403 connect_token_required`, before the vault is read or
  written, so a harness (or a prompt injected into one) can never start a
  connection or overwrite the person's stored credential.
- A **connect token** has `by_purpose: "connect"`, an empty `by_grants`, and
  empty `by_branch` and `by_turn`. `by connect` mints one for the person alone
  and hands it to `anvil connect`, never to a harness. It lives at most ten
  minutes (`exp - iat`; a longer one is a `401`). It is the only token the
  connect routes take, and `/mcp` refuses it with `403 turn_token_required`,
  so it can neither list nor call tools.

Any other `by_purpose` is a `401`.

### Grants

`by_grants` is a list of entries; an operation is allowed when some entry
allows it, and the first such entry picks the account.

```json
{"connector": "github", "operations": ["issues.*", "pulls.list"], "mode": "read", "account": "work"}
```

- `connector`: the bundle's id in the served workspace (its directory, folded
  to `[A-Za-z0-9_-]`). Every tool is served as `<connector>__<tool>`.
- `operations`: globs over AIR operation ids. `*` matches any run of
  characters, `?` one. A glob may omit the service prefix: `issues.*` and
  `github.issues.*` both match `github.issues.list`.
- `mode`: `read` allows only operations AIR classifies as reads; `write`
  allows reads and mutations.
- `confirm: "allow"`: needed for a mutation AIR marks as needing confirmation.
  The caller still passes its own `confirm`.

`tools/list` shows only what the grant allows. A call outside it never reaches
the upstream:

| Refusal | `details.code` | When |
| --- | --- | --- |
| `policy_denied` | `policy/grant_denied` | No entry for the connector, no glob names the operation, or only `read` entries for a mutation. `details.rule` is the stopping entry with its `index`, or `null`. |
| `confirmation_required` | `policy/grant_confirmation_required` | The entry allows the mutation but lacks `confirm: "allow"`. |
| `auth_required` | `connector/not_connected` | The person has no connection for this connector and account. |
| `auth_required` | `connector/needs_reconnect` | The provider refused a refresh (`invalid_grant`). |

The `auth_required` messages name the connector and account and never carry a
link; the link goes to the person through `/connect/start`.

### Connect routes

All but the callback take the person's connect token (`by_purpose:
"connect"`) as a bearer; a turn token gets `403 connect_token_required` and
nothing is read or stored. The callback takes no bearer: it is bound to the
person by the `state` a connect token's `/connect/start` made.

| Route | Body | Answer |
| --- | --- | --- |
| `POST /connect/start` | `{"connector": "github", "account": "work"}` | `{"kind": "oauth", "url", "expires_at"}` or `{"kind": "static", "submit": "/connect/api-key"}` |
| `GET /connect/callback?state&code[&iss]` | — | Plain text for the browser. `state` is single use and expires after ten minutes. |
| `POST /connect/api-key` | `{"connector", "account", "api_key"}` | `{"connected": true, "connector", "account"}` |
| `GET /connect/status` | — | `{"sub", "connections": [{connector, account, kind, status, …}]}`, no secrets |

`anvil connect <workspace> <connector> [--account <name>] [--gateway <url>]
[--token-file <path>] [--open] [--api-key-stdin]` calls these for a person:
it prints the authorization URL (and opens it with `--open`), or submits a key
read from stdin. OAuth connectors use the authorization-code grant with PKCE
(S256); the redirect URI is `<gateway origin>/connect/callback`.

### Harness environment

| Variable | Meaning |
| --- | --- |
| `ANVIL_GATEWAY_URL` | The gateway's `/mcp` URL. When set, the generated CLI and the Python and TypeScript SDKs send every call there and read no upstream credential variable. |
| `ANVIL_GATEWAY_TOKEN_FILE` | This turn's token. Read on every call, so a replaced file takes effect at once. |
| `ANVIL_GATEWAY_CONNECTOR` | Optional. Overrides the connector id a client was built with. |

Local confirmation and idempotency checks still run before a call leaves the
client. `--dry-run` / `dry_run=True` / `{ dryRun: true }` returns the gateway's
plan. Go and Java clients do not have a gateway mode yet.

### Harness package

`anvil package harness <bundle> --out <dir> [--workspace <dir>] [--connector <id>]` writes:

```text
<dir>/
  SKILL.md        routing, safety, and refusals; under 80 lines
  reference/      operations.md, errors.md (gateway mode), idempotency.md, workflows.md, capabilities.md
  schemas/        one input schema per operation
  examples/       one example input per operation
  python/         the Python SDK (standard library only; Python 3.9+)
  typescript/     the TypeScript SDK source (build with tsc, or a runtime that strips types)
  bin/<connector> the CLI: one dependency-free script, Node.js 18+
  harness.json    connector, service, bundle hash, entry points, operations
```

The connector id is the one the gateway serves the bundle under: its path in
`--workspace` (the directory given to `anvil serve mcp --fleet`), folded as the
fleet folds it, so `<workspace>/team/github` is `team_github`. Without
`--workspace` the bundle is taken as served alone and named by its directory.
`--connector` overrides both. Only operations the gateway serves are packaged:
approved, and never a `webhook_receiver` (the same rule as the MCP server and
the SDKs).

Branchyard can cache a package by `harness.json`'s `bundleHash`. `anvil
connectors index --grants <file> --out INDEX.md [--workspace <dir>]
<bundle...>` writes one entry per bundle a grant names, matching grants by the
same connector id: what it is for, when to use it, what is granted, and where
its `SKILL.md` is.

## Spanning connectors: the composite

When a branch is granted more than one connector, Branchyard also runs:

```bash
$ANVIL connectors compose --workspace "$WORK/workspace" --out "$WORK/home/connectors/_compose" \
  "$WORK/workspace/github" "$WORK/workspace/jira"
```

It writes a composite beside the connector packages
([ADR-0031](adr/0031-composite-sdk-and-flows.md)): one client for every
composed connector, and **flows**, which are DAGs of their calls. Run it
before `connectors index`. The index then adds a "Spanning connectors" entry
that points at `_compose/SKILL.md`.

```python
from anvil_compose import Composite, item      # PYTHONPATH=<home>/connectors/_compose/python

c = Composite()                                # gateway mode, from ANVIL_GATEWAY_*
flow = c.flow("triage")
issues = flow.step("issues", "github.issues.list", owner="octo", repo="hello")
flow.map("comment", "github.comments.create", over=issues,
         args={"owner": "octo", "repo": "hello", "issue_number": item("number"), "body": "triaged"})
print(flow.plan())        # nodes, edges, waves; nothing sent
print(flow.validate())    # an error here stops run() before any call
run = flow.run()          # dependency order; stops at the first failure
if not run.ok:
    print(run.compensation)                    # each completed write's undo, newest first
    flow.compensate(run, confirm=True)         # only when the task wants it undone
```

Each step is an ordinary call to that connector's SDK, under this branch's
grant, so a refused step fails the run exactly as a direct call would. The
same flow as JSON (`anvil.compose-flow/v1`) runs with
`python -m anvil_compose run FLOW.json [--dry-run]`. `typescript/src/` exports
the same API. Step 10 of `examples/github-mini/e2e.mjs` runs a flow through the
gateway, fails it on purpose, and compensates.

| Meta method | What it does | Sends? |
| --- | --- | --- |
| `step` / `map` / `when=` | Build the DAG; `ref(step, path)` and `item(path)` read earlier results. | no |
| `plan()` / `validate()` / `mermaid()` / `to_json()` | Read the DAG. | no |
| `dry_run()` | Every step through its SDK's gates with `dry_run`. | no |
| `run()` | Call the steps. | yes |
| `compensate(run, confirm=)` | Run the undo calls a failed run lists. | yes |

## Effects and undo

Every operation call through the gateway reports what it did to the world and
how to undo it. Anvil never undoes anything itself: an undo is an ordinary
call the caller makes, under the same grant.

### Effect classes

Each operation has one class, declared in its manifest entry and checked by
the compiler:

| Class | Meaning | Undo |
| --- | --- | --- |
| `read` | Changes nothing. | None needed. |
| `reversible` | A true inverse leaves the world as it was. | `inverse` |
| `compensable` | A cancelling call exists, but leaves a trace. | `compensate` |
| `irreversible` | No undo exists. | None. |

An operation that declares nothing is `read` if it is a read and
`irreversible` otherwise, with no undo.

### Declaring it

```yaml
operations:
  createIssueComment:
    idempotency: { strategy: key_supported, key_location: header, header: Idempotency-Key }
    effect:
      class: reversible
      inverse:
        operation: deleteIssueComment          # operationId, canonical name, or AIR id
        arguments: { owner: request.owner, repo: request.repo, comment_id: response.id }
        deadline: { within_ms: 86400000 }      # optional; or at: response.<path>
  createIssue:
    effect:
      class: compensable
      compensate:
        operation: updateIssue
        arguments: { owner: request.owner, repo: request.repo, issue_number: response.number, state: { const: closed } }
  createRelease:
    effect:
      class: irreversible
      lookup: { operation: getReleaseByTag, by: id, arguments: { owner: request.owner, repo: request.repo, tag: request.tag_name } }
      draft:
        operation: createRelease               # may be the operation itself with a draft flag
        arguments: { owner: request.owner, repo: request.repo, tag_name: request.tag_name, name: request.name?, draft: { const: true } }
        handle: response.id
        promote: { operation: updateRelease, arguments: { owner: request.owner, repo: request.repo, release_id: response.id, draft: { const: false } } }
        discard: { operation: deleteRelease, arguments: { owner: request.owner, repo: request.repo, release_id: response.id } }
```

A mapping names each argument of the follow-up call and where its value comes
from:

- `request.<path>`: the original call's arguments, by the names the tool takes.
- `response.<path>`: the upstream's answer.
- `idempotency_key`: the key the call carried upstream (lookups only).
- `{ const: <value> }`: a literal.

A path is dotted names and `[n]` indices (`response.items[0].id`). A trailing
`?` leaves the argument out when the path names nothing; otherwise a path that
names nothing makes the follow-up unavailable for that call. `anvil compile`
refuses (`effect/*` errors) a reference to a missing operation, a mapping that
misses a required argument, names an argument the target does not take, or
sets its `confirm` or idempotency key, a value whose type the target input
cannot take, a path the schema does not declare, a
reversible class with no inverse, a compensable class with no compensation,
and a lookup by key on an operation that sends no key. An operation whose
declaration has an error is served as `irreversible` with no undo until it is
fixed, and requires confirmation. An operation whose draft form requires
confirmation requires it too, so a staged call can pass `confirm: true` on to
the draft.

### What a call returns

Over MCP, the `tools/call` result's `_meta.effect`; over REST, the
`X-Anvil-Effect` header (JSON, non-ASCII escaped):

| Field | Meaning |
| --- | --- |
| `class` | The operation's class. |
| `operation` | The AIR operation id. |
| `idempotency_key` | The key that went upstream, or `null` when none did. |
| `undo` | `{kind: "inverse" \| "compensate", operation, tool, arguments}`, or `null`. `tool` is the name to call on this gateway. |
| `deadline_ms` | Epoch milliseconds after which `undo` may stop working, or `null`. |
| `compensate` | On a reversible effect that also declares a compensation: the same shape, for after the deadline. |
| `lookup` | `{by, operation, tool, arguments}` for reconciliation, or `null`. |
| `undo_unavailable` | Why `undo` is `null` although the class has one (a mapped value was missing, or the follow-up is not served). |
| `staged` | On a staged call: `{draft_operation, handle, promote, discard}`. |

A failed call still reports its class, key, and lookup; a dry run reports
nothing. `tools/list` publishes the declaration (`_meta["anvil/effect_class"]`
and `_meta["anvil/effect_contract"]`) for operations that declare one, so a
reconciler can resolve a lookup from the request and key alone.

### Idempotency keys

Send the ledger id as `_meta.idempotency_key` (MCP) or `Idempotency-Key`
(REST). When the operation declares an idempotency carrier the gateway sends
the key upstream through it; otherwise it is not sent, and the report's
`idempotency_key` is `null`. Either way the audit line records it as
`ledger_id`. A different key in the call's own arguments is a
`validation_error` (`effect/idempotency_key_conflict`).

### Undo, staging, and promotion

- **Undo**: call `undo.tool` with `undo.arguments`, adding `confirm: true`
  where the follow-up needs confirmation, under the same token. The grant
  must allow it, as for any call.
- **Stage**: `_meta.stage: true` (MCP) or `"stage": true` in the REST body on
  an operation with a draft form performs the draft instead. The answer is
  the draft, and `_meta.effect.staged` holds its `handle` and the `promote` and
  `discard` calls. The mapped draft input is checked against the draft tool's
  schema first (`validation_error`, `effect/draft_input_invalid`). An operation without a draft form is refused
  (`unsupported_operation`, `effect/no_draft_form`) and nothing is called.
- **Promote**: call `staged.promote.tool` with its arguments. That call is
  the real effect, with its own report.

### REST route

`POST /call/<tool>` on the gateway's listener, with the turn's token as the
bearer, takes `{"arguments": {...}, "stage": true?}` (at most 64 KiB) and an
optional `Idempotency-Key` header. It runs the same grant, gates, executor,
and audit as `/mcp`. It answers `200` with the response data, or an
`{"error": {...}}` envelope with a status for its code: `400`
`validation_error`, `401` `auth_required`, `403` `policy_denied` or
`permission_denied`, `404` `not_found` (also an unknown tool), `409`
`conflict`, `422` `unsupported_operation`, `428` `confirmation_required` or
`idempotency_required`, `429` `rate_limited`, `502` or `504` from the
upstream.

```bash
curl -s -D - -X POST "http://127.0.0.1:$PORT/call/github__github_create_comment" \
  -H "authorization: Bearer $(cat "$WORK/turn.token")" -H 'content-type: application/json' \
  -H 'idempotency-key: 01JBRANCHYARDLEDGER00000001' \
  -d '{"arguments": {"owner": "octo", "repo": "hello", "issue_number": 2, "body": "Looks good."}}'
```

```text
HTTP/1.1 200 OK
x-anvil-effect: {"class":"reversible","operation":"github.comments.create","idempotency_key":"01JBRANCHYARDLEDGER00000001","undo":{"kind":"inverse","operation":"github.comments.delete","tool":"github__github_delete_comment","arguments":{"owner":"octo","repo":"hello","comment_id":100}},"deadline_ms":null,"lookup":null}

{"id":100,"body":"Looks good."}
```
