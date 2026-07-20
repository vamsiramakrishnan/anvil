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
system sets (output-only) to `REMOTE_MCP` from `data_source = custom_mcp`. The
server URL and OAuth flow live in `action_config.action_params` (`auth_type` is
`OAUTH` or `NO_AUTH`, with `auth_uri`/`token_uri`/`scopes`/`client_id`/
`client_secret` and `instance_uri`/`mcp_server_source`), with a seed token in
`params.oauth_access_token`; the tool list is `dynamic_tools`, which is
**output-only** — the platform fetches it from the server. The request body is
buildable programmatically, but an OAUTH connector reaches ACTIVE only after the
console's interactive OAuth Authorize step (see the "validated against a live
project" note below).

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
100-action budget, `OAUTH`/`NO_AUTH` methods → `oidc`/`none`, `provisional`
provenance against the live API — see Phase 4).

**Registration body is built by the kit; the console finishes it.** The kit emits
a ready `SetUpDataConnector` body (`registration.request.json`) and a
`registration.curl.sh` that POSTs it under the caller's own credentials — Anvil
holds none. The `data_source` (`custom_mcp`) and the `action_config.action_params`
shape (OAuth flow + `instance_uri` + `mcp_server_source`) are now **confirmed**
against the live API and 7 real connectors (Phase 4). But an OAUTH connector only
reaches ACTIVE after the console's interactive OAuth **Authorize** step, so the
console is the reliable registration path, not merely an alternative.

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

**Phase 4 (landed) — validated against live projects.** Probed against the live
Discovery Engine API (real GE projects, location `global`, v1alpha, 2026-07-17),
**7 real ACTIVE `custom_mcp` connectors read back**, and a real StreamableHTTP
server deployed to public Cloud Run. Full evidence:
`docs/backtesting/GEMINI_ENTERPRISE_VALIDATION.md`. Confirmed:
- `data_source = custom_mcp` is the only identifier the platform resolves (every
  other guess → 404).
- The server URL + OAuth flow live in `action_config.action_params`
  (`auth_type`, `auth_uri`, `token_uri`, `scopes`, `instance_uri`,
  `mcp_server_source`, `client_id`, `client_secret`) with a seed
  `params.oauth_access_token` and `create_bap_connection`. `auth_type` is
  **`OAUTH` or `NO_AUTH`** only (all others rejected). `registration.ts` now
  emits this shape; `OAUTH`→`oidc` and `NO_AUTH`→`none`. (A "protected" project's
  misleading errors had briefly suggested a static-token-only shape — the 7 real
  connectors corrected that.)
- A real Anvil bug: the generated server was **stateless**, so GE's
  `initialize → tools/list` failed (`Method not found`). It is now **session-based**
  (`entrypoints.ts`) — a fresh session per `initialize`, reused by `mcp-session-id`.
- The wall to a fully-scripted ACTIVE connector: the raw API creates the record
  but hits `INITIALIZATION_FAILED` before calling the server — the interactive
  OAuth **Authorize** step (BAP-connection consent) is console-only. Hence the
  profile stays `provisional`; GE's own inbound OAuth token (the user's IdP token,
  `oidc`) is not yet captured end to end.

- **Deferred (Phase 5+):**
  - Completing the console Authorize step to observe GE's inbound token end to
    end, then promoting the profile to `verified`.
  - Generating the IdP OAuth app-registration command (redirect URI
    `https://vertexaisearch.cloud.google.com/oauth-redirect`) as part of the kit.
  - Optionally POSTing the request from the CLI using Application Default
    Credentials (today the kit emits the request + curl; the operator runs it).
  - Mapping a validated delegated identity onto the *upstream* call (on-behalf-of,
    RFC 8693 token exchange) — the outbound-auth work from the earlier auth-gap
    analysis.
  - Provisioning the OAuth *client* itself (inherently IdP/console-side) beyond
    emitting its exact configuration.
