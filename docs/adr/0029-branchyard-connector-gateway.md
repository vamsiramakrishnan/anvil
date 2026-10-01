# ADR-0029 — The fleet gateway serves Branchyard harnesses

**Status:** Accepted

## Context

[Branchyard](https://github.com/vamsiramakrishnan/branchyard) runs coding
harnesses on branches. A harness on a branch often needs GitHub, Slack, Linear,
or an internal API. Handing each harness MCP server configurations and upstream
credentials would put tokens in every harness home and leave nothing that can
say which branch did what. Branchyard instead gives a harness a skill and an
SDK per granted connector and one gateway to call them through. The contract
both repositories build to is Branchyard's `docs/connectors.md`; this ADR
records Anvil's side of it.

The split of ownership in that contract is:

- **Anvil's compiler** owns what an operation means (effect, idempotency,
  confirmation, auth type, approval). That is AIR, unchanged.
- **Anvil's gateway** owns acting on upstreams: the credential vault, connect
  flows, grant enforcement, confirmations, rate and spend limits, and audit.
- **Branchyard's access broker** owns who may do what: a signed, short-lived
  token per turn that names the person, the branch, and the grant.

Most of the gateway already existed. `anvil serve mcp <workspace> --fleet
--http <port>` mounts many bundles on one Streamable HTTP endpoint behind
inbound auth (`docs/fleet.md`), every call goes through one `execute()` with
its pre-flight gates (ADR-0022), and the generated CLI can route a call through
a remote MCP server (ADR-0023). What was missing: a token format that carries a
grant, a gate that enforces it per operation, per-person upstream credentials,
a way for the person to connect an account, a per-call audit line, and the
files a harness home holds.

## Decision

**1. A `branchyard` inbound mode.** `ANVIL_INBOUND_AUTH_MODE=branchyard` in
`@anvil/mcp-runtime`'s `inbound-auth.ts` verifies an Ed25519 (`alg: EdDSA`)
compact JWT against a JWKS named by `ANVIL_INBOUND_JWKS_URI`, which may be an
`https:` URL or a `file:` URL (a local yard's `.branchyard/gateway/jwks.json`,
read afresh on every verification so a rotated key is seen at once). It checks
`iss`, `aud`, `exp`, and `nbf`; refuses a token whose `exp` is more than an
hour away, a token without `sub`, and a malformed `by_grants`; and accepts only
EdDSA, while the IdP modes keep RS256/ES256. Verification uses `node:crypto`
and fails closed. `loadInboundAuthConfig` accepts the mode only from a caller
that enforces grants (`allowBranchyard`), so the deployed single-bundle
servers refuse to boot with it rather than verify the token and ignore its
grant.

**2. The principal comes from the claims.** `branchyardPrincipal` builds
`{ id: sub, scopes: ["*"], grants: by_grants, attribution: { tenant, branch,
turn } }`. The grant, not a scope list, limits the caller. A session is bound
to one token (`branchyardSessionFingerprint` covers issuer, subject, `jti`,
turn, expiry, and grant), so a new turn's token opens a new session instead of
inheriting the previous turn's grant. The token is never threaded on as an
inbound identity, so it can never become an RFC 8693 subject token or reach an
upstream.

