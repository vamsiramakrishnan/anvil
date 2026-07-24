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

**WSO2, MuleSoft, IBM API Connect, and Apigee** follow the same adapter output
shape and reuse a shared `synth.ts` helper
(`synthesizeOpenApiFromOperations` + `buildGatewayApiImport`), so no adapter
re-implements spec synthesis, source binding, or overlay assembly:

- **WSO2** directly accepts a native `apictl export apis` directory containing
  per-API ZIPs, one native per-API ZIP, an extracted per-API project, or
  standalone `api.yaml`. Projects are never flattened into invented aggregate
  YAML. The adapter maps API operations/scopes/security scheme and throttling;
  CAR files, sequences, mediation, and operation-policy implementations remain
  content-addressed but opaque. `Definitions/swagger.yaml` is recorded as
  formal-definition evidence; a production import still selects the real
  contract explicitly through `--spec`. Semantic API version and WSO2
  control-plane revision are distinct selectors (`--api-version 1.0.0` versus
  `--revision working-copy|revision-N`) and both enter stable import identity.
- **MuleSoft** accepts Anvil's normalized asset/resources/policies document;
  native application XML/DataWeave inside a deployable JAR is not decoded.
  DataWeave and flow logic are classified **opaque**.
- **IBM API Connect** accepts Anvil's normalized products/plans/assembly
  document; native assembly packages are not decoded. Rate limits and OAuth
  providers are mapped, while `map`/`gatewayscript`/`xslt` actions remain
  **opaque**.
- **Apigee** accepts Anvil's normalized
  proxy/revision/environment/product document; native `apiproxy/*.xml` bundles
  are not decoded. Product scopes, `Quota`, and `SpikeArrest` are mapped;
  `AssignMessage`/`JavaScript` remain **opaque**.

Every diagnostic is owned when the source provides a boundary:
API/version/revision/environment, content-addressed artifact, and optionally
route.
Subjectless means genuinely estate-global. Selection-aware import applies only
global diagnostics plus diagnostics whose API and artifact constraints match
the selected coordinate. Audit retains artifact-only failures and folds
API-owned findings into only the matching API disposition.

A **cross-vendor differential** proves the abstraction is not vendor-shaped: the
same logical API (POST /refunds requiring `refunds:write`) expressed in each
vendor's format yields the *same* effective auth scope on the same operation
through `compileContract`.

## Consequences
- Kong, WSO2, MuleSoft, IBM API Connect, and Apigee estates all compile into
  certified agent capabilities via the one pipeline; **no vendor type escapes** its
  adapter package, and all five share one source-synthesis + overlay path.
- A malformed or duplicate WSO2 project remains visible in whole-estate audit
  without poisoning an unrelated selected project. Unsafe traversal or a
  failure that prevents any safe project boundary remains global and fails
  closed.
- Transformation and unknown-policy honesty (opaque + evidenced, never dropped) is
  enforced uniformly, and each adapter passes `gatewayAdapterConformance`.
- **Deferred:** per-vendor depth — Kong consumers/credentials/workspaces, WSO2
  CAR/mediation/sequence semantics, native MuleSoft application decoding and
  Exchange client apps, native API Connect assembly/space/catalog decoding,
  native Apigee proxy/shared-flow/target-server decoding, and live management
  APIs. The offline path remains deliberate.
