# The product boundary of Anvil

> The success of Anvil will not be determined by how well it parses OpenAPI.
> There are already excellent parsers for OpenAPI, GraphQL, protobuf, and SOAP.
> We use them; we do not reimplement them. The real challenge is deciding
> **where the product boundary sits.**

Anvil is not another runtime, another framework, or another API abstraction
layer. **Anvil is a compiler.** This document is the north star: it states the
boundary the product must own, and maps each principle to what exists in this
repo today (`docs/ARCHITECTURE.md` is the how; this is the why and the where).

Status legend used throughout:

- **Implemented** — shipped and tested in this repo.
- **Seam exists** — the interface/adapter is in place; the additional
  implementations are additive, not architectural.
- **Boundary** — inside the product boundary, not yet built. A future
  generator/parser/plugin, never a change to the compiler core.

---

## 1. Anvil is a compiler, not a framework

The biggest architectural mistake would be turning Anvil into another
long-running platform with its own runtime model. Think about LLVM:

```
Rust · C++ · Swift · Zig
        │
        ▼
     LLVM IR
        │
        ▼
   Machine Code
```

Nobody writes software *for* LLVM. LLVM exists to transform one representation
into another. Anvil occupies the same position:

```
OpenAPI · Swagger · GraphQL · SOAP · protobuf
GitHub · Confluence · Postman · Examples · Incidents · Recorded Traffic
        │
        ▼
       AIR
        │
        ▼
CLI · MCP · Skill Package · Cloud Run Runtime · Mocks · Tests · Docs · Deploy
```

**The compiler is the product. AIR is the product. Everything else is
generated, and everything else is replaceable.** This keeps the architecture
clean for years instead of accumulating runtime complexity.

> **Today.** The compiler loop (`parse → normalize → classify → enrich →
> validate → AIR → generate`) is implemented in `@anvil/compiler`, and AIR is
> the single canonical model in `@anvil/air`. The deployed unit is a *thin*,
> stateless runtime — nothing on the hot path parses specs or runs an LLM. The
> boundary is held: **Anvil compiles AIR; it is not a platform.**

---

## 2. Everything is a plugin

Nothing should be hardcoded — not parsers, not generators, not enrichment
sources, not deployment targets. The compiler should never change; only the
plugins evolve.

### Parser plugins

| Today | Tomorrow |
| --- | --- |
| OpenAPI, Swagger | AsyncAPI, gRPC reflection, protobuf, GraphQL, SOAP/WSDL |
| | Salesforce, SAP, Oracle, Kafka schemas, custom internal formats |

> **Today.** `parseSpec` in `@anvil/compiler` is adapter-shaped around a
> `SourceKind`, delegating deref + Swagger→3.1 upgrade to
> `@scalar/openapi-parser`. OpenAPI/Swagger are **implemented**; the parser
> adapter is a **seam** — new formats slot in without touching normalize,
> classify, or validate.

### Generator plugins

| Today | Tomorrow |
| --- | --- |
| CLI, MCP, Skill Package, Cloud Run runtime | Gemini Extension, VS Code Extension, GitHub Action |
| Documentation, Tests, Mocks, Evals | Terraform, Helm, Kubernetes, Cloud Functions, Cloud Run Jobs |

> **Today.** `@anvil/generators` is already a foundry of independent modules
> (`cli`, `mcp`, `skill`, `deploy`, `docs`, `mock`, `evals`, `conformance`,
> `resources`, `catalog`). Each reads AIR and emits one view — **implemented**.
> New targets are new modules; the compiler is untouched.

### Enrichment plugins

| Today | Tomorrow |
| --- | --- |
| GitHub, Confluence, Postman, Examples, Recorded Traffic | MCP connectors, issue trackers, runbooks, internal wikis, design docs |

> **Today.** The harness (`@anvil/harness`) is an **MCP client** — it connects
> to the MCP servers GitHub/GitLab/Confluence/Notion/Postman already publish
> rather than building bespoke API clients (`mcp-source.ts`, `sources.ts`). Each
> source contributes **evidence**; none owns the truth. **Seam exists** for any
> new MCP-published source.

---

## 3. AIR must be richer than every source

This is the single most important design principle. OpenAPI is a *transport
description*. It knows almost nothing about operating a system safely — it does
not understand retries, idempotency, business capabilities, workflows, side
effects, operational risk, approval requirements, SLAs, ownership, confidence,
documentation quality, examples, or incidents.

**AIR should understand all of those.** AIR is not an abstract syntax tree — it
is a *semantic graph* describing how an enterprise capability behaves:

