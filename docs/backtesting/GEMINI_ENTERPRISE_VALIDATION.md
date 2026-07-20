# Gemini Enterprise connector — live validation

Validating Anvil's generated Gemini Enterprise connector against **real** Gemini
Enterprise / Discovery Engine projects, to resolve the two documented unknowns
and confirm what the platform actually requires and presents.

- **Location:** `global` · **API:** Discovery Engine `v1alpha`
- **Dates:** 2026-07-17 (project ids / numbers / tenant / client / host ids redacted)
- **Method:** empirical — POST `:setUpDataConnector` and read the errors; read
  back **7 real, working `custom_mcp` connectors**; deploy a real StreamableHTTP
  server to Cloud Run and observe GE's inbound calls.

All tokens/secrets/ids below are **redacted**.

> A note on method: an earlier pass used a **"protected" project** whose error
> messages (`Missing Parameter Private App Access Token`) suggested auth was a
> single static `params.oauth_access_token`. Reading back **real working
> connectors** in a normal project corrected that: the token is only a *seed*;
> the real auth lives in `action_config.action_params`. Ground truth beats error
> messages.

---

## Result summary

| Question | Prior guess | Confirmed reality | How |
|---|---|---|---|
| `data_source` | `custom_mcp` | ✅ **`custom_mcp`** | only value that resolves (others → 404) |
| server URL field | `params.instance_uri` | **`action_config.action_params.instance_uri`** (system promotes it into `params` after) | 7 live connectors + create errors |
| auth placement/keys | `action_config.action_params` client creds | ✅ **`action_config.action_params`** with `auth_type`, `auth_uri`, `token_uri`, `scopes`, `client_id`, `client_secret` (+ `params.oauth_access_token` seed) | 7 live connectors + create |
| auth methods | oidc / google_service_account | **`OAUTH` or `NO_AUTH`** only | probed `auth_type` (others rejected) |
| inbound token (OAUTH) | google_service_account JWT | user-delegated **IdP token → `oidc`** | model confirmed; full token not observed (console-gated) |
| `connector_type` | output-only `REMOTE_MCP` | ✅ output-only enum `REMOTE_MCP` | discovery doc |

---

## Unknown #1 — `data_source` = `custom_mcp`
`POST …:setUpDataConnector` varying only `dataConnector.dataSource`:
- `custom_mcp` → resolves (reaches field-level validation / creates).
- `remote_mcp`, `mcp`, `mcp_server`, `custom_connector`, `<bogus>` → **404 NOT_FOUND**.

`connectorType` is confirmed output-only in the discovery document with
`REMOTE_MCP` ("Remote MCP based connector.") among the enum values.

## Unknown #2 — auth lives in `action_config.action_params` (not just `params`)

Read back from **7 live, ACTIVE `custom_mcp` connectors** (Figma, Salesforce,
weather, IT, …). Every one has:

```jsonc
{
  "dataSource": "custom_mcp",
  "params": { "instance_uri": "https://<server-host>/mcp" },   // promoted here post-create
  "actionConfig": {
    "actionParams": {
      "auth_type": "OAUTH",
      "auth_uri":  "https://<idp>/authorize",
      "token_uri": "https://<idp>/token",
      "auth_uri_params": "&access_type=offline&prompt=consent",
      "scopes": "openid email profile offline_access",
      "instance_uri": "https://<server-host>/mcp",
      "mcp_server_description": "…",
      "mcp_agent_instructions": "…",
      "mcp_server_source": "BYO_MCP"
      // client_id / client_secret are write-only (not returned on read)
    },
    "createBapConnection": true
  },
  "connectorType": "THIRD_PARTY_FEDERATED",       // output-only
  "connectorModes": ["FEDERATED"],                 // output-only
  "dynamicTools": [ /* fetched from the server */ ]// output-only
}
```

The **create-time** request shape (confirmed by creating real connectors) also
needs a seed token in `params`:

```jsonc
{
  "collectionId": "<id>", "collectionDisplayName": "<name>",
  "dataConnector": {
    "dataSource": "custom_mcp",
    "refreshInterval": "86400s",                    // required; min 3h, max 28d
    "params": { "oauth_access_token": "<REDACTED — Private App Access Token>" },
    "actionConfig": {
      "actionParams": { "auth_type": "OAUTH", "auth_uri": "…", "token_uri": "…",
                        "scopes": "…", "instance_uri": "https://<host>/mcp",
                        "mcp_server_description": "…", "mcp_server_source": "BYO_MCP",
                        "client_id": "<REDACTED>", "client_secret": "<REDACTED>" },
      "createBapConnection": true
    }
  }
}
```

Create-time errors that pin the schema:
- `params: {}` → `Missing Parameter Private App Access Token …`
- `params: { instance_uri }` → `Data Connector parameters must be one of: oauth_access_token but got: instance_uri` (⇒ `instance_uri` belongs in `actionParams`, not `params`)
- `client_id` under `params` → rejected.

