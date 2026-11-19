# Reusable identity adapters

Anvil binds one reviewed identity profile to multiple connectors. Authentication verifies the inbound credential; mapping creates a tenant-scoped principal; authorization checks the exact AIR service and operation; downstream credentials remain separate. Existing approval, confirmation, idempotency and egress gates still apply.

## Generate and deploy

```sh
anvil schema identity --out ./identity-profile.schema.json
anvil target identity ./generated/payments --profile ./identity.json
```

The command validates the profile and local operation references before atomically writing `targets/identity/`. It emits the normalized profile, its SHA-256 binding, environment configuration and a Terraform variable fragment. It never changes AIR or approves operations. Regenerate target inputs and certify after changes. A shared profile may contain bindings for several services; each generated kit validates the bindings for its own service.

On Cloud Run merge `terraform.tfvars.json` into existing deployment variables, retaining unrelated environment settings. `ANVIL_IDENTITY_PROFILE_JSON` contains non-secret JSON and works with the existing Terraform `env` map. For a mounted configuration file or local server use `ANVIL_IDENTITY_PROFILE=/absolute/path/profile.json`. Exactly one source is allowed. Remove `ANVIL_INBOUND_*` and `ANVIL_PRINCIPALS` settings: competing authentication or mapping authorities fail boot. Profiles load at process startup; restart/redeploy to apply changes. Include the deployment configuration in release review.

See `examples/identity/` for OIDC, Google service-account, IAP, SiteMinder OIDC, SiteMinder introspection and signed-bridge profiles. Replace example coordinates and operation IDs with inspected values before generating a kit. Tokens, private keys and client secrets do not belong in profiles. Introspection profiles name environment variables; supply their values through deployment secrets, for example Cloud Run Secret Manager environment bindings.

## Bind the Gemini Enterprise deployment

Pass the same reviewed profile to the Gemini Enterprise target so connector
registration and runtime authentication cannot diverge. First replace every
example coordinate below and set `authentication.resource` in `identity.json`
to the exact MCP endpoint; its audience must match the actual access-token
resource, which can differ from that endpoint.

```sh
anvil target gemini-enterprise ./generated/payments \
  --surface custom-mcp --server-auth oauth --idp other \
  --identity-profile ./identity.json \
  --endpoint https://CONNECTOR-REGION.run.app/mcp \
  --oauth-authorization-url https://siteminder.example.com/REVIEWED_AUTHORIZATION_URL \
  --oauth-token-url https://siteminder.example.com/REVIEWED_TOKEN_URL \
  --oauth-scope mcp.invoke \
  --project YOUR_PROJECT_ID --project-number YOUR_PROJECT_NUMBER \
  --location global --engine YOUR_ENGINE_ID
```

`--idp other` selects SiteMinder's explicitly supplied connector OAuth URLs;
it does not replace Entra sign-in. The profile supplies the inbound issuer and
audience unless explicitly repeated, in which case they must agree. The target
also checks the public resource, requested scopes, local operation bindings and
user-token provider mode before writing. IAP and service-account profiles cannot
stand in for this employee OAuth grant.

The generated Gemini deployment embeds the normalized profile and emits
`ANVIL_IDENTITY_PROFILE_JSON` instead of competing `ANVIL_INBOUND_*` settings.
For the default Cloud Run `.run.app` path, the reviewed numeric project identity
binds the Gemini service agent's `roles/run.invoker` grant; the deployment keeps
IAM invocation authenticated. A custom domain requires an explicitly compatible
ingress arrangement because Gemini's automatic platform token does not apply.
No target-generation command creates a SiteMinder OAuth client or completes
interactive account linking.

When both identity and Gemini target kits exist, `anvil target identity` and the
console's identity apply action regenerate them together from one profile,
preserving the reviewed OAuth URLs, scopes and GCP coordinates. A validation or
installation failure preserves the previous kits. Status and certification
refuse mismatched profiles or old Gemini targets that still emit a competing
authentication configuration. Profile edits require certification and deployment
review again; generated configuration remains `verifiedLive: false`.

