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

**WSO2, MuleSoft, IBM API Connect, and Apigee** follow the same shape and reuse a
shared `synth.ts` helper (`synthesizeOpenApiFromOperations` +
`buildGatewayApiImport`), so no adapter re-implements spec synthesis, source
binding, or overlay assembly:
- **WSO2** — API definition operations/scopes/security scheme; throttling → quota;
  mediation → opaque.
- **MuleSoft** — asset resources/scopes; auth/SLA policies; DataWeave and flow
  logic classified **opaque** (never claimed as understood).
- **IBM API Connect** — products/plans (rate limits → quota), OAuth providers, and
  `map`/`gatewayscript`/`xslt` assembly actions classified **opaque**.
- **Apigee** — proxies/revisions/environments; product scopes → `auth.scopes`;
  `Quota`/`SpikeArrest` noted; `AssignMessage`/`JavaScript` classified **opaque**.

A **cross-vendor differential** proves the abstraction is not vendor-shaped: the
same logical API (POST /refunds requiring `refunds:write`) expressed in each
vendor's format yields the *same* effective auth scope on the same operation
through `compileContract`.

## Consequences
- Kong, WSO2, MuleSoft, IBM API Connect, and Apigee estates all compile into
  certified agent capabilities via the one pipeline; **no vendor type escapes** its
  adapter package, and all five share one source-synthesis + overlay path.
- Transformation and unknown-policy honesty (opaque + evidenced, never dropped) is
  enforced uniformly, and each adapter passes `gatewayAdapterConformance`.
- **Deferred:** per-vendor depth — Kong consumers/credentials/workspaces, WSO2
  mediation sequences, MuleSoft Exchange metadata + client apps, API Connect
  spaces/catalogs, Apigee shared flows and target servers; live management APIs
  (the offline path is proven first for every vendor).