### Auth methods — `OAUTH` or `NO_AUTH` only
Probing `auth_type`:

| `auth_type` | result |
|---|---|
| `OAUTH` | ✅ accepted — requires `client_id` |
| `NO_AUTH` | ✅ accepted |
| `NONE`, `API_KEY`, `PRIVATE_APP`, `BEARER` | ❌ "Connector source 'custom_mcp' does not have authorization type …" |

Mapped to Anvil inbound modes: **`OAUTH` → `oidc`** (validate the user's IdP
token), **`NO_AUTH` → `none`**. (The `google_service_account` mode inferred in the
protected project was an artifact of Cloud Run IAM-gating, **not** a GE method.)

## Unknown #3 — inbound token & the end-to-end wall

- **Deploy works**: the generated StreamableHTTP server ran on public Cloud Run;
  `POST /mcp` `initialize` → correct `serverInfo`.
- **GE reaches the server**: on a `NO_AUTH` attempt, the server logged inbound
  `POST /mcp` with **no Authorization header** (as expected for NO_AUTH).
- **A real Anvil server bug — found & fixed**: the generated server was
  **stateless** (`sessionIdGenerator: undefined`), so GE's `initialize → tools/list`
  (separate HTTP requests) failed with `-32601 Method not found`. Made it
  **session-based** (mint `mcp-session-id` on initialize, reuse it); `tools/list`
  then returns the tool. Also: exposing a tool needs `anvil build <capability>`
  after `anvil approve`, not `approve` alone (the runtime manifest was empty).
- **The wall**: a raw `setUpDataConnector` API call **creates the record but the
  connector never reaches ACTIVE** — it hits `INITIALIZATION_FAILED` (`code 13
  INTERNAL, pipeline failure`) *before calling the server*, for both `NO_AUTH`
  and `OAUTH` (even with real Entra client creds). All 7 working connectors were
  **console-created**: the interactive OAuth **Authorize** step (BAP-connection
  provisioning / user consent) is only completed by the GE console. So GE's own
  inbound token in `OAUTH` mode could not be captured by scripting alone; it is
  the user's IdP access token (`oidc`), validated by the server.

### Entra OAuth app (the devex seam)
GE connectors use a fixed redirect URI: **`https://vertexaisearch.cloud.google.com/oauth-redirect`**,
single-tenant (`AzureADMyOrg`), Graph `User.Read`. Created via
`az ad app create --web-redirect-uris <that> --required-resource-accesses <graph User.Read>`
+ `az ad app credential reset` + `az ad sp create`. This is the manual step Anvil
should generate (see below).

---

## What changed in the repo
- `packages/generators/src/entrypoints.ts` — generated MCP server is now
  **session-based** (stateful StreamableHTTP) so GE's `initialize → tools/list`
  works; the old stateless transport is the bug that broke the tool-list fetch.
- `packages/targets/src/registration.ts` — `setUpDataConnector` body corrected to
  the real shape: `params.oauth_access_token` **+** `action_config.action_params`
  (`auth_type` OAUTH/NO_AUTH, `auth_uri`/`token_uri`/`scopes`/`client_id`/
  `client_secret`, `instance_uri`, `mcp_server_source=BYO_MCP`) **+**
  `create_bap_connection`. Prerequisites note the console-only Authorize step and
  the fixed GE redirect URI.
- `packages/targets/src/gemini-enterprise.ts` — profile models the two real
  methods (`OAUTH`→oidc, `NO_AUTH`→none); dropped the `google_service_account`
  claim; records the console-Authorize limitation.
- `packages/targets/src/generate.ts` — inbound-auth env + admin runbook rewritten
  to the OAUTH/oidc (and NO_AUTH) reality and the console registration path.
- Tests updated (`packages/targets/src/targets.test.ts`); this doc + ADR 0025.

## Anvil devex recommendations (from this exercise)
1. **Generate the IdP app-registration command**, not an empty `oauth.template.json`
   — the GE redirect URI and single-tenant audience are fixed, knowable inputs.
2. **Model `OAUTH` vs `NO_AUTH`** as first-class and emit the exact
   `action_config.action_params` shape (secret as a Secret Manager ref).
3. **Ship a GE-shaped (session-based) server by default.**
4. **One `anvil target … --register` path**: build → deploy → provision IdP app →
   POST `setUpDataConnector` → hand off the console Authorize step.

## Reproduce (schema probe)
```bash
TOKEN=$(gcloud auth print-access-token)
curl -sS -X POST \
  "https://discoveryengine.googleapis.com/v1alpha/projects/<PROJECT_ID>/locations/global:setUpDataConnector" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "X-Goog-User-Project: <PROJECT_ID>" \
  -d '{"collectionId":"probe","collectionDisplayName":"probe","dataConnector":{"dataSource":"custom_mcp","params":{}}}'
# -> 400 "Missing Parameter Private App Access Token for Custom MCP Server data source"
```