## Independent sign-in and connector authorities

The identity profile describes the MCP connector's authority. It does not configure the employee's Gemini Enterprise sign-in provider. Entra ID can authenticate employees to Gemini Enterprise while SiteMinder independently authorizes the protected-system connector. Matching employee emails do not make their tokens interchangeable.

Configure Gemini Enterprise's Custom MCP Server OAuth authorization URL, token URL, client ID, client secret and scopes for the SiteMinder application registration. Register the platform callback `https://vertexaisearch.cloud.google.com/oauth-redirect` there. The MCP resource's issuer, audience and scopes must agree with the identity profile. Entra tokens remain invalid at a SiteMinder-bound connector. Existing corporate SSO may avoid another credential prompt during connector authorization; account linking and step-up policy still belong to the configured identity service.

| Boundary | Credential | Enforcement |
| --- | --- | --- |
| Employee → Gemini Enterprise | Entra sign-in assertion/session | Gemini's configured sign-in provider |
| Gemini Enterprise → MCP | SiteMinder-issued OAuth access token | Anvil's configured JWT verifier or introspection client |
| Gemini Enterprise → Cloud Run IAM | Google service-agent ID token | Cloud Run IAM; never mapped to the employee |
| Anvil → protected-system API | Credential accepted by that API | The upstream credential resolver and application/gateway policy |

The upstream API can accept a distinct employee bearer obtained through a supported RFC 8693 grant, or a separate per-user authorization-code grant. Use the code grant when the authorization server offers OAuth authorization and refresh but does not support exchange. A cookie-only API can sit behind a customer-managed session broker. In each case, verify object-level permissions at the receiving resource.

## Link a downstream OAuth account

A standalone HTTP MCP server can resolve a reviewed API or broker bearer for each employee. The employee authorizes the downstream client once from a customer portal. Later `tools/call` requests use that employee’s linked account after Anvil authorizes the effective operation and input.

```text
Employee -- sign-in --> Gemini Enterprise
                             |
                  Google service-agent ID token --> Cloud Run IAM
                  employee MCP access token ------> Anvil
                                                     |
Employee -- portal --> /connect/start                | verified owner
              |            |                         v
              |       OAuth code + PKCE       Encrypted grant vault
              +------ /connect/callback              |
                                                     v
                                            API or broker bearer
                                                     |
                                            Protected resource
```

Add `--enterprise-oauth-binding ./downstream-oauth.json` to the `anvil target gemini-enterprise` command above. Supply the reviewed `--identity-profile` and use the Custom MCP surface with OAuth. Start from `examples/identity/per-user-downstream-oauth.json` and replace every sample coordinate with the actual service, approved operation IDs and endpoints. A companion `examples/identity/per-user-payments.yaml` manifest models the payment read for use with `examples/payments/openapi.yaml`. Compile it, inspect the read and approve `payments.payments.get` before generating the target. The target validates the binding against the generated bundle. The runtime checks it again against the deployed upstream URL. The dedicated bundle uses `oauth2_authorization_code`, `principal: end_user` and `secretSource: vault` for its approved HTTP operations. Supply the named OAuth client credentials through secret bindings. The generated `ANVIL_ENTERPRISE_OAUTH_JSON` contains only configuration.

| Resource | Who obtains its user credential | Enforcement |
| --- | --- | --- |
| MCP | Gemini Enterprise, through its registered connector OAuth client | Anvil verifies the employee and applies service, operation and input policy. |
| Account management | The customer portal obtains a token for `https://PORTAL_HOST/connect` with scope `anvil.connect` | `/connect/start`, `/connect/status` and `/connect/disconnect` verify the control audience and employee identity. The portal protects its own browser session and enforces CSRF checks. |
| API or broker | Anvil exchanges the employee’s authorization code and PKCE verifier at the reviewed token endpoint | Anvil introspects each newly issued or refreshed bearer. It requires a matching issuer, stable user subject, tenant, exact client and resource audience, configured scopes and live expiry. The API or broker enforces its own object permissions. |

