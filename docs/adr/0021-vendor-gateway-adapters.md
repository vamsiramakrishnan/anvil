# ADR-0021 — Vendor gateway adapters (Kong first)

**Status:** Accepted

## Context
With the gateway-neutral kernel (ADR-0013) and the offline archive harness
(ADR-0020) in place, real vendor adapters can land. The risk is that each vendor's
adapter grows its own compiler and its concepts leak into the core. The kernel
forbids that: an adapter emits only `GatewayInventorySnapshot` and
`GatewayApiImport { source, overlay }`.

## Decision
Implement adapters in increasing semantic complexity, one per vendor, each a thin
normalizer over its export format. **Kong** is first — its declarative
(`deck`) config is the most direct.

The Kong adapter (`gateway/kong`):
- parses the declarative config (YAML or JSON) as data, never a throw;
- **synthesizes an OpenAPI source** from each service's routes (paths × methods →
  operations with stable ids) — Kong declares routes, not a formal contract, so
  the adapter builds the minimal spec the compiler needs;
- **normalizes plugins** into evidence-backed overlay facts and diagnostics:
  auth plugins (`key-auth`, `jwt`, `openid-connect`, …) → an auth summary and, for
  OIDC, an `auth.scopes` restriction per operation; rate-limiting → a quota
  diagnostic + `hasQuota`; request/response transformers → an **opaque-policy**
  finding that blocks automatic certification; and **any unrecognized plugin stays
  visible as an opaque policy**, cited by coordinate, never silently dropped;
- emits `GatewayApiImport { source, overlay }` that feeds `compileContract`
  unchanged, and passes `gatewayAdapterConformance`.

A **differential fixture** proves the abstraction is not Kong-shaped: the same
logical API expressed differently (YAML vs JSON, reordered plugins) yields the
same effective auth scope on the same operation.

Later vendor adapters (WSO2, Apigee, MuleSoft, IBM API Connect) follow the same
shape and reuse the shared source-synthesis helper; each lands with its own
differential fixture asserting equivalent policies produce equivalent effective
contracts.

## Consequences
- A real gateway estate (Kong) now compiles into certified agent capabilities via
  the one pipeline; no Kong type escapes the adapter package.
- Transformation and unknown-plugin honesty (opaque + evidenced) is enforced.
- **Deferred:** Kong consumers/credentials and workspace scoping beyond the auth
  summary; live Kong Admin API (the offline path is proven first).
