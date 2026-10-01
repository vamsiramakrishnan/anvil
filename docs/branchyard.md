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
records Anvil's side of it and lists where it differs.

## Prerequisites

- Node.js 22.17 or later, pnpm 10, and a built checkout:
  `pnpm install --frozen-lockfile && pnpm build`.
- Python 3.9 or later for the Python SDK.
- Compiled bundles with approved operations (`anvil compile`, `anvil approve`).

`anvil` below is `node packages/cli/dist/bin-anvil.js` (or `pnpm anvil`).

## Run the fixture

`examples/github-mini/` is a four-operation GitHub-shaped API (issues list,
get, and create; pulls list) with a manifest that approves all four and marks
`issues.create` as a mutation that needs confirmation. One script drives the
whole flow against a mock upstream:

```bash
node examples/github-mini/e2e.mjs            # add --keep to keep the work directory
```

It prints one JSON line and exits 0 when every check holds:

```json
{"ok":true,"work":"/tmp/anvil-branchyard-e2e-…","checks":[{"name":"index lists github","ok":true},{"name":"python lists issues through the gateway","ok":true,…},{"name":"issues.create is refused policy_denied","ok":true,…},…]}
```

The same script runs in Anvil's suite (`packages/cli/src/branchyard-e2e.test.ts`).

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
   person already holds, so it is a key connection read from stdin.

   ```bash
   printf '%s\n' e2e-upstream-pat | $ANVIL connect "$WORK/workspace" github \
     --gateway http://127.0.0.1:$PORT/mcp --token-file "$WORK/turn.token" --api-key-stdin
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

9. Read the audit log. Each call is one line:

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

All but the callback take the person's token as a bearer.

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

`anvil package harness <bundle> --out <dir> [--connector <id>]` writes:

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

Branchyard can cache a package by `harness.json`'s `bundleHash`. `anvil
connectors index --grants <file> --out INDEX.md <bundle...>` writes one entry
per bundle a grant names: what it is for, when to use it, what is granted, and
where its `SKILL.md` is.