All three registrations must support the reviewed identity mapping. This release supports one identity authority that supplies the same stable subject and tenant at the relevant resources. Compare actual user tokens from each client when the IdP uses pairwise subject identifiers. The downstream and control resources require explicit audiences. The downstream authorization server must support the configured resource parameter, RFC 7662 introspection and confidential client Basic authentication. The token and optional revocation endpoints must be reachable over public-address HTTPS from the runtime. The protected API or broker can use private network routing.

**Portal integration.** Route only `/connect/*` from the customer portal’s external origin to the private Anvil service. For Cloud Run, the portal backend needs its own service-scoped `roles/run.invoker` and sends its Google ID token in `X-Serverless-Authorization`. For account-management requests it sends the employee’s control access token in `Authorization`, preserves the browser `Origin` on POST and forwards the callback-binding cookie. Register the downstream client’s exact `https://PORTAL_HOST/connect/callback`. This is separate from the Gemini client callback. Reserve the `/connect` routes on that host. Suppress query strings and credential headers in portal, ingress and application logs.

| Portal route | Behavior |
| --- | --- |
| `POST /connect/start` | Returns an authorization URL and expiry and sets a Secure, HttpOnly, SameSite=Lax cookie. The portal sends the employee’s browser to the returned URL. A new start replaces that person’s pending link. |
| `GET /connect/callback` | Verifies one-time state and the initiating browser cookie, exchanges the code, verifies the downstream employee and stores the grant. Single-use enrollment state lives in the shared encrypted vault. |
| `GET /connect/status` | Returns the connection state for the authenticated owner. |
| `POST /connect/disconnect` | Removes local authority. Configure `revocationEndpoint` when the issuer supports RFC 7009. Retry remote revocation through the same endpoint while local use stays denied. |

