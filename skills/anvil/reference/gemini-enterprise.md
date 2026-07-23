---
name: anvil-gemini-enterprise
description: Connect an approved Anvil bundle to Gemini Enterprise through one explicit Custom MCP or Agent Gateway journey, with the locations, identity boundaries, deployment inputs, readiness evidence, and rollback steps spelled out.
---

# Connect a bundle to Gemini Enterprise

Generate the target after approving the operations you intend to expose and
before certification:

```bash
anvil target gemini-enterprise <bundle> \
  --surface <custom-mcp|agent-gateway> \
  --server-auth <oauth|no-auth> \
  --endpoint https://mcp.example.com/mcp \
  --project <project-id> \
  --location <gemini-enterprise-app-location> \
  --engine <engine-id-or-canonical-resource>
```

Both `--surface` and `--server-auth` are mandatory. Use `--surface both` only
when you deliberately need both registration paths. Omit `--out`: the target
must live at `<bundle>/targets/gemini-enterprise/` so `anvil status` and
`anvil certify` can regenerate it from `setup.json` and detect a missing, extra,
or changed target file.

The endpoint must be the exact public, credential-free HTTPS URL ending in
`/mcp`; query strings, fragments, localhost, and private IP literals are
rejected. The generated server uses StreamableHTTP and preserves MCP sessions.
SSE is not a supported transport.

## Choose one registration surface

| | `custom-mcp` | `agent-gateway` |
| --- | --- | --- |
| Platform object | Custom MCP data store in a Gemini Enterprise app | MCP service in Agent Registry, reached through Agent Gateway |
| Normal setup | Console-first | Guarded generated scripts, then a console import |
| Network path | Gemini Enterprise calls the public `/mcp` URL directly | The engine routes agent egress through the gateway |
| Gateway policy | Does not pass through Agent Gateway | Agent Gateway authorization and governance apply |
| Server authentication | OAuth 2.0 or explicitly acknowledged no-auth | Gateway IAM plus the independently selected OAuth/no-auth check at `/mcp` |
| Generated artifacts | Registration template and experimental API script | Tool spec, registry/gateway definitions, readiness, reconcile, bind, and rollback scripts |

Custom MCP is the shorter journey for one app. Agent Gateway is the governed
journey and changes the engine's default egress route. Do not generate both just
because both are available.

## Keep the three identity planes separate

1. **Gemini Enterprise sign-in** controls who can open and use the GE app.
   `--wif <pool>` records a Workforce Identity Federation pool for this plane.
2. **MCP resource-server identity** controls which bearer tokens the public
   `/mcp` endpoint accepts. `--idp`, `--oauth-scope`, `--inbound-issuer`, and
   `--inbound-audience` configure this plane.
3. **Agent Gateway identity** is the Google-managed agent
   `principalSet://...` authorized by IAM to resolve registry entries, traverse
   the gateway, and invoke the runtime.

`--wif` never derives the issuer, audience, or scopes accepted by `/mcp`.
Likewise, Agent Gateway IAM does not replace the MCP server's bearer-token
validation.

### Configure the MCP resource server

For OAuth, Anvil currently supports JWT access tokens from Entra, Okta, or an
explicit OIDC-compatible authorization server:

```bash
anvil target gemini-enterprise <bundle> \
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

- Entra and Okta require `--tenant` (the Entra tenant id or Okta domain).
- `--idp other` requires both `--oauth-authorization-url` and
  `--oauth-token-url`, as credential-free HTTPS URLs.
- Every `--oauth-scope` must address this MCP API. Do not use Microsoft Graph
  `User.Read` as a stand-in for an MCP scope.
- `ANVIL_INBOUND_RESOURCE` is derived from the public `/mcp` URL and is used for
  protected-resource discovery. `ANVIL_INBOUND_AUDIENCE` is the separate JWT
  audience, such as `api://anvil-mcp`.
- Register the fixed redirect URI
  `https://vertexaisearch.cloud.google.com/oauth-redirect` on the OAuth client.

Although the GE console can configure a Google OAuth client, Anvil rejects
`--idp google` today: Google access tokens may be opaque, while the generated
resource server currently has a JWT verifier. This is an intentional fail-closed
boundary.

No-auth is also explicit:

```bash
anvil target gemini-enterprise <bundle> \
  --surface custom-mcp \
  --server-auth no-auth \
  --allow-unauthenticated-mcp \
  --endpoint https://mcp.example.com/mcp \
  --project acme-prod \
  --location global \
  --engine support-app
```

This leaves `/mcp` without a bearer-token gate. GE sign-in and `--wif` do not
protect that URL.

## Locations