```
Refund Payment
  → POST Operation → Financial Mutation
  → Requires Approval → Requires Idempotency
  → Uses OAuth Scope → Touches Financial Ledger
  → Retry Safe After Timeout → Known Workflow
  → Appears in Documentation → Appears in Production Examples
  → Related Incident History
  → Confidence: 0.94
```

Once AIR carries this, every generator becomes straightforward.

> **Today.** Each AIR operation already carries `effect` (read/mutation, risk,
> reversibility), `idempotency`, `retries`, `confirmation`, `auth`, `bindings`
> (one op → three surfaces), `state`, and `evidence` with an aggregate
> confidence. **Implemented.** SLAs, ownership, and incident linkage are
> **boundary** — additive fields on the same model.

---

## 4. Skills are compiled capabilities

A skill is not a Markdown document — Markdown is only one *view*. A skill is a
portable capability package containing everything an agent needs to operate
safely: a concise `SKILL.md`, executable examples, a generated CLI, schemas,
workflows, policies, mocks, evals, tests, and documentation.

Think `payments.skill`, not `payments.md`.

> **Today.** `anvil package skill` emits a progressive-disclosure package
> (`SKILL.md` + `reference/` + `evals/`), and the deployed MCP server serves the
> skill and CLI as **MCP resources** (`anvil://skill/…`, `anvil://cli/…`) so an
> agent materializes them adjacent to itself. **Implemented.** Bundling
> workflows and policies *into* the skill package is **boundary** (see §6).

---

## 5. Capabilities become the primary abstraction

Enterprise APIs expose *operations*. Agents solve *business problems*. Those are
different abstractions. Instead of exposing hundreds of endpoints
(`POST /payments/refund`, `GET /payments`, `PATCH /payments/status`), Anvil
should expose **business capabilities**: Customer Management, Payments, Refunds,
Invoicing, Reporting, Subscriptions.

Each capability owns its operations, workflows, documentation, examples, mocks,
evals, and policies. **Agents should search for a capability, not a URL.**

> **Today.** AIR is operation-centric; operations already carry the semantics a
> capability would group. A first-class **Capability** node — grouping
> operations + workflows + policies under one searchable business unit, and a
> capability-scoped catalog/CLI surface — is **boundary**. This is the largest
> single step from where the repo is to where the manifesto points.

---

## 6. Workflows become first-class

Operations rarely exist in isolation — business systems are workflows:

```
Refund Customer
  → Find Payment → Validate Status → Calculate Refund
  → Issue Refund → Wait For Completion → Verify Success
```

These workflows should be generated automatically and become part of the
capability, so a generated CLI can offer `payments workflows refund` instead of
forcing an agent to discover individual endpoints.

> **Today.** Workflows are not yet a first-class AIR node. **Boundary** — a
> `Workflow` type in AIR plus a workflow generator and a `workflows` CLI verb.

---

## 7. AIR owns confidence

Every generated decision should carry provenance and confidence:

```
Refund Endpoint   confidence 1.00   source OpenAPI
Idempotency       confidence 0.82   source GitHub integration tests
Description       confidence 0.67   source harness
Workflow          confidence 0.95   source Confluence
```

Humans review *confidence*, not generated YAML.

> **Today.** Every semantic in AIR records where it came from and an aggregate
> confidence; the harness reconciler enforces the **asymmetric-trust rule**
> (loosening safety needs high-reliability evidence ≥ 0.85; tightening is cheap
> ≥ 0.4; the safer claim wins). **Implemented.**

---

## 8. Build an evidence graph

AIR describes the capability; the **evidence graph** explains *why* AIR believes
something. Every semantic assertion points back to evidence:

```
Refund Capability
  → OpenAPI → GitHub Implementation → Confluence
  → Production Incident → Pull Request → Generated Tests → Human Review
```

**Nothing should exist because "AI guessed."** Every decision is explainable.

> **Today.** `@anvil/harness/evidence.ts` builds the evidence graph from
> structured **claims** (never free text — an untrusted wiki page cannot smuggle
> instructions into AIR). **Implemented.** Widening the graph to incidents and
> PRs is a matter of new MCP sources (§2), not new architecture.

---

## 9. Make the compiler incremental

Treat compilation like Bazel, not traditional whole-tree code generation. When a
GitHub repository changes, trace the blast radius and regenerate only what it
touches:

```
GitHub Change → Affected Capability → Affected Operations
  → Regenerate CLI · MCP · Skill · Tests · Documentation
```

