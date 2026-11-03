# Reusable identity adapters

Anvil binds one reviewed identity profile to multiple connectors. Authentication verifies the inbound credential; mapping creates a tenant-scoped principal; authorization checks the exact AIR service and operation; downstream credentials remain separate. Existing approval, confirmation, idempotency and egress gates still apply.

## Generate and deploy

```sh
anvil schema identity --out ./identity-profile.schema.json
anvil target identity ./generated/payments --profile ./identity.json
```

The command validates the profile and local operation references before atomically writing `targets/identity/`. It emits the normalized profile, its SHA-256 binding, environment configuration and a Terraform variable fragment. It never changes AIR or approves operations. Regenerate target inputs and certify after changes. A shared profile may contain bindings for several services; each generated kit validates the bindings for its own service.

On Cloud Run merge `terraform.tfvars.json` into existing deployment variables, retaining unrelated environment settings. `ANVIL_IDENTITY_PROFILE_JSON` contains non-secret JSON and works with the existing Terraform `env` map. For a mounted configuration file or local server use `ANVIL_IDENTITY_PROFILE=/absolute/path/profile.json`. Exactly one source is allowed. Remove `ANVIL_INBOUND_*` and `ANVIL_PRINCIPALS` settings: competing authentication or mapping authorities fail boot. Profiles load at process startup; restart/redeploy to apply changes. Include the deployment configuration in release review.

See `examples/identity/` for OIDC, Google service-account, IAP and SiteMinder bridge profiles. Replace example coordinates and operation IDs with inspected values before generating a kit. Tokens, private keys and client secrets do not belong in profiles.

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
| End-user OAuth behind Cloud Run IAM | `Authorization: Bearer <access token>` | OIDC profile; use a separate Cloud Run ID token in `X-Serverless-Authorization` when the client supports both |
| Google service-account caller | Google-signed ID token in `Authorization` | Exact service audience and numeric subject allowlist; this is machine identity, not an end user |
| IAP-protected internal endpoint | `x-goog-iap-jwt-assertion` | Fixed IAP issuer/keys and exact backend audience |
| Policy service on Cloud Run | ADC-minted ID token to the policy service | `createGoogleIdentityAuthorizer`; grant the calling workload `roles/run.invoker` on that service |
| Outbound Google API | Existing workload-identity credential resolver | Attached Cloud Run service account or Workload Identity Federation for GKE; least-privilege IAM |

Anvil does not use `X-Serverless-Authorization` as an application identity. Cloud Run may strip its signature before forwarding it. When the client cannot supply both platform and user credentials, choose an ingress arrangement compatible with end-user OAuth instead of substituting the workload identity for the person.

IAP assertions use IAP keys and backend audiences, not Google's ordinary OIDC JWKS. Plain identity headers are ignored. An IAP assertion cannot become an RFC 8693 subject token. The IAP mode does not advertise IAP as an OAuth authorization server: it is for IAP-aware internal clients, not a substitute for Gemini Enterprise's OAuth connector flow. Gemini Enterprise custom MCP connectors should use the OIDC profile and their supported OAuth client setup.

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

Tests cover real JWT signatures, IAP audience/type failures, separate Cloud Run headers, identity isolation, deny precedence, unknown operations, no anonymous fallback, input constraints, confirmation, denied-call zero side effects, non-delegable assertions, adapter failures, response bounds and profile reuse. Live Google IAM, Gemini OAuth consent, private-network routing and SiteMinder session/policy interoperability require customer-environment qualification. Generated binding metadata deliberately records `verifiedLive: false`.

References: [Cloud Run service authentication](https://docs.cloud.google.com/run/docs/authenticating/service-to-service), [IAP signed headers](https://docs.cloud.google.com/iap/docs/signed-headers-howto), [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).
