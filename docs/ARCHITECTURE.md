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
- **capabilityId** — the business capability this operation belongs to
- **evidence** — a set of **claims**, each scoped to one semantic
  (`subject`/`predicate`/`value`) with its own provenance (`source`,
  `sourceRef`, `method`), `confidence`, `reliability`, and review status.
  Aggregate confidence is a *pure function* of the active claims
  (`evidenceConfidence`) — never a stored number that can drift.

Above operations sit the **primary abstraction**: agents reason about business
capabilities, not URLs.

- **Capability** — a business unit ("Refunds", "Payments") that owns a set of
  operations and workflows. Discovered by the compiler (grouped by OpenAPI tag,
  falling back to the resource noun) with recorded `source` + confidence, so a
  grouping is auditable rather than magical.
- **Workflow** + **WorkflowStep** — an ordered sequence of operations that
  accomplishes a business task ("Refund a customer"). Workflows are **authored
  or enriched, never guessed** — Anvil does not fabricate multi-step business
  logic; auto-inference is a staged seam.

## Loop 1 — the compiler loop (implemented)

```
parse ── normalize ── classify ── enrich ── validate ── discover-capabilities ── AIR ── generate
```

- **parse** (`@anvil/compiler/parse`): delegates to `@scalar/openapi-parser`
  (deref + Swagger 2.0 → 3.1 upgrade). Today there is exactly **one** parser
  (OpenAPI/Swagger); a second format (GraphQL/gRPC/WSDL) is added by writing a
  parser that emits AIR — the downstream passes (classify/validate/generate) are
  format-agnostic over AIR and do not change. That boundary is *tested*, not just
  asserted; it is an honest seam, not a plugin framework.
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
- **discover-capabilities** (`@anvil/compiler/capabilities`): groups operations
  into business capabilities (by tag, then resource) and attaches
  manifest-authored workflows to them. The shift from operations to capabilities
  as the unit agents browse. Workflow *inference* is deliberately not here — a
  fabricated workflow is exactly the kind of guess Anvil exists to remove.

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

**Implemented & tested (78 tests):** AIR + evidence, **capabilities + authored
workflows** (discovery pass, `capabilities`/`workflows` CLI verbs, capability-led
skill), OpenAPI/Swagger compiler, classifier, manifest enrichment, safety
validator, the full safety runtime (including the durable-ledger fail-closed
contract), the `@anvil/mcp-runtime` serving path (with a live in-memory client
round-trip), precomputed resource-serving, skill package, catalog + compiled
manifests, deploy artifacts, mocks, evals, conformance-test generation, the
`anvil` CLI + shared tool-CLI engine, the self-skill + harness adapters, and the
**harness loop** (MCP-client source connectors, evidence graph, asymmetric-trust
reconciler, `anvil enrich`).

**Staged (adapter seams exist):** gRPC / GraphQL / WSDL parsers, **workflow
auto-inference** (the `Workflow` model ships; inferring flows from a spec is the
staged seam, kept off by design), capability-bundled policies/mocks/evals,
LLM-driven harness agents (the heuristic agent ships; an LLM `HarnessAgent` plugs
into the same interface), learned classifiers, streaming & long-running
operations, the hosted registry, and live cloud deploy execution (Anvil emits the
artifacts and plan; it does not hold cloud credentials).
