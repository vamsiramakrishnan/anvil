# ADR-0025 — The connector is an OAuth 2 resource server

**Status:** Accepted

## Context
Anvil's purpose is to be an **open-source Gemini Enterprise connector framework**:
point it at the API specs (or gateway estates) an enterprise already has, and it
produces a Gemini-Enterprise-ready BYO-MCP connector, safety compiled in.

Gemini Enterprise registers a *custom MCP server* as an agent's tool source. Two
facts from Google's current docs shape the design:

1. **Transport is StreamableHTTP only, HTTPS, at `/mcp`** — SSE is unsupported.
2. **Gemini Enterprise is the OAuth client; the MCP server must self-enforce the
   token it presents.** The platform authenticates *to* the server (an OAuth 2
   user-delegated flow, or since 2026-06 a GCP service-account token); it does
   not authenticate the caller *for* the server. It also documents an FQDN
   org-policy allowlist and a ≤100 enabled-action budget.

Registration is a real API. (An earlier revision of this ADR claimed there was no
public registration API — that was wrong, based on the console *setup guide*
rather than the RPC reference.) The Discovery Engine API's
`DataConnectorService.SetUpDataConnector`
(`POST …/locations/*:setUpDataConnector`) creates a Collection and a
`DataConnector`; a custom MCP server is a connector whose `connector_type` the
system sets to `REMOTE_MCP`. The MCP server URL and auth live in the connector's
free-form Struct params (`instance_uri`, `action_config.action_params` with
`client_id` / `token_uri`, secrets as Secret Manager references); the tool list
is `dynamic_tools`, which is **output-only** — the platform fetches it from the
server. So the end-to-end pathway can be fully programmatic.

Before this ADR, the generated server did **no** inbound authentication — `/mcp`
was open, delegated to platform IAM — and the entire `@anvil/targets` package
(profile, kit, validation) was unwired dead code. The profile even *stated* "the
MCP server must self-enforce it" while the server did not.

## Decision

**The generated MCP server is an OAuth 2 resource server.** Inbound-auth lives in
the thin serving path (`@anvil/mcp-runtime`, `inbound-auth.ts`) so it deploys
with the server and stays dependency-free:

- `verifyInboundToken(header, config)` validates the bearer JWT: RS256 signature
  against the issuer's JWKS (`node:crypto`, JWK → public key — no JWT library),
  then `iss` / `aud` / `exp` / `nbf` / required-scope checks. A bad token is a
  structured `401 invalid_token` / `403 insufficient_scope` with a
  `WWW-Authenticate` challenge — never a throw, never an admitted caller. It
  **fails closed**: a JWKS it cannot fetch is a rejected token, not a bypass.
- Two modes, both real: `google_service_account` (Google issuer + certs, machine
  identity) and `oidc` (a user-delegated IdP token — Google, Okta, Entra — via
  OpenID discovery). `none` (the default) preserves prior local behavior. The
  JWKS fetch is injectable, so the whole verifier is unit-tested offline against
  a real signed token.
- The generated StreamableHTTP server gates `/mcp` (and `/metrics`, `/openapi`)
  on this check, keeps health probes open, and serves the MCP Authorization
  discovery document at `/.well-known/oauth-protected-resource`.

**The connector kit is wired into a real command.** `anvil target
gemini-enterprise <dir> --endpoint <url>` generates the kit (`@anvil/targets`),
now including an `inbound-auth.env` contract that ties the server's resource-server
config to the endpoint (the OAuth client's token audience must equal
`ANVIL_INBOUND_AUDIENCE`; its scopes must cover `ANVIL_INBOUND_REQUIRED_SCOPES`).
The profile is corrected to Google's live requirements (StreamableHTTP-only,
100-action budget, FQDN allowlist, both auth modes, `provisional` provenance
against the dated doc).

**Registration is programmatic.** The kit emits a ready `SetUpDataConnector`
request body (`registration.request.json`) and a `registration.curl.sh` that
POSTs it with the caller's own credentials — Anvil holds none. The connector's
`instance_uri`, OAuth params, and Secret Manager secret references are filled from
what Anvil already knows; two values that the RPC reference leaves to a free-form
Struct — the exact `data_source` identifier and the precise param split for
`REMOTE_MCP` — are isolated in one place and marked provisional until validated
against a live project. The console remains an equivalent alternative to the call.

## Consequences
- The connector now *is* what the profile always claimed: it self-enforces the
  platform's token. The single biggest gap (an open `/mcp`) is closed, and
  `principal: delegated` finally has a runtime meaning (the OIDC mode carries a
  per-user identity).
- `@anvil/targets` is no longer dead code — `anvil target` runs it, validates the
  contract against the platform, and gates on errors.
**Phase 2 (landed):** the generic Cloud Run deploy is parameterized (`var.ingress`,
`var.allow_unauthenticated`, `var.env`) with defaults that preserve the
internal-only posture, and the connector kit emits the overlay that flips it to
public ingress + injects the inbound-auth env + adds the `discoveryengine.editor`
IAM — so the "public endpoint vs internal ingress" contradiction is resolved
without platform specifics leaking into the core deploy. The resource-server
guard is now exercised over a real socket (a live-boot HTTP test: 401 without a
token, 200 with a token verified against a live JWKS, health open), and ES256 is
supported alongside RS256.

**Phase 3 (landed):** the `SetUpDataConnector` registration request is built and
emitted by the kit (`registration.request.json` + `registration.curl.sh`), and
the earlier "no public API" claim is corrected across the profile, runbook, CLI,
and this ADR.

- **Deferred (Phase 4+):**
  - Confirming the two provisional values (`data_source` for REMOTE_MCP, and the
    exact `params`/`action_params`/`auth_params` split) against a live project or a
    Google sample, then removing the provisional markers.
  - Optionally POSTing the request from the CLI using Application Default
    Credentials (today the kit emits the request + curl; the operator runs it).
  - Mapping a validated delegated identity onto the *upstream* call (on-behalf-of,
    RFC 8693 token exchange) — the outbound-auth work from the earlier auth-gap
    analysis.
  - Provisioning the OAuth *client* itself (inherently IdP/console-side) beyond
    emitting its exact configuration.
