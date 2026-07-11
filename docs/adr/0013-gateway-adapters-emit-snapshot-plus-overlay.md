# ADR-0013 — Gateway adapters emit a snapshot plus an overlay

**Status:** Accepted

## Context
Anvil must compile enterprise gateway estates — Kong, WSO2, Apigee, MuleSoft, IBM
API Connect — into the same certified agent capabilities it produces from an
OpenAPI file. The wrong design is a compiler per vendor: a "Kong compiler", an
"Apigee compiler", each re-deriving effects, idempotency, auth, and capability
grouping in vendor-shaped ways. That duplicates the safety core five times and
lets vendor concepts leak into the canonical model.

The gateway is an **input** (and usually the upstream enforcement point), not a
separate compiler. So the estate must feed the *one* compiler path established by
ADR-0001 (SourceSnapshot as the only compiler input) and ADR-0012 (contract
snapshots and semantic overlays).

## Decision
Introduce a gateway-neutral vocabulary (`@anvil/compiler/gateway`) that every
adapter normalizes into. A `GatewayAdapter` reads a gateway (offline export or
read-only management API) and emits exactly one thing per API:

```
GatewayApiImport { source: CompilerSource; overlay: GatewayPolicyOverlay }
```

- **`source`** is the immutable, content-addressed spec the one compiler path
  consumes — identical in kind to a snapshot imported from a file.
- **`overlay`** is a `PolicyOverlay` with `origin: "gateway"` (ADR-0012). Its
  assertions are the gateway's control-plane facts (required scopes, auth
  posture, confirmation gates, quotas-as-findings, …), and **every assertion
  cites an `EvidenceCoordinate`** back to the export member or management response
  that justified it. The overlay builder enforces this structurally: an assertion
  cannot be added without a coordinate.

Adapters **never return AIR**. Composition happens only through
`compileContract(source, [overlay])`.

Supporting pieces:

- **`GatewayInventorySnapshot`** — a cheap, content-addressed picture of the
  estate (environments, APIs, routes, products, lifecycle, auth summary, quota
  presence, traffic summary) so a large estate can be assessed without compiling
  every API.
- **`GatewayAdapterCapabilities`** — a declared matrix (`inventory`, `routes`,
  `authentication`, `transformations: none|partial|full`, `drift`, `publish`, …).
  Partial support stays visible; a `false`/`"partial"` is a rendered row, never
  hidden.
- **`gatewayAdapterConformance(fixture, adapter)`** — the executable contract every
  adapter must pass, returning findings as data: deterministic inventory/source/
  overlay; every assertion evidenced; secrets never persisted; the emitted source
  + overlay feed the compiler; auth never weakened by a gateway overlay; a
  read-only adapter never advertises publish.
- A **fake fixture adapter** proves the whole pipeline in-repo with no vendor code.

Publication (mutating a customer gateway) is explicitly **out of scope** here and
will be a separate `GatewayPublisher` with a desired-state → diff → approval →
apply lifecycle. `anvil build` never mutates a gateway.

## Consequences
- One safety core, one capability compiler; vendor adapters are thin normalizers
  whose value is measurable against the same pipeline.
- No vendor-specific type crosses the adapter boundary — enforced by the
  `GatewayApiImport` shape and (later) an architecture test.
- Opaque vendor policy (a custom Lua/DataWeave transform) is surfaced as a
  diagnostic that blocks automatic certification rather than being silently
  dropped — the honesty invariant for "we don't understand this".
- **Deferred:** the offline archive/decoding harness (zip-slip defence, XML/YAML
  decoding, byte-preserving evidence) and the first real vendor adapters (Kong
  first) build on this foundation; runtime-coordinate replacement and
  transformation resolvers in the contract resolver land alongside them.
