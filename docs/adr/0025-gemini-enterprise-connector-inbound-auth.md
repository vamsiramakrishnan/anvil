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

A third fact bounds ambition: **there is no public API to register a custom MCP
data store.** Both the direct path and the Agent Registry are console-only
(Preview). So a truthful "end-to-end" pathway automates everything up to the
registration handoff, not the handoff itself.

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

**Registration keeps a seam, not a fiction.** Because Google exposes no
registration API, the kit's admin runbook drives every scriptable prerequisite
and ends at the console (or Agent Registry) step. A future `RegistrationAdapter`
slots a real Discovery Engine call in when one ships, without changing the rest.

## Consequences
- The connector now *is* what the profile always claimed: it self-enforces the
  platform's token. The single biggest gap (an open `/mcp`) is closed, and
  `principal: delegated` finally has a runtime meaning (the OIDC mode carries a
  per-user identity).
- `@anvil/targets` is no longer dead code — `anvil target` runs it, validates the
  contract against the platform, and gates on errors.
- **Deferred (Phase 2+):**
  - Provisioning Terraform for the OAuth client, the org-policy FQDN allowlist,
    and the IAM roles; reconciling the deploy ingress (public HTTPS) with the
    in-app token enforcement (today's Terraform pins internal-only ingress).
  - Mapping a validated delegated identity onto the *upstream* call (on-behalf-of)
    — the resource server authenticates the caller; propagating that identity
    outward is the outbound-auth work in the earlier auth-gap analysis.
  - A live-boot harness check that drives `runtime/server.js` under auth (the
    loopback check currently drives the stdio server only); ES256 tokens.
  - The `RegistrationAdapter` `discoveryengine-api` implementation, if/when Google
    exposes a registration API.
