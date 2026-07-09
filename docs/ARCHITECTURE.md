# Anvil architecture

Anvil is a **spec-to-agent-tool foundry**. It has two loops and one canonical
model. For *where the product boundary sits* — why Anvil is a compiler and not a
framework, and which principles are implemented vs. still ahead — see
[`PRODUCT_BOUNDARY.md`](PRODUCT_BOUNDARY.md). This document is the *how*.

## The canonical model: AIR + Evidence

Every source format compiles *into* AIR; every artifact compiles *from* AIR. AIR
(`@anvil/air`) is defined in Zod, so it doubles as runtime validation and JSON
Schema emission. Each operation carries:

- **effect** — read vs mutation, risk, reversibility
- **idempotency** — natural / key_supported / client_id / required / none
- **retries** — mode, backoff, transient conditions (never enabled on unproven mutations)
- **confirmation** — required for irreversible / high-risk / non-idempotent mutations
- **auth** — scheme + scopes
- **bindings** — `cli.command`, `mcp.toolName`, `skill.intentExamples` (one op, three surfaces)
- **state** — generated / review_required / approved / deprecated / blocked
- **evidence** — where each semantic came from (spec, source, docs, incident,
  inferred, …) and an aggregate confidence score

## Loop 1 — the compiler loop (implemented)

```
parse ── normalize ── classify ── enrich ── validate ── AIR ── generate
```

- **parse** (`@anvil/compiler/parse`): delegates to `@scalar/openapi-parser`
  (deref + Swagger 2.0 → 3.1 upgrade). Adapter-shaped so other formats slot in.
- **normalize**: OpenAPI → AIR operations, deriving stable ids, CLI/MCP/skill
  bindings, params, errors, and auth.
- **classify** (`@anvil/compiler/classify`): the effect/idempotency/risk/retry/
  confirmation inference. Conservative by construction — unknown side effect
  beats assumed safety.
- **enrich** (`@anvil/compiler/manifest`): the supplemental Anvil manifest
  overrides inference; anything left unset is recomputed so the model stays
  coherent. Bumps evidence confidence.
- **validate** (`@anvil/compiler/validate`): the safety validator. Escalates
  operations it cannot prove safe to `review_required`, disables retries on
  non-idempotent mutations, forces confirmation on high-risk mutations, and
  checks name uniqueness. The build surfaces unsafe behavior instead of emitting
  it silently.

## Loop 2 — the harness loop (`@anvil/harness`)

The harness finds the truth specs omit (which POSTs are really idempotent, which
errors are undocumented, which names are agent-hostile). **Anvil is an MCP client
here:** it connects to the MCP servers GitHub, GitLab, Confluence, Notion, and
Postman already publish — you install/point at them; Anvil builds no bespoke API
clients. A pluggable `HarnessAgent` decides which of a source's tools to call and
turns results into structured **claims** (never free text, so an untrusted wiki
page can't smuggle instructions into AIR). Claims flow into the **evidence graph**
and a **reconciler**.

The reconciler enforces the **asymmetric-trust rule** — the safety centerpiece:

- **Loosening** safety (mark a POST idempotent → enable retries, drop a
  confirmation) requires high-reliability evidence: implementation, contract
  tests, or recorded traffic (`≥ 0.85`). A pile of doc mentions is not enough.
- **Tightening** safety (add an error, mark non-idempotent, require confirmation)
  is cheap (`≥ 0.4`).
- On conflict, the **safer** claim wins.

Output is a **proposed manifest patch** — enrichment is propose-only and never
mutates AIR. Review it, then feed it to `anvil compile --manifest`. `anvil enrich`
drives this.

## The safety runtime (`@anvil/runtime`) — the hot path

```
validate → confirm → idempotency → dry-run? → host-pin → auth → ledger-durability → ledger → retry → normalize → observe
```

- **error taxonomy** — every failure maps to one of 16 codes, returned as a
  structured envelope (never raw upstream chaos).
- **retry engine** — bounded exponential backoff + full jitter; `retryIsSafe`
  gates on idempotency so a non-idempotent mutation is *never* auto-retried.
- **idempotency** — request fingerprinting (sha256 over canonical JSON) + an
  external **ledger** (reserve / replay / in-progress) because Cloud Run is
  stateless. The ledger is a **plugin**: `resolveLedger(ANVIL_LEDGER)` selects a
  registered durable backend (Firestore/Spanner/…); durable backends declare
  `durable: true`. A required-idempotency mutation **fails closed** outside `dev`
  when no *durable* ledger is configured (`idempotency_ledger_unavailable`) — a
  process-local ledger gives no cross-instance protection on a horizontally
  scaled runtime, so the runtime refuses rather than silently pretend. Dry-run,
  host-pinning, and auth are still checked first, so a preview always works and
  security errors win.
- **auth** — named profiles resolved from approved stores; secrets never reach
  execution records or agents.
- **policy hooks** — six local enforcement points (pre/post validate/auth/
  execute/response/error); a hook can deny.
- **observability** — one OpenTelemetry-shaped execution record per call.

The executor takes an injectable transport, so the entire safety contract is
unit-tested against mocks with no network.

## Deployment: build / deploy / run boundary

- **Build time** parses specs, runs the harness, generates artifacts, approves.
- **Deploy time** packages the *thin* runtime (compiled manifests +
  `server.js`), binds secrets, applies IAM.
- **Run time** only validates, enforces, calls upstream, normalizes, traces.

The **MCP server is the deployed unit** (one small Cloud Run service per tool
surface). The generated server depends on **`@anvil/mcp-runtime`** — the thin
serving path — and never on `@anvil/generators` (the build-time foundry): the
build/run boundary is enforced by the dependency graph, not just by convention.
It also serves the **skill and CLI over MCP resources** (`anvil://skill/…`,
`anvil://cli/…`) so an agent materializes them adjacent to itself. Those
resources are **precomputed at build time** (`resources.json`) and served
verbatim — the runtime advertises them, it does not generate them. Grounded in
the MCP resources spec (`resources/list` + `resources/read`, custom URI schemes,
`assistant` audience) and the 2026 skills-over-MCP pattern.

## Implemented vs staged

**Implemented & tested (68 tests):** AIR + evidence, OpenAPI/Swagger compiler,
classifier, manifest enrichment, safety validator, the full safety runtime
(including the durable-ledger fail-closed contract), the `@anvil/mcp-runtime`
serving path (with a live in-memory client round-trip), precomputed
resource-serving, skill package, catalog + compiled manifests, deploy artifacts,
mocks, evals, conformance-test generation, the `anvil` CLI + shared tool-CLI
engine, the self-skill + harness adapters, and the **harness loop** (MCP-client
source connectors, evidence graph, asymmetric-trust reconciler, `anvil enrich`).

**Staged (adapter seams exist):** gRPC / GraphQL / WSDL parsers, LLM-driven
harness agents (the heuristic agent ships; an LLM `HarnessAgent` plugs into the
same interface), learned classifiers, streaming & long-running operations, the
hosted registry, and live cloud deploy execution (Anvil emits the artifacts and
plan; it does not hold cloud credentials).