For generated Cloud Run Terraform, supply the OAuth client environment variables through `secret_env_refs`. Each value has a `secret` resource name (`projects/PROJECT/secrets/SECRET`) and a pinned numeric `version` string. Use `ANVIL_VAULT_BACKEND=firestore` and `ANVIL_VAULT_KMS_KEY` outside development. Choose a dedicated vault collection and key for each deployment trust boundary. The file vault supports single-process development. Per-owner locking and revision checks fence refresh, link completion and disconnect across replicas. An invalid refresh grant requires reconnection. Disconnect old grants before changing client, issuer, resource, requested scopes or other vault namespace coordinates. Ordinary authorization rule edits preserve the stored grant and take effect at the next policy evaluation. Temporary authority or vault failures stop dispatch. Revoking a connector token, deleting the downstream grant, and invalidating a legacy session are distinct events. Measure propagation at each boundary, including requests already in flight. [Vault and IAM setup](branchyard.md#vault-backends).

### Customer-hosted broker for one cookie-protected read

```text
Anvil -- broker-audience employee token --> customer broker
                                                | validate token and object access
                                                | select the employee's live session
                                                v
                                         SiteMinder gateway / API
                                           Cookie: SMSESSION=...
```

For a legacy API, point the binding’s `upstreamBaseUrl` and `resource` at the customer’s broker. `createLegacySessionReadHandler` from `@anvil/legacy-bridge` supplies a customer-hosted Node HTTP handler for one reviewed `GET /prefix/{id}` route. Deploy it behind the customer's authenticated ingress. Configure the issuer, client, tenant, audience, scope, realm, cookie name, fixed upstream HTTPS path, ID field and output fields. It projects the matching record ID and declared numbers, booleans and enumerated strings. Redirects, login pages, unexpected response shapes and unbounded output fail closed. A downstream 401 requests reauthorization. Valid W3C trace context correlates dispatch and broker audit without logging the employee’s credentials.

| Customer adapter | Required evidence |
| --- | --- |
| `verifyEmployeeAccessToken(token, signal)` | Validates an active access token and its employee delegation. Returns verified identity, client, resource audience, scopes, expiry and a stable grant ID. Use the authority’s grant ID or an authoritative binding to the owner's enrollment. Token refresh must preserve that binding. |
| `authorizeRead(employee, objectId, signal)` | Checks current object ACLs using trusted data. A denial stops before session lookup and wire dispatch. |
| `resolveSession(employee, realm, signal)` | Checks current grant status, retrieves or renews the employee’s server-issued session, and returns its issuer, tenant, subject, grant, realm, expiry and opaque cookie value. The broker checks these coordinates against the incoming grant. |

The customer manages session enrollment, MFA, storage, rotation and revocation in its own security boundary. Use a supported SiteMinder server-side authentication or federation mechanism that proves the employee’s identity. The Anvil portal cookie binds the OAuth callback to its browser. The legacy session cookie is issued and retained on the customer side. Qualify idle and absolute expiry and any required response-driven cookie rotation for the exact SiteMinder release. The initial read handler discards upstream response headers. A deployment requiring in-band session replacement needs a reviewed adapter for that behavior before use.

## JWT and opaque OAuth access tokens

For signed SiteMinder access tokens use `provider: "oidc"` with the actual reviewed issuer, resource audience and JWKS URI; see `examples/identity/siteminder-oidc.json`. Do not substitute the Gemini/Entra login token or an OAuth client's ID token. `tokenType`, when configured, is checked exactly; choose it from the actual access-token contract.

For opaque tokens use `provider: "oauth2_introspection"`; see `examples/identity/siteminder-introspection.json`. The pinned HTTPS endpoint receives an RFC 7662 form POST with `token` and `token_type_hint=access_token`. Client authentication is `client_secret_basic` or explicitly configured `client_secret_post`. Both referenced environment variables must be present at boot. The generated profile contains their names, never their values. Introspection does not create the authorization server, register the OAuth client or implement a login page.

The response must contain `active: true`, the exact issuer, a nonempty subject, a future expiration and the required scopes. Its `token_type` must identify a bearer/access token. Expiration accepts a finite integer NumericDate or canonical integer string, normalized before identity mapping. Missing, malformed, expired and inactive responses fail closed. Redirects, timeout, excessive responses and failed client authentication also deny access. Successful introspection responses are not cached: every inbound MCP request checks the token's current activity before session dispatch.

`audienceSource: "response"` is the default: the returned `aud` must include the configured MCP audience. Some SiteMinder deployments omit `aud`. Only if the OAuth client is administratively dedicated to this exact MCP resource may a reviewed profile set `audienceSource: "dedicated_client"`. This requires a nonempty `requiredScopes` list and an exact returned `client_id` matching the configured connector client ID. A present wrong or malformed `aud` is still rejected. The profile records the dedicated-client assumption; it cannot prove exclusive client registration. Verify that assumption in the identity-service configuration before deployment. Do not reuse a broadly privileged OAuth client to bypass audience validation.

Introspection freshness is the authority's `active` result, not proof that every browser logout, employee disablement or policy update immediately invalidates every token. SiteMinder browser sessions and OAuth tokens can have independent lifetimes. Establish the actual revocation window and test the deployed behavior. JWT profiles use offline verification; enforce a shorter token lifetime or an online policy check when stronger revocation is required.

## Identity and policy semantics

The external identity key is `(issuer, tenant, subject)`, hashed for the audit principal ID. Email never links accounts. Tenant claims require an explicit allowlist; a fixed tenant represents an operator-reviewed issuer/deployment binding. Google service-account profiles also require a subject allowlist: a Google signature alone does not grant a Google identity access to your connector.

`mapping.upstreamScopes` grants local permission to use upstream API scopes. It is distinct from inbound OAuth scopes. `authentication.requiredScopes` applies to incoming tokens; rule `scopes` adds operation-specific inbound requirements. No wildcard scope is added automatically.

Rules bind exact `service` and immutable AIR operation IDs, not generated CLI or MCP names. Subject and group conditions are optional; omitting both intentionally allows any mapped principal matching the other conditions. Group conditions match any listed group; scopes must all match. Matching deny rules override matching allows. No matching allow means deny. Every invocation, including dry runs and ledger replays, is checked before credentials or upstream requests. A configured profile rejects callers without verified identity, including ordinary unauthenticated stdio/CLI calls.

Constraints support exact top-level input equality to the mapped tenant and numeric upper bounds. These constrain a request; they do not establish object ownership. Use a policy adapter with trusted resource lookup for ownership, account membership, relationship policy or richer ABAC. Missing or malformed constrained values do not match an allow rule. Confirmation is the only supported external obligation in v1; unknown obligations deny execution.

Policy adapters receive detached principal, operation and input values without bearer material. Adapters are boot-scoped extension contributions; duplicate names and replacement of the built-in `rules` adapter fail boot. Throws, timeouts, malformed decisions and unsupported obligations deny the call. Adapter responses are not cached. Built-in JWT verification caches keys; entitlements in a token remain valid until token expiry unless an online adapter checks revocation. Set token lifetimes to the required revocation window.

Semantic `transformInvocation` hooks run before authorization. Wire hooks cannot rewrite an identity-protected request afterward. This prevents a policy decision for one tenant from authorizing a rewritten request for another. Existing safety gates remain authoritative. The tool catalog currently lists the approved surface; authorization is enforced on each invocation, not by hiding tools.

## GCP deployment modes

| Mode | Application credential | Configuration |
| --- | --- | --- |
| End-user OAuth behind Cloud Run IAM | `Authorization: Bearer <access token>` | OIDC/JWT or introspection profile; the separate platform ID token uses `X-Serverless-Authorization` |
| Google service-account caller | Google-signed ID token in `Authorization` | Exact service audience and numeric subject allowlist; this is machine identity, not an end user |
| IAP-protected internal endpoint | `x-goog-iap-jwt-assertion` | Fixed IAP issuer/keys and exact backend audience |
| Policy service on Cloud Run | ADC-minted ID token to the policy service | `createGoogleIdentityAuthorizer`; grant the calling workload `roles/run.invoker` on that service |
| Outbound Google API | Existing workload-identity credential resolver | Attached Cloud Run service account or Workload Identity Federation for GKE; least-privilege IAM |

Gemini Enterprise sends its service-agent ID token in `X-Serverless-Authorization` and preserves the connector user token in `Authorization` for default `.run.app` Cloud Run URLs. Grant that service agent `roles/run.invoker` on the connector. The documented automatic platform token is not sent for a custom domain. Anvil never uses `X-Serverless-Authorization` as application identity; Cloud Run may strip its signature before forwarding it.

IAP assertions use IAP keys and backend audiences, not Google's ordinary OIDC JWKS. Plain identity headers are ignored. An IAP assertion cannot become an RFC 8693 subject token. The IAP mode does not advertise IAP as an OAuth authorization server: it is for IAP-aware internal clients, not a substitute for Gemini Enterprise's OAuth connector flow. Gemini Enterprise custom MCP connectors should use the JWT or introspection profile matching their supported OAuth client setup.

The Cloud Run policy adapter authenticates using `google-auth-library` ADC. It pins the endpoint and audience, rejects redirects, bounds response size and obeys the authorization deadline. Local ADC works where it can mint the required ID token (for example service-account impersonation); no key file is required. Grant IAM separately; profile generation does not provision permissions or Google resources.

## SiteMinder and custom policy services

Use `jwt_bridge` only when a reviewed bridge or issuer supplies signed, audience-bound JWTs. It uses the same JWT verifier as OIDC; it does not parse `SMSESSION`, accept untrusted `SM_USER` headers or invent a SiteMinder token endpoint. A legacy integration must validate SiteMinder sessions using the supported customer deployment and issue the reviewed assertion. The bridge is deployment-specific and must be qualified against the deployed SiteMinder version.

A customer-owned extension can supply any asynchronous authorizer:

```js
export default api => ({
  name: "enterprise-policy",
  identityAuthorizers: {
    enterprise: api.createGoogleIdentityAuthorizer({
      endpoint: "https://policy-service.run.app/decide",
    }),
  },
});
```

Set `authorization.adapter` to `enterprise` and load the extension through `ANVIL_EXTENSIONS`. The policy service receives version 1 JSON containing `principal`, `service`, `operation: { id, effect }`, `input`, `confirmed` and `traceId`. Its response is:

```json
{"allowed":true,"reason":"policy_allowed","policyVersion":"v42","obligations":[]}
```

`reason` and `policyVersion` are bounded identifiers suitable for audit, not free-form messages. To require confirmation return `obligations: [{"kind":"confirmation"}]`. All other obligation kinds fail closed. A non-Google policy service can use a custom extension implementing the same `IdentityAuthorizer` contract and its own reviewed authentication. Do not interpret an HTTP success alone as authorization.

## Qualification

The automated independent-authority test is `packages/mcp-runtime/src/connector-federation.test.ts`. It signs local JWTs and combines the actual verifier, per-request identity context, policy gate and executor. It checks that the SiteMinder profile rejects an Entra issuer even with a matching subject and a valid signature; two employees remain isolated; platform-only credentials do not admit a caller; and a denied resource request reaches neither upstream credential resolution nor transport. The opaque-token case checks activity on every invocation and rejects a token after revocation. Policy decisions, introspection responses and downstream credentials are explicit local fixtures, not a claim of live SiteMinder or protected-system interoperability.

Before declaring a customer deployment qualified, collect the following evidence against one exact bundle/profile digest:

| Test | Required evidence |
| --- | --- |
| Connector authorization | Actual Gemini Enterprise account-linking flow completes against SiteMinder while Entra remains the Gemini sign-in provider; no browser-cookie copying |
| Token contract | Actual issuer, audience or reviewed dedicated-client binding, token type, signing keys/introspection endpoint, scopes, subject and group claim shapes match the profile |
| Two employees | Separate tool calls retain the right subject and upstream credential; replay/session reuse never changes the caller |
| Policy matrix | Allowed read, denied write, confirmation and cross-employee access match reviewed SiteMinder/application policy; every denial has zero upstream effects |
| Downstream authority | Actual protected-system API accepts the intended per-user credential; a workload identity or user-supplied employee number cannot substitute for it |
| Revocation | Logout, disablement and group removal are measured with an open MCP session, including access-token and refresh-token lifetimes |
| Failure and rotation | Unknown/rotated keys, inactive tokens, wrong client/issuer/audience, policy timeout and unavailable identity service all fail closed |
| GCP boundaries | Service-agent IAM authentication, user OAuth token, ingress and upstream private routing work through the actual Gemini Enterprise client |
| Audit | Correlated trace, mapped principal, operation and policy version appear without tokens, cookies or client secrets |

The prerequisites are a non-production SiteMinder issuer/Access Gateway with the exact deployed version and token/client settings, two test employees with distinct permissions, reviewed operation/resource mappings, a sandbox protected-system API and its supported credential mechanism, and the target Gemini Enterprise/Cloud Run network configuration. Run one identity profile across two generated connectors to prove reuse. Record expected and observed outcomes; a mock-only pass must remain `verifiedLive: false`.

Tests cover real JWT signatures, IAP audience/type failures, separate Cloud Run headers, identity isolation, deny precedence, unknown operations, no anonymous fallback, input constraints, confirmation, denied-call zero side effects, non-delegable assertions, adapter failures, response bounds and profile reuse. Live Google IAM, Gemini OAuth consent, private-network routing and SiteMinder session/policy interoperability require customer-environment qualification. Generated binding metadata deliberately records `verifiedLive: false`.

References: [Cloud Run service authentication](https://docs.cloud.google.com/run/docs/authenticating/service-to-service), [IAP signed headers](https://docs.cloud.google.com/iap/docs/signed-headers-howto), [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization), [Gemini Enterprise custom MCP authentication](https://docs.cloud.google.com/gemini/enterprise/docs/connectors/custom-mcp-server/set-up-custom-mcp-server), [SiteMinder token introspection](https://knowledge.broadcom.com/external/article/235049), [SiteMinder session and OAuth lifetimes](https://knowledge.broadcom.com/external/article/258115/will-siteminder-keep-both-smsession-co.html).