`--location` always names the Gemini Enterprise app and engine location. A full
engine resource has this exact shape:

```text
projects/<project-number>/locations/<location>/collections/<collection>/engines/<engine>
```

The resource uses a numeric project number, not the project id, and its location
must equal `--location`. When `--engine` is only an id, the Agent Gateway journey
also requires `--project-number` so Anvil can build that canonical resource.

For Custom MCP, Anvil records any nonempty app location and emits a warning to
verify that location against the live provider before registration.

For Agent Gateway, Anvil deliberately supports only this verified matrix:

| GE app / engine `--location` | `--gateway-location` | Manual MCP `--registry-location` |
| --- | --- | --- |
| `global` | `us-central1` | `global` or `us-central1` |
| `us` | `us-central1` | `global` or `us-central1` |
| `eu` | `europe-west1` | `global` or `europe-west1` |

Other GE app locations fail closed for this generated Agent Gateway journey.
Manual MCP registration is not supported in the `us` and `eu` multi-region
Agent Registry locations, so Anvil does not use those two values for this path.
The app, gateway, registry, and canonical engine must also be in the configured
project.

## Deploy from external Terraform inputs

Target generation writes
`targets/gemini-enterprise/terraform/cloud-run.tfvars`. It contains only
non-secret, surface-specific inputs already declared by the generic
`deploy/terraform` module, including inbound auth and the exact invoker
principal. Never copy it into `deploy/terraform` or edit generated files.

Certify the target first, then initialize, plan, and apply from an empty
directory outside the bundle:

```bash
set -euo pipefail
export ANVIL_BUNDLE_DIR="$(cd <bundle> && pwd -P)"
export ANVIL_TF_WORK_DIR=/absolute/private/path/terraform-work
export ANVIL_TF_STATE_BUCKET=<existing-gcs-state-bucket>
export ANVIL_TF_STATE_PREFIX=anvil/<service>-tools
export TF_VAR_project_id=<project-id>
export TF_VAR_image_tag=<immutable-container-image-tag>

anvil certify "$ANVIL_BUNDLE_DIR"

if [[ "$ANVIL_TF_WORK_DIR" != /* ]]; then
  echo "ANVIL_TF_WORK_DIR must be absolute" >&2
  exit 1
fi
install -d -m 700 "$ANVIL_TF_WORK_DIR"
export ANVIL_TF_WORK_DIR="$(cd "$ANVIL_TF_WORK_DIR" && pwd -P)"
case "$ANVIL_TF_WORK_DIR/" in
  "$ANVIL_BUNDLE_DIR/"*)
    echo "ANVIL_TF_WORK_DIR must be outside the bundle" >&2
    exit 1
    ;;
esac
if [[ -n "$(find "$ANVIL_TF_WORK_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  echo "ANVIL_TF_WORK_DIR must be empty" >&2
  exit 1
fi

cp -R "$ANVIL_BUNDLE_DIR/deploy/terraform/." "$ANVIL_TF_WORK_DIR/"
terraform -chdir="$ANVIL_TF_WORK_DIR" init -input=false \
  -backend-config="bucket=$ANVIL_TF_STATE_BUCKET" \
  -backend-config="prefix=$ANVIL_TF_STATE_PREFIX"
terraform -chdir="$ANVIL_TF_WORK_DIR" plan -input=false \
  -var-file="$ANVIL_BUNDLE_DIR/targets/gemini-enterprise/terraform/cloud-run.tfvars" \
  -out="$ANVIL_TF_WORK_DIR/tfplan"
# Stop for plan review and approval.
terraform -chdir="$ANVIL_TF_WORK_DIR" apply "$ANVIL_TF_WORK_DIR/tfplan"
```

`.terraform/`, `.terraform.lock.hcl`, and `tfplan` remain in
`ANVIL_TF_WORK_DIR`; none may appear under the certified bundle. The generated
Cloud Build workflow follows the same boundary: operator tfvars arrive through
`_TFVARS_URI`, Terraform state uses the explicit bucket/prefix, and planning
runs under `/workspace/tf-work`.

## Custom MCP: console-first

After deployment:

1. Confirm `/healthz` is reachable and `/mcp` enforces the selected auth mode.
2. Allowlist the MCP, authorization, and token FQDNs required by organization
   policy, and grant the registering administrator
   `roles/discoveryengine.editor`.
3. Create the OAuth client at the chosen resource-server IdP, if applicable.
4. In the GE app, go to **Data stores → Create data store → Custom MCP Server**.
   Paste the fields printed by `anvil target`, create the data store, and finish
   the interactive OAuth authorization.
5. Load and enable only the intended actions; keep the enabled set at or below
   the 100-action platform budget.

