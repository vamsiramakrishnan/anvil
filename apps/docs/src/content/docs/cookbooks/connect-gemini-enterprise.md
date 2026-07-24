---
title: "Connect Gemini Enterprise"
description: "Choose Custom MCP or Agent Gateway, set the right project and locations, keep identity planes separate, certify the target, and hand off live registration without confusing a plan for a deployment."
sidebar:
  order: 6
---

Anvil supports two distinct Gemini Enterprise journeys. Pick one deliberately:

| Journey | Choose it when | What Anvil generates |
| --- | --- | --- |
| **Custom MCP Server data store** | One Gemini Enterprise app should call your public MCP endpoint directly | Console-first registration fields, OAuth setup, compatibility checks, and an experimental API reference |
| **Agent Registry + Agent Gateway** | You need governed discovery, gateway authorization, and engine-wide egress control | Tool spec, registry and gateway definitions, readiness, reconcile, bind, verification, and rollback scripts |

Custom MCP is the shorter route. Agent Gateway changes the engine's egress
path, so it requires more coordinates, IAM evidence, and an explicit reroute
acknowledgement. Do not select `--surface both` merely because both exist.

## Before you begin: locate the source contract

The Gemini target attaches to an existing Anvil bundle; it does not discover or
copy a Swagger file from Gemini Enterprise.

When `anvil compile` receives an OpenAPI or Swagger file, Anvil locks the exact
entrypoint and its reachable local references under:

```text
.anvil/sources/<snapshot-id>/source.json
.anvil/sources/<snapshot-id>/raw/<entrypoint>
```

The bundle's `air.yaml` records that `snapshotId`, source format, and
snapshot-relative `entrypoint`. These commands show and verify the locked
source:

```bash
pnpm anvil source list
pnpm anvil source show <snapshot-id>
pnpm anvil source validate <snapshot-id>
pnpm anvil status <bundle>
```

For a gateway import, the import report also records the vendor export,
selected API, locked OpenAPI/Swagger entrypoint, and receipt. See [Import a
gateway estate](/anvil/cookbooks/import-a-gateway-estate/).

Approve only the operations you inspected, then generate the target before
certification. Target files are part of the certified bundle hash.

## Keep four identity planes separate

Most setup failures come from using one identity field for a different plane:

| Plane | What it controls | Anvil inputs |
| --- | --- | --- |
| Gemini Enterprise user sign-in | Who can open and use the app | Optional `--wif locations/global/workforcePools/<pool>` |
| MCP resource server | Which bearer token the public `/mcp` endpoint accepts | `--server-auth`, `--idp`, `--tenant`, `--oauth-scope`, `--inbound-issuer`, `--inbound-audience` |
| Agent Gateway | Which Google-managed agent may resolve, traverse, and invoke | `--agent-identity-principal-set`, `--gateway-authorization-policy`, plus IAM readiness evidence |
| Upstream API | How the Anvil runtime calls the API it wrapped | The generated `deploy/credentials.required.yaml` and `skill/reference/setup.md` |

Workforce Identity Federation does not protect `/mcp`. Agent Gateway IAM does
not replace the MCP bearer-token check. Inbound MCP OAuth does not supply the
runtime's outbound API credential.

## Locations and project coordinates

`--project` is the 6–30 character lowercase Google Cloud project **ID**.
`--project-number` is the complete provider-assigned numeric identity used in
canonical resources; placeholders or truncated values such as `123` are
rejected. Do not swap them.

`--location` names the Gemini Enterprise app and engine location. A canonical
engine resource has this exact shape:

```text
projects/<project-number>/locations/<location>/collections/<collection>/engines/<engine>
```

When supplied, `--project-number` must equal the project number in a canonical
engine resource, and `--location` must equal its location. When Agent Gateway
receives only an engine ID, `--project-number` is required so Anvil can
construct the canonical resource. Anvil cannot prove offline that a project ID
and project number refer to the same live project; verify that relationship
before registration.

The generated Agent Gateway path deliberately supports this verified matrix:

| Gemini app / engine | Agent Gateway | Manual Agent Registry |
| --- | --- | --- |
| `global` | `us-central1` | `global` or `us-central1` |
| `us` | `us-central1` | `global` or `us-central1` |
| `eu` | `europe-west1` | `global` or `europe-west1` |