**3. Grants are enforced in `execute()`.** `Principal.grants` (in
`@anvil/runtime`'s `grants.ts`) is checked after the scope gate and before
rate limits, validation, credential resolution, and any upstream byte. The
connector is the bundle's fleet prefix (`ExecuteContext.connector`). An entry
allows an operation when its `connector` matches, one of its `operations`
globs matches the AIR operation id (with or without the `<service>.` prefix),
and its `mode` covers the effect (`read` only for AIR reads). A mutation that
AIR marks as needing confirmation also needs `confirm: "allow"` on the entry.
A refusal is `policy_denied` with `details.code: "policy/grant_denied"`, or
`confirmation_required` with `"policy/grant_confirmation_required"`, and
`details.rule` names the entry that stopped it. The first entry that allows a
call selects its `account`. A principal without a grant is unaffected.

**4. Every tool carries its connector prefix, and the list is narrowed.** For a
granted principal, `buildFleetServer` prefixes tools even when it mounts one
bundle (`alwaysPrefix`), so the wire name `<connector>__<tool>` does not depend
on what else the gateway serves. `tools/list` shows only the tools the grant
allows (`listFilter`). A hidden tool stays registered, so calling it reaches
`execute()` and gets the structured refusal, not "tool not found".

**5. Credentials come from a vault, per person.** `ConnectionVault`
(`vault.ts`) stores one record per `(sub, connector, account)`, encrypted with
AES-256-GCM under a 32-byte key read from the file `ANVIL_VAULT_KEY_FILE`
names. The coordinates are bound in as additional authenticated data, so a
record copied onto someone else's coordinates does not decrypt. A gateway in
branchyard mode refuses to start without the key. For a granted principal the
fleet replaces the environment's credential resolver with
`VaultCredentialResolver`; no `ANVIL_<PROFILE>_*` variable is read. An
unconnected account is `auth_required` with `details.code:
"connector/not_connected"` naming the connector and account, with no link in
the message. An OAuth token close to expiry is refreshed under a per-connection
lock; `invalid_grant` marks the connection `needs_reconnect`.

**6. The gateway owns the connect flow.** `ConnectFlow` (`connect.ts`) runs the
OAuth authorization-code grant with PKCE (S256). `POST /connect/start` returns
the authorization URL to the person who asked; `state` is single-use,
short-lived, and bound server-side to that person, connector, and account;
`GET /connect/callback` checks an `iss` parameter when the provider sends one
(RFC 9207). A key-based connector takes its key on `POST /connect/api-key`.
Every connect route but the callback takes only a **connect token**: one
with `by_purpose: "connect"`, which Branchyard mints for the person alone
(`by connect`), with an empty grant and a lifetime of at most ten minutes. A
turn token, which a harness holds, has no `by_purpose` and is refused `403`
before the vault is touched, so a prompt-injected harness cannot start a
connection or overwrite the person's credential. The reverse holds too: `/mcp`
refuses a connect token (`branchyardPrincipal` names no caller for it), so it
can never list or call tools. An unknown `by_purpose` is invalid. A reconnect
whose token response does not rotate the refresh token keeps the stored one,
as a refresh does.
The OAuth client is gateway configuration (`ANVIL_CONNECT_<CONNECTOR>_*`),
never AIR. `anvil connect <workspace> <connector> [--account]` asks the gateway
for the URL and prints or opens it.

**7. One audit line per call.** With `ANVIL_AUDIT_FILE` set, `execute()` appends
a JSON line for every call: time, `sub`, `by_tenant`, `by_branch`, `by_turn`,
connector, account, operation, decision (`allowed`, `denied`,
`confirmation_required`), the grant entry, upstream status, latency, and a
SHA-256 of the input after credential-looking keys are redacted.

**8. Gateway mode in the generated clients.** With `ANVIL_GATEWAY_URL` set, the
generated CLI (`runToolCli`) sends every call through its ADR-0023 `--mcp <url>`
path, and the Python and TypeScript SDKs through an equivalent Streamable HTTP
transport (`_gateway.py`, `gateway.ts`). Each reads the bearer from the file
`ANVIL_GATEWAY_TOKEN_FILE` names on every call and never reads an upstream
credential variable. Local confirmation and idempotency gates still run first;
the safety controls ride as the tool's reserved inputs; results decode into
the direct-mode contract (data, dry-run plan, or the gateway's error).

**9. Harness packaging.** `anvil package harness <bundle> --out <dir>` writes a
self-contained, gateway-only package: `SKILL.md`, `reference/`, `schemas/`,
`examples/`, `python/`, `typescript/`, `bin/<connector>` (a dependency-free
Node CLI with the generated CLI's grammar and exit codes), and `harness.json`
with the bundle hash. `anvil connectors index --grants <file> --out INDEX.md
<bundle...>` writes one short entry per granted connector. Both name a bundle
by the fleet's rule (its path under `--workspace`, folded by
`fleetToolPrefix`), so packages and the index match what the gateway serves
and what grants name; both package exactly the operations the MCP server and
SDKs serve (`isDirectlyCallable`: never a `webhook_receiver`).

## Consequences

- A harness never holds an upstream credential, and a branch can do only what
  its turn's token grants, enforced in the same hot path as every other gate.
  The index and skills a harness reads are a convenience; the gateway enforces
  the grant whatever the harness tries.
- Single-bundle serving, `--fleet` without branchyard mode, and every
  principal without a grant behave as before. The one shared change is that
  the SDKs gain a gateway module and a few constructor options.
- `examples/github-mini/` is a fixture both repositories run: `e2e.mjs`
  compiles, packages, serves in branchyard mode against a JWKS file and a mock
  upstream, connects an account, lists issues through the packaged Python SDK,
  is refused `issues.create`, and checks the audit log.
- **Deviations from Branchyard's `docs/connectors.md`:**
  - An SDK built by `anvil compile` (not `anvil package harness`) assumes its
    connector id is its folded service id; `ANVIL_GATEWAY_CONNECTOR` (or the
    `gatewayConnector` option) overrides it. Packaged SDKs and CLIs carry the
    bundle's own id, so a harness needs only the contract's two variables.
  - The gateway's connect routes (`/connect/start`, `/connect/callback`,
    `/connect/api-key`, `/connect/status`) are this ADR's; the contract names
    the flow, not the routes.
- **Deferred:**
  - Go and Java SDK gateway mode. Those clients still call upstreams directly.
  - Persisting in-flight connect `state` across a gateway restart (it is in
    memory; a restart means the person starts the flow again).
  - Grant narrowing for delegated children is Branchyard's: the gateway checks
    whatever grant the token carries.
  - Rate and spend limits keyed by branch or tenant rather than by principal.
