---
name: anvil-gemini-enterprise
description: Connect an Anvil bundle to Gemini Enterprise as a BYO-MCP connector: the two registration surfaces (custom-MCP DataConnector vs. Agent Registry / Agent Gateway), which to pick, and the exact end-to-end steps.
---

# Connect a bundle to Gemini Enterprise (BYO-MCP)

`anvil target gemini-enterprise <dir> --endpoint <https://host/mcp>` writes a kit
under `<dir>/targets/gemini-enterprise/` AND prints a guided, copy-paste-first
plan: choose a surface → identity → commands to run → console-only steps (each
with a pre-assembled console deep link and paste-ready fields). Pass more context
to fill it in — `--project`, `--engine`, `--location`, `--idp google|entra|okta`,
`--tenant`, `--wif <pool>`, `--gateway-location` — so the emitted artifacts and
the printed steps carry real values, not placeholders. `--json` emits the whole
plan for a harness. The MCP server it points at is the generated StreamableHTTP
server (`runtime/server.js`) — deploy it first (`anvil deploy cloud-run <dir>`),
publicly reachable over HTTPS. SSE is not supported. The server is session-based
(it mints an `mcp-session-id` on `initialize`), which the platform requires.

## First decide identity (where the OAuth client lives)
Ask the operator how GE end users sign in — it decides which IdP hosts the OAuth
client and the auth/token URLs + the server's inbound issuer/audience:
- **Google** identities → OAuth client in Google Cloud (APIs & Services → Credentials).
- **Microsoft Entra** → an Entra app registration (`--idp entra --tenant <id>`).
- **Okta / other OIDC** → an app there (`--idp okta --tenant <domain>`).
- **Workforce Identity Federation** (GE sign-in federated into a Google Workforce
  pool): pass `--wif <pool>` — the OAuth client still lives at the source IdP, but
  the token GE presents is the federated identity, so set the server's
  `ANVIL_INBOUND_ISSUER/AUDIENCE` to that federated issuer/audience.
Every OAuth client's redirect URI must be `https://vertexaisearch.cloud.google.com/oauth-redirect`.

## Two registration surfaces — pick one

| | **Custom-MCP DataConnector** | **Agent Registry / Agent Gateway** |
|---|---|---|
| Files | `registration.request.json`, `registration.curl.sh` | `agent-registry/` (toolspec.json, agent-gateway.yaml, agent-registry.tf, register.sh, agent-gateway.md) |
| Registers via | Discovery Engine `setUpDataConnector` | `gcloud agent-registry services create` / Terraform |
| Auth to the server | user OAuth (`auth_type=OAUTH`) or `NO_AUTH` | Google agent-identity principalSet + IAM |
| Fully scriptable? | No — OAUTH needs the console **Authorize** step | Yes, except the final console **Add tool** import |
| Gateway-governed? | No | Yes (egress policy over registered entries) |
| Use when | a standalone MCP data store in one GE app | tools for deployed agents, with central governance |

Both are emitted; delete the one you do not use.

## DataConnector — end-to-end
1. Deploy the server; confirm `/healthz` is open and `/mcp` 401s without a token.
2. Register an OAuth client at your IdP whose redirect URI is
   `https://vertexaisearch.cloud.google.com/oauth-redirect`. `auth_type` is
   `OAUTH` or `NO_AUTH` only.
3. Fill `registration.request.json` (client_id/secret from Secret Manager,
   auth_uri/token_uri/scopes) and set `inbound-auth.env` on the server so it
   validates the token the platform presents (`oidc`: issuer + audience are your
   IdP's — the token's `aud` is the scope's resource, not the server URL).
4. Create it in the **console** (Data stores → Custom MCP Server) and click
   **Authorize** — the raw API create cannot complete the interactive OAuth
   consent, so it stops at `INITIALIZATION_FAILED` on its own.

## Agent Registry / Agent Gateway — end-to-end
Regional alignment is required: a `global`/`us` app pairs with a `us-central1`
gateway; `eu` with `europe-west1`. The MCP server registration, the gateway, and
its registry must share that location (the GE app is separate).
1. Deploy the server (same as above).
2. `bash register.sh` (or apply `agent-registry.tf` + import `agent-gateway.yaml`):
   registers the server + `toolspec.json` in Agent Registry (in the gateway's
   region), reuses or creates the egress gateway, and binds it to the GE engine
   (`agentGatewaySetting.defaultEgressAgentGateway.name` — this reroutes the
   engine's agent egress; unset to revert).
3. Grant the agent identity `roles/iap.egressor` + `roles/agentregistry.viewer` +
   `roles/run.invoker` (see `agent-registry.tf`).
4. Import it into the app in the **console**: Connected data stores → + New data
   store → MCP servers → Show all → Add tool. (Console-only; no API.)

## Token propagation (what the server sees)
- DataConnector `OAUTH`: the platform forwards the **user's** OAuth access token to
  `/mcp` (`iss`=your IdP, `aud`=the scope's resource). Validate it (`oidc`).
- `NO_AUTH`: no token — only safe behind other controls.
- Agent Gateway: the **agent identity** authorizes the hop through the gateway
  (IAP); for an OAUTH-imported server the user token still flows underneath. To
  make `aud` equal your server, register it as an API in your IdP and use its scope.

## Guardrails
Only approved operations become tools, so the `toolspec.json` and the served
`tools/list` are the same set — keep enabled tools under the 100-action budget
(`anvil distill` trims). `toolspec.json` must stay ≤ 10 KB. Never commit secrets;
client secrets and the Private App Access Token come from Secret Manager.