Other app locations fail closed for the Agent Gateway journey. Custom MCP can
record a valid Google-style location, but Anvil warns that you must verify
current provider availability before registration.

## Journey A: Custom MCP with OAuth

Your endpoint must be a public, credential-free HTTPS URL whose path is exactly
`/mcp`. It uses MCP Streamable HTTP, not SSE.

This Entra example keeps the MCP API's scope, issuer, and audience explicit:

```bash
pnpm anvil target gemini-enterprise <bundle> \
  --surface custom-mcp \
  --server-auth oauth \
  --endpoint https://mcp.example.com/mcp \
  --project acme-prod \
  --location global \
  --engine support-app \
  --idp entra \
  --tenant <entra-tenant-id> \
  --oauth-scope api://anvil-mcp/mcp.invoke \
  --inbound-issuer https://login.microsoftonline.com/<entra-tenant-id>/v2.0 \
  --inbound-audience api://anvil-mcp
```

Anvil also supports `--idp okta` and `--idp other`. Okta requires its domain in
`--tenant`. `other` requires explicit HTTPS authorization and token URLs.
Scopes must identify this MCP API; an unrelated scope such as Microsoft Graph
`User.Read` is rejected. Register this fixed redirect URI with the OAuth
client:

```text
https://vertexaisearch.cloud.google.com/oauth-redirect
```

The generated resource server currently validates JWT access tokens. Anvil
therefore rejects `--idp google` rather than pretending it can validate every
Google token shape.

No-auth is possible only with an explicit acknowledgement:

```bash
pnpm anvil target gemini-enterprise <bundle> \
  --surface custom-mcp \
  --server-auth no-auth \
  --allow-unauthenticated-mcp \
  --endpoint https://mcp.example.com/mcp \
  --project acme-prod \
  --location global \
  --engine support-app
```

That leaves the public endpoint without a bearer-token gate; app sign-in and
WIF do not change that fact.

## Journey B: Agent Registry and Agent Gateway

This path additionally needs the numeric project identity, the exact
Google-managed agent principal set, a regional authorization policy, and
acknowledgement that binding changes all egress for the engine:

```bash
pnpm anvil target gemini-enterprise <bundle> \
  --surface agent-gateway \
  --server-auth oauth \
  --endpoint https://mcp.example.com/mcp \
  --project acme-prod \
  --project-number 123456789012 \
  --location global \
  --engine support-app \
  --gateway-location us-central1 \
  --registry-location global \
  --agent-identity-principal-set \
    principalSet://agents.global.org-987654321098.system.id.goog/attribute.container/projects/123456789012 \
  --gateway-authorization-policy \
    projects/acme-prod/locations/us-central1/authzPolicies/anvil-mcp \
  --idp entra \
  --tenant <entra-tenant-id> \
  --oauth-scope api://anvil-mcp/mcp.invoke \
  --inbound-issuer https://login.microsoftonline.com/<entra-tenant-id>/v2.0 \
  --inbound-audience api://anvil-mcp \
  --confirm-engine-egress-reroute
```

Anvil validates coordinate shape and cross-field agreement before writing a
file. That is offline validation, not proof that a resource exists or that IAM
is ready. Follow the generated target README: create its readiness record,
verify each named permission and endpoint, reconcile owned registry/gateway
resources, review readback, and bind the engine last. The generated rollback
script restores the recorded previous engine configuration.

## Certify, plan, then reconcile live evidence

After either target is generated:

```bash
pnpm anvil status <bundle>
pnpm anvil certify <bundle>
pnpm anvil selftest <bundle>
pnpm anvil conformance <bundle>
pnpm anvil simulate <bundle>
pnpm anvil publish <bundle> --env prod
pnpm anvil status <bundle>
```

`target` generates registration artifacts. `certify` proves the static bundle
is internally coherent. The next three commands bind executable evidence to
that exact bundle digest. `publish` then records a gated deployment plan; it
makes no cloud API call. None of those commands proves a cloud service or
Gemini registration is live.

Apply the generated deployment inputs through your delivery system, complete
the console or guarded gateway steps, and retain provider readback separately.
After a current local plan exists, `anvil status` reports
`operator-action-required`; it does not claim a live or reconciled cloud state.
