# Anvil architecture

Anvil turns an API description you already have into agent tools. This page is
the *how*: the pipeline that reads a spec, the loop that fills in what the spec
left out, and the runtime that keeps an agent's calls safe.

For *why Anvil is a compiler and not a framework* — and which ideas are built
today versus still ahead — see [`PRODUCT_BOUNDARY.md`](PRODUCT_BOUNDARY.md).

> **The one idea to hold onto:** Anvil builds a single description of your API
> once, then generates the CLI, MCP server, and skill from it. Because all three
> come from the same source, they can't disagree about what an operation does or
> whether it's safe to call.

## The shared model: AIR + evidence

Anvil reads every source format *into* one internal model, and generates every
tool *from* it. That model is called AIR (Anvil Intermediate Representation);
after this section we'll just call it "the model." It lives in `@anvil/air` and
is defined with Zod, so the same definition validates data at runtime and emits
JSON Schema.

Each operation in the model carries:

| Field | What it records |
| --- | --- |
| **effect** | read vs. mutation, risk level, whether it can be undone |
| **idempotency** | `natural` / `key_supported` / `client_id` / `required` / `none` — whether repeating the call is safe |
| **retries** | mode, backoff, transient conditions (never turned on for a mutation Anvil hasn't proven safe to repeat) |
| **confirmation** | required for irreversible, high-risk, or non-repeatable mutations |
| **auth** | scheme + scopes |
| **bindings** | `cli.command`, `mcp.toolName`, `skill.intentExamples` — one operation, three tools |
| **state** | `generated` / `review_required` / `approved` / `deprecated` / `blocked` |
| **capabilityId** | the business capability this operation belongs to |
| **evidence** | why Anvil believes each of the above (see below) |

**Evidence** is a set of *claims*. Each claim is scoped to one fact
(`subject`/`predicate`/`value`) and carries its own provenance (`source`,
`sourceRef`, `method`), a `confidence`, a source `reliability`, and a review
status. Confidence is resolved *per fact* — `confidenceFor(evidence, predicate)`,
weighted by how reliable the source is — so a strong "this operation exists"
never props up a weak "this is idempotent." The node-level `evidenceConfidence`
is a display-only summary and never gates safety.

### Capabilities and workflows

Agents shouldn't reason about URLs. They reason about business capabilities — a
**capability** being a group of related operations (like *Refunds* or
*Payments*). Two structures sit above operations:

- **Capability** — a business unit that owns a set of operations and workflows.
  The compiler discovers capabilities by grouping operations by OpenAPI tag,
  falling back to the resource noun, and records each grouping's `source` and
  confidence — so it's auditable, not magical.
- **Workflow** + **WorkflowStep** — an ordered sequence of operations that
  completes a business task ("Refund a customer"). Workflows are **authored or
  filled in by hand, never guessed.** Anvil does not fabricate multi-step
  business logic; automatic inference is a deliberate gap.

## Loop 1 — the compiler (built today)

One pass reads a spec and produces the model, then generates the tools:

```
parse ─ normalize ─ classify ─ enrich ─ validate ─ discover-capabilities ─ AIR ─ generate
```

- **parse** (`@anvil/compiler/parse`): converts and dereferences the spec using
  mature libraries — `swagger2openapi` upgrades Swagger 2.0 to OpenAPI 3.x, and
  `@scalar/openapi-parser` dereferences OpenAPI 3.x. Today there is exactly
  **one** parser (OpenAPI/Swagger). Adding a second format (GraphQL/gRPC/WSDL)
  means writing a parser that emits the model; the passes downstream
  (classify/validate/generate) work on the model, not the format, so they don't
  change. That boundary is *tested*, not just asserted — an honest seam, not a
  plugin framework.
- **normalize**: turns OpenAPI into model operations, deriving stable ids,
  CLI/MCP/skill bindings, params, errors, and auth.
- **classify** (`@anvil/compiler/classify`): infers effect, idempotency, risk,
  retry, and confirmation. Conservative by design — an unknown side effect beats
  assumed safety.
- **enrich** (`@anvil/compiler/manifest`): applies your manifest — a small file
  where you fill in what the spec left out. It overrides inference; anything you
  leave unset is recomputed so the model stays coherent, and it raises evidence
  confidence.
- **validate** (`@anvil/compiler/validate`): the safety validator. It holds any
  operation it can't prove safe at `review_required`, disables retries on
  non-repeatable mutations, forces confirmation on high-risk mutations, and
  checks that names are unique. Unsafe behavior surfaces at build time instead of
  shipping silently.
- **discover-capabilities** (`@anvil/compiler/capabilities`): groups operations
  into capabilities (by tag, then resource) and attaches any manifest-authored
  workflows. This is the shift from operations to capabilities as the thing
  agents browse. Workflow *inference* is deliberately absent — a fabricated
  workflow is exactly the guess Anvil exists to remove.

## Loop 2 — the harness (`@anvil/harness`)

A spec omits things: which POSTs are actually safe to repeat, which errors are
undocumented, which operation names would confuse an agent. The harness finds
those facts.

**Here, Anvil is an MCP client.** It connects to the MCP servers that GitHub,
GitLab, Confluence, Notion, and Postman already publish — you install or point at
them, and Anvil builds no bespoke API clients of its own. A pluggable
`HarnessAgent` decides which of a source's tools to call and turns the results
into structured **claims** — never free text, so an untrusted wiki page can't
smuggle instructions into the model. Claims flow into an **evidence graph** and a
**reconciler**.

The reconciler enforces the **asymmetric-trust rule**, the safety centerpiece:

| Change | What it takes |
| --- | --- |
| **Loosen** safety (mark a POST idempotent, enable retries, drop a confirmation) | High-reliability evidence — implementation, contract tests, or recorded traffic (`≥ 0.85`). Doc mentions are not enough. |
| **Tighten** safety (add an error, mark non-idempotent, require confirmation) | Cheap (`≥ 0.4`). |
| **On conflict** | The **safer** claim wins. |

The output is a **proposed manifest patch**. Enrichment only proposes — it never
edits the model directly. You review the patch, then feed it to
`anvil compile --manifest`. `anvil enrich` drives this loop.

## The safety runtime (`@anvil/runtime`) — the hot path

Every agent call runs this gauntlet before and after it reaches your API:

```
validate → confirm → idempotency → dry-run? → host-pin → auth → ledger-durability → ledger → retry → normalize → observe
```

- **error taxonomy** — every failure maps to one of 16 codes and comes back as a
  structured envelope, never raw upstream chaos.
- **retry engine** — bounded exponential backoff with full jitter; `retryIsSafe`
  gates on idempotency, so a non-repeatable mutation is *never* auto-retried.
- **idempotency** — a request fingerprint (sha256 over canonical JSON) plus an
  external **ledger** (reserve / replay / in-progress), because a stateless
  service like Cloud Run can't remember its own requests. The ledger is a
  plugin: `resolveLedger(ANVIL_LEDGER)` picks a registered durable backend
  (Firestore/Spanner/…), and durable backends declare `durable: true`. Outside
  `dev`, a required-idempotency mutation **fails closed**
  (`idempotency_ledger_unavailable`) when no durable ledger is configured — a
  process-local ledger gives no protection across instances on a horizontally
  scaled runtime, so the runtime refuses rather than pretend. Dry-run,
  host-pinning, and auth are checked first, so a preview always works and
  security errors win. The built-in Firestore backend stores only hashed ledger
  keys, gives completed results a configurable expiry (seven days by default),
  and never auto-expires in-progress reservations. Its `/readyz` check performs
  a field-masked, non-mutating lookup and fails closed when the selected
  database is unavailable or inaccessible. Shared mode uses an existing
  platform-owned database per trust domain; dedicated mode creates one database
  for a stronger IAM boundary. Collection groups are not IAM boundaries.
- **auth** — named profiles resolved from approved stores; secrets never reach
  execution records or agents.
- **policy hooks** — six local enforcement points (pre/post
  validate/auth/execute/response/error); a hook can deny a call.
- **observability** — one OpenTelemetry-shaped execution record per call.

The executor takes an injectable transport, so the whole safety contract is
unit-tested against mocks with no network.

## Build / deploy / run

The work splits cleanly across three phases:

| Phase | What happens |
| --- | --- |
| **Build time** | parse specs, run the harness, generate artifacts, approve operations |
| **Deploy time** | package the *thin* runtime (compiled manifests + `server.js`), bind secrets, apply IAM |
| **Run time** | validate, enforce, call upstream, normalize, trace — nothing else |

The **MCP server is the deployed unit**: one small Cloud Run service per tool
surface. That server depends on **`@anvil/mcp-runtime`** — the thin serving path
— and never on `@anvil/generators` (the build-time foundry). The dependency graph
enforces the build/run boundary, not just convention.

The server also serves the **skill and CLI as MCP resources**
(`anvil://skill/…`, `anvil://cli/…`), so an agent can materialize them next to
itself. Those resources are **precomputed at build time** (`resources.json`) and
served verbatim — the runtime advertises them, it does not generate them. This
follows the MCP resources spec (`resources/list` + `resources/read`, custom URI
schemes, `assistant` audience) and the 2026 skills-over-MCP pattern.

## Built today vs. staged

**Built and tested (78 tests):** the model + evidence, capabilities + authored
workflows (discovery pass, `capabilities`/`workflows` CLI verbs, capability-led
skill), the OpenAPI/Swagger compiler, classifier, manifest enrichment, safety
validator, the full safety runtime (including the durable-ledger fail-closed
rule), the `@anvil/mcp-runtime` serving path (with a live in-memory client
round-trip), precomputed resource-serving, the skill package, catalog + compiled
manifests, deploy artifacts, mocks, evals, conformance-test generation, the
`anvil` CLI + shared tool-CLI engine, the self-skill + harness adapters, and the
**harness loop** (MCP-client source connectors, evidence graph, asymmetric-trust
reconciler, `anvil enrich`).

**Staged (the seam exists, the implementation doesn't):** gRPC / GraphQL / WSDL
parsers; workflow auto-inference (the `Workflow` model ships; inferring flows
from a spec is off by design); capability-bundled policies/mocks/evals; LLM-driven
harness agents (the heuristic agent ships; an LLM `HarnessAgent` plugs into the
same interface); learned classifiers; streaming and long-running operations; the
hosted registry; and live cloud deploy execution (Anvil emits the artifacts and
the plan — it does not hold cloud credentials).