The generated `registration.request.template.json` and
`registration.curl.sh` are experimental API references, not the normal
journey. The script requires
`ANVIL_EXPERIMENTAL_SETUP_DATA_CONNECTOR=1`, reads secrets only from runtime
environment variables or mounted `*_FILE` values, renders a mode-0600 temporary
request, reports only an allowlisted response summary, and deletes temporary
request and response bodies on exit. The raw API cannot complete interactive
OAuth consent.

## Agent Gateway: readiness, reconcile, bind, rollback

Generate this surface with the exact agent identity, attached authorization
policy, regional locations, and explicit egress acknowledgement:

```bash
anvil target gemini-enterprise <bundle> \
  --surface agent-gateway \
  --server-auth oauth \
  --endpoint https://mcp.example.com/mcp \
  --project acme-prod \
  --project-number 123456789012 \
  --location global \
  --engine support-app \
  --gateway-location us-central1 \
  --registry-location global \
  --agent-identity-principal-set principalSet://... \
  --gateway-authorization-policy projects/.../locations/global/authzPolicies/... \
  --idp entra \
  --tenant <entra-tenant-id> \
  --oauth-scope api://anvil-mcp/mcp.invoke \
  --inbound-issuer https://login.microsoftonline.com/<entra-tenant-id>/v2.0 \
  --inbound-audience api://anvil-mcp \
  --confirm-engine-egress-reroute
```

The generated `toolspec.json` is derived from the same approved AIR operations
as `tools/list` and must remain at or below 10 KB. `agent-registry.tf` owns
project IAM only; `register.sh` is the sole owner of the registry service and
its TOOL_SPEC.

Use an existing absolute state directory outside the bundle:

```bash
export ANVIL_STATE_DIR=/absolute/operator/state
```

The script then has three deliberately separate phases:

1. **Create the readiness record, with no provider read or mutation.**

   ```bash
   ANVIL_RECONCILE_REGISTRY_GATEWAY=1 \
   ANVIL_CONFIRM_REGISTRY_GATEWAY_RECONCILE=1 \
     bash <bundle>/targets/gemini-enterprise/agent-registry/register.sh
   ```

   On the first run, the script copies `readiness.template.json` to
   `$ANVIL_STATE_DIR/gemini-enterprise/<engine-key>/readiness.json` and stops.

2. **Verify readiness, then reconcile registry and gateway only.** Independently
   confirm the named authorization policy, `roles/agentregistry.viewer`,
   `roles/iap.egressor`, per-service `roles/run.invoker`, Discovery Engine
   service-agent access, and MCP endpoint readiness. Set the corresponding
   checks to `true` and record `verifiedAt`, then rerun the same reconciliation
   command. It performs ownership and engine concurrency preflights,
   creates/updates only resources owned by this kit, verifies exact readback,
   and exits without binding the engine.

3. **Bind the engine as a separate mutation.**

   ```bash
   ANVIL_CONFIRM_ENGINE_EGRESS_REROUTE=1 \
     bash <bundle>/targets/gemini-enterprise/agent-registry/register.sh
   ```

   The bind repeats the read-only preflights, requires exact registry/gateway
   state, uses the engine etag as a concurrency precondition, captures the exact
   previous egress-gateway setting outside the bundle, patches the engine, and
   verifies readback. Binding changes all agent egress for that engine.

If the engine already points at the target gateway and no verified pre-bind
snapshot exists, the script refuses to invent rollback evidence. Import a
verified snapshot or make the separate
`ANVIL_ACKNOWLEDGE_NO_ROLLBACK=1` acknowledgement after review.

To restore the captured setting:

```bash
ANVIL_CONFIRM_ENGINE_EGRESS_ROLLBACK=1 \
  bash <bundle>/targets/gemini-enterprise/agent-registry/rollback.sh
```

Rollback first proves that the live engine still points at this kit's gateway,
uses the live etag, restores the recorded prior value, and verifies readback.
It refuses to overwrite a route changed by another actor.

Finally, import the registered MCP server in the GE app through **Connected data
stores → New data store → MCP servers → Show all → Add tool**.

## Current platform references

- [Set up a custom MCP server data store](https://docs.cloud.google.com/gemini/enterprise/docs/connectors/custom-mcp-server/set-up-custom-mcp-server)
- [Register MCP servers in Agent Registry](https://docs.cloud.google.com/agent-registry/register-mcp-servers)
- [Manage MCP servers and tools](https://docs.cloud.google.com/agent-registry/manage-mcp-tools)
- [Gemini Enterprise Engine REST resource](https://docs.cloud.google.com/gemini/enterprise/docs/reference/rest/v1alpha/projects.locations.collections.engines)
