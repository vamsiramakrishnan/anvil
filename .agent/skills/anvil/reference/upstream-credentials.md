---
name: anvil-upstream-credentials
description: Configure the runtime's outbound authentication to the upstream API, including static Secret Manager references and delegated OAuth token acquisition.
---

# Upstream (outbound) credentials

Do not confuse inbound identity at `/mcp` with outbound authentication from the
runtime to the API it fronts. Outbound resolution is selected per operation, so
one bundle may mix API keys, service-principal OAuth, and delegated user context.

## Resolution

- Static `api_key`, `basic`, and pre-issued bearer values use the
  `ANVIL_<PROFILE>_*` convention. The default static resolver automatically
  dereferences `sm://` or full Secret Manager resource names at call time;
  literals still pass through for development.
- `oauth2_client_credentials`, RFC 8693 on-behalf-of, RFC 7523 JWT bearer, and
  workload identity acquire tokens through the delegated resolver. On-behalf-of
  requires the validated inbound caller token and fails closed when it is absent.
- `ANVIL_CREDENTIALS=env|secret_manager` changes storage only for static
  values. It does not override OAuth grant routing. Unsupported backends and an
  unregistered `vault` source fail closed.

Secret references may be
`sm://projects/P/secrets/S/versions/V`, bare
`projects/P/secrets/S/versions/V`, or `sm://<secret>` with
`ANVIL_SECRET_PROJECT`. The runtime caches resolved `latest` values briefly so
rotation does not require a redeploy.

## Gateway mapping

- Apigee and Kong API-key products use the AIR carrier or
  `_API_KEY_HEADER`/`_API_KEY_QUERY`; OAuth products use client credentials.
- WSO2 OAuth products use `_TOKEN_ENDPOINT`, `_CLIENT_ID`, and
  `_CLIENT_SECRET`; use token exchange only when downstream user context is
  required.
- IBM API Connect client-id/client-secret headers and Azure APIM subscription
  keys should be modeled explicitly as API-key carriers.

Do not claim an auth mechanism is supported unless the runtime has a transport
implementation for it. Upstream endpoint allowlisting is being hardened: keep
`ANVIL_ALLOWED_HOSTS` pinned to reviewed gateway hosts and re-check generated
deployment guidance rather than assuming provider endpoints were discovered.

```bash
anvil deploy credentials <dir> --env prod --project <PROJECT_ID>
```

That command prints required variable names and Secret Manager provisioning
steps; it never needs secret values. Resolver failures become `auth_required`
with names only, and credentials are not written to execution records.

## Delegated proof boundary

`anvil selftest` and hermetic `anvil conformance` exercise the complete local
bridge: a synthetic already-validated subject token is exchanged at the
generated mock STS and the exchanged bearer must reach the mock upstream. Their
reports label this proof `virtual_wiring_only` and keep live IdP readiness
`unverified`.

The only readiness upgrade is an explicitly opted-in delegated **read** through
`anvil conformance <bundle> --live <config.json>`. Before any tool is called,
the endpoint's `/healthz` attestation must match the SHA-256 of the exact local
`deploy/runtime` payload; matching tool names are not proof that the intended
artifact was deployed.

Anvil groups delegated operations by their effective identity and credential
contract (issuer, audience, carrier, scopes, tenant/delegation, credential
profile, and non-secret token-exchange settings). It marks
`verified_for_opted_in_reads` only after at least one approved read in **every**
distinct group succeeds through real inbound JWT validation, live STS exchange,
and the real upstream. A write-only group therefore remains unverified: live
conformance never drives a mutation merely to manufacture proof. OIDC discovery,
JWKS reachability, tool listing, and `/readyz` are useful diagnostics but are
never accepted as IdP/OBO readiness proof. Any unattested artifact or uncovered
group makes the separate `identity-live` gate fail and live conformance exit
nonzero.