**Never regenerate everything.** Incrementality should be built into AIR.

> **Today.** Compilation is whole-model today. Incremental invalidation keyed on
> the evidence graph is **boundary** — enabled by §3/§8 (rich AIR + provenance)
> already being in place.

---

## 10. Introduce review packs

Reviewing generated files does not scale. Generate **semantic review units**
instead:

```
Review Pack
  Operations Changed: 7
  Retry Policies Changed: 2
  Safety Rules Added: 1
  Examples Added: 14
  Confidence Reduced: Customer Update
  Documentation Improved: Refund Workflow
```

**Approvals happen at the capability level, not the generated-file level.**

> **Today.** Approval is per-operation and state-gated (`anvil approve`), and
> enrichment is **propose-only** (a manifest patch you review before compiling).
> The semantic **Review Pack** as a first-class diff artifact is **boundary** —
> it composes the existing state machine and evidence deltas.

---

## 11. The harness becomes a role-based swarm

The harness should not be coupled to any individual coding agent. Define
specialist **roles** — Researcher, Specification Author, Critic, Test Writer,
Mock Generator, Security Reviewer, CLI Reviewer, Documentation Reviewer — and let
Claude Code, Codex, Gemini, Antigravity, or future systems become
*implementations* of those roles. The orchestration model stays stable as models
evolve.

> **Today.** A pluggable `HarnessAgent` interface exists; a heuristic agent
> ships and an LLM agent plugs into the same seam. **Seam exists.** The
> role-based multi-agent swarm (distinct specialist roles with an orchestrator)
> is **boundary**, built on that interface.

---

## 12. Runtime targets are plugins

Cloud Run is the primary Google Cloud target, but it is a **runtime generator**,
not something embedded in the compiler:

```
AIR → Runtime Generator → { Cloud Run · Local · Docker Compose · Future Targets }
```

Cloud Run is the canonical implementation — an excellent fit for stateless MCP
services, integrating naturally with Google Cloud IAM, Cloud Build, Artifact
Registry, Cloud Logging, and Cloud Monitoring. But **the compiler compiles AIR;
it never compiles Cloud Run directly.**

> **Today.** `@anvil/generators/deploy.ts` emits Cloud Run artifacts
> (Dockerfile, service YAML, env/secret contracts) as one generator among many;
> the runtime is transport-injectable and target-agnostic. **Implemented** for
> Cloud Run; other targets are **seams**.

---

## The core insight

The biggest shift in thinking:

> **Anvil does not compile APIs. It compiles enterprise systems into
> agent-native capabilities.**

```
SAP · Stripe · Salesforce · Internal Billing · CRM · Inventory
        │
        ▼
   Business Capability
        │
        ▼
   Operations → Workflows → Skill Package
        │
        ▼
   CLI · MCP · Cloud Run Runtime
```

Customers are not trying to generate MCP servers. They are trying to make
complex enterprise systems usable by agents. The generated CLI, MCP server,
skill package, deployment artifacts, documentation, mocks, tests, and evals are
simply different **compiled views of the same capability**.

**That is the product boundary Anvil owns.**

---

## Where the boundary stands today

| # | Principle | Status |
| --- | --- | --- |
| 1 | Compiler, not a framework | **Implemented** — compiler loop + thin runtime |
| 2 | Everything is a plugin | Parsers **seam** · Generators **implemented** · Enrichment **seam** |
| 3 | AIR richer than every source | **Implemented** — effect/idempotency/retry/confirmation/auth/evidence |
| 4 | Skills are compiled capabilities | **Implemented** — skill package + MCP resources |
| 5 | Capabilities as primary abstraction | **Boundary** — first-class Capability node |
| 6 | Workflows are first-class | **Boundary** — Workflow node + generator + CLI verb |
| 7 | AIR owns confidence | **Implemented** — provenance + asymmetric-trust reconciler |
| 8 | Evidence graph | **Implemented** — structured claims → graph |
| 9 | Incremental compilation | **Boundary** — evidence-keyed invalidation |
| 10 | Review packs | **Boundary** — semantic, capability-level review units |
| 11 | Role-based harness swarm | **Seam** (`HarnessAgent`) → **Boundary** (roles) |
| 12 | Runtime targets are plugins | **Implemented** (Cloud Run) · other targets **seam** |

The guiding rule for every future change: **if it would make the compiler know
about a specific parser, generator, source, or runtime target, it is on the
wrong side of the boundary.** The compiler compiles AIR. Everything else is a
plugin.
