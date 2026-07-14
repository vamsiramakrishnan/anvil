# Anvil

**An agent toolchain compiler.** Point Anvil at an API specification and it emits
three *aligned* artifacts — a type-safe **CLI**, a compliant **MCP server**, and a
portable **skill package** — all generated from one canonical model, so an
operation means the same thing on every surface.

Anvil is not an SDK generator. SDK generators assume a human will read the docs,
understand side effects, handle retries, and build guardrails. Agents don't have
that luxury. Anvil compiles a raw API surface into something an agent can use
**without guessing**.

> The highest compliment is not "it generated a lot of code." It's *"the agent
> stopped guessing."*

## What it does

```
spec (OpenAPI / Swagger)
        │  source import  →  immutable content-addressed snapshot (Layer 0)
        ▼
  SourceSnapshot  (verbatim bytes + provenance — the compiler's only input)
        │  parse → normalize → classify → enrich → validate
        ▼
      AIR  (the Anvil Intermediate Representation — one source of truth,
             cryptographically bound to the snapshot it was compiled from)
        │  generate
        ├─ type-safe CLI            (discovery, --dry-run, --explain, --schema)
        ├─ MCP server               (one tool per approved op, risk in metadata)
        ├─ skill package            (progressive disclosure: SKILL.md + reference/)
        ├─ compiled runtime         (thin, stateless Cloud Run server)
        ├─ deploy artifacts         (Dockerfile, Cloud Run YAML, env/secret contracts)
        └─ mocks · evals · docs · conformance tests
```

Every unsafe operation is treated as first-class: idempotency classification,
confirmation policy, retry-safety, dry-run, request fingerprinting, and audit
records. **The default posture: reads and idempotent writes are retryable;
non-idempotent writes are never retried automatically, and require confirmation.**

## Quickstart

The lifecycle is: **agentify → assess → capability approve → build → certify →
publish**. `agentify` is the one-shot front door — it locks the source snapshot,
compiles from it, assesses readiness, and proposes capabilities, then stops for
human review.

```bash
pnpm install && pnpm build
alias anvil='node packages/cli/dist/bin-anvil.js'

# 1. Discover: lock an immutable source snapshot, compile from it, assess, and
#    propose capabilities — nothing is approved, certified, or published.
anvil agentify examples/payments/openapi.yaml \
  --manifest examples/payments/anvil.yaml --service payments --out generated/payments

# 2. Assess: which operations are agent-ready, and why the rest are not.
anvil assess generated/payments
anvil assess generated/payments --check --fail-on blocked   # gate a pipeline explicitly

# 3. Review + approve a business capability (enforces the tool budget).
anvil capability list generated/payments
anvil capability approve generated/payments payments.refunds

# 4. Build the capability's own aligned bundle, then certify it.
anvil build generated/payments payments.refunds --out generated/refunds
anvil certify generated/refunds

# 5. Publish: verify the certification and emit the Cloud Run deploy plan
#    (see "publish" below — this writes a plan + publication.json, it does not
#    call any cloud API).
anvil publish generated/refunds
```

The compiler only ever reads a locked snapshot. To go step by step instead of
`agentify`, `anvil source add <spec>` locks the snapshot and `anvil compile
--source <snapshot-id>` compiles it (a bare `anvil compile <spec>` imports and
locks first, then compiles that snapshot).

```bash
# Dry-run an unsafe mutation — no side effects, secrets redacted.
ANVIL_ENV=prod ANVIL_ALLOWED_HOSTS=payments.internal.example.com \
anvil run generated/payments \
  refunds create --payment-id pay_123 --amount 2500 --currency USD \
  --idempotency-key k1 --confirm --dry-run
```

Without `--confirm`, the refund refuses:

```json
{ "error": { "code": "confirmation_required",
  "message": "This operation creates an irreversible financial mutation.",
  "required_flags": ["--confirm", "--idempotency-key"] } }
```

That refusal is the correct behavior.

## Architecture

Anvil is a **compiler, not a framework** — the compiler and AIR are the product;
every CLI, MCP server, skill, and deploy artifact is a replaceable *generated
view*. See [`docs/PRODUCT_BOUNDARY.md`](docs/PRODUCT_BOUNDARY.md) for the north
star (where the product boundary sits and why) and
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for how the two loops work.

Two loops (see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)):

- **Compiler loop** — turns known truth (specs) into aligned artifacts.
- **Harness loop** — finds missing truth (idempotency, undocumented errors,
  agent-hostile names) and refines AIR. The key artifact is **AIR + Evidence**:
  every operation carries where its semantics came from and a confidence score.
  Anvil is an **MCP client** here — it connects to the MCP servers GitHub,
  GitLab, Confluence, Notion, and Postman already publish (you install them; Anvil
  doesn't build clients) and **proposes** a manifest patch. Enrichment is
  propose-only and approval-gated, and under an **asymmetric-trust rule**:
  loosening safety (e.g. enabling retries) requires high-reliability evidence
  (implementation / contract tests / recorded traffic), while tightening safety
  is cheap.

  ```bash
  anvil enrich generated/payments --sources examples/payments/sources.yaml
  # → proposes an anvil.yaml patch; review it, then:
  anvil compile examples/payments/openapi.yaml --manifest proposed.anvil.yaml --out generated/payments
  ```

### Packages

| Package | Role |
| --- | --- |
| `@anvil/air` | The Anvil Intermediate Representation (Zod-defined) + evidence model |
| `@anvil/compiler` | Parse (OpenAPI) → normalize → **classify** → enrich → **validate** → **discover capabilities** |
| `@anvil/runtime` | The safety runtime: error taxonomy, retry engine, idempotency ledger (durable-backend plugins, fail-closed in prod), auth profiles, policy hooks, executor |
| `@anvil/mcp-runtime` | The thin MCP **serving** path: turns AIR into a live MCP server + serves precomputed skill/CLI resources. The deployed unit depends on this, not on the foundry |
| `@anvil/generators` | The build-time artifact foundry: CLI, MCP server source, skill, docs, deploy, mocks, evals, conformance |
| `@anvil/harness` | The harness loop: connects to **published** MCP servers (GitHub/GitLab/Confluence/…) to gather evidence and **propose** a manifest patch; also the loopback, **tri-surface conformance**, and opt-in **live** drivers |
| `@anvil/simulator` | Contract-faithful, deterministic simulator — a signature-identical projection of the generated MCP surface (auth, confirmation, idempotency/replay, seeded faults, pagination) |
| `@anvil/certification` | Static + executable certification, the safety **mutation battery**, and the **mechanistic coverage matrix** driven through the simulator |
| `@anvil/cli` | The `anvil` command + the shared engine that drives every generated tool CLI |

Built library-first: OpenAPI parsing (`@scalar/openapi-parser`), validation
(Zod), MCP protocol (`@modelcontextprotocol/sdk`), tests (Vitest), lint (Biome).
Anvil only builds the Anvil-specific layer — AIR, the classifier, the approval
workflow, the generators, and the safety runtime.

## Deployment topology

- **The MCP server is the deployed unit** (a thin, stateless Cloud Run service:
  `/mcp`, `/healthz`, `/readyz`, `/metrics`, `/openapi`). Nothing on the hot path
  parses specs or runs an LLM.
- **The skill and CLI are materialized adjacent to the agent.** The deployed MCP
  server serves them as **MCP resources** (`anvil://skill/…`, `anvil://cli/…`),
  so an agent connects, reads `SKILL.md` first (progressive disclosure), then
  pulls the CLI install manifest and runs the CLI next to itself.

## Operating Anvil from an agent

Anvil ships a skill for itself, generated from its own command registry (no
drift): [`skills/anvil/SKILL.md`](skills/anvil/SKILL.md). Runtime-native adapters
are provided for [Codex (`AGENTS.md`)](AGENTS.md), [Claude Code (`CLAUDE.md`)](CLAUDE.md),
and Antigravity (`.agent/skills/anvil/SKILL.md`). Regenerate with `anvil skill <dir>`.

## Status

The parser layer is an adapter interface: alongside OpenAPI 3.x / Swagger 2.0
REST JSON, Anvil now lowers **GraphQL SDL**, **gRPC / Protocol Buffers (proto3)**,
**SOAP / WSDL 1.1**, **Google API Discovery**, **OData v2/v4 ($metadata/EDMX —
SAP S/4HANA's native surface)**, and **Postman Collection v2.x**
into the same canonical model. Each protocol is *lowered*
into a pre-dereference OpenAPI 3.0 document and then runs through the identical
normalize → classify → validate → generate pipeline — so effect/idempotency
classification, the safety runtime, and every generated artifact (CLI, MCP,
skill, mocks) work uniformly across protocols. Effect is inferred conservatively:
GraphQL `Query`/`Mutation`, gRPC/SOAP read-verb method names lower to reads;
everything else lowers to a mutation that stays `review_required` until enriched.
See [`examples/README.md`](examples/README.md) for a runnable end-to-end walkthrough
across all four formats, and their specs under `examples/graphql`, `examples/grpc`,
and `examples/soap`. `pnpm test` runs the full suite (690+ tests). See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the roadmap and what is
implemented vs. staged.

Two current semantics worth stating plainly:

- **`publish` is plan-first, not a deployment.** It verifies that a *passing*
  certification matches the current bundle, prints the Cloud Run deployment plan,
  and writes `publication.json` into the bundle. It makes **no cloud API calls** —
  `anvil deploy cloud-run` owns actual rollout. Publishing to prod fails closed
  without a valid certification.
- **`anvil certify` is static (bundle-integrity); executable verification lives
  in three dedicated lanes.** The four certify gates (CONTRACT, SAFETY, SEMANTIC,
  RUNTIME) re-validate AIR, prove the CLI / MCP / runtime surfaces expose exactly
  the approved operations, and confirm the generated artifacts parse — without
  booting anything. To actually *run* the surfaces:
  - `anvil selftest <dir>` — **MCP loopback.** Boots the bundle's own mock
    upstream + generated MCP server and drives every approved tool over the real
    MCP transport (surface, fidelity, confirmation gate, error mapping, retry).
  - `anvil conformance <dir>` — **tri-surface agreement.** Drives the same input
    through the MCP server *and* the generated CLI against the same mock and
    proves they produce an identical wire request and identical safety behaviour,
    and that the skill documents that exact contract. `--live <config>` probes a
    real deployed `/mcp` endpoint (surface parity + production confirmation gate;
    reads opt-in; never drives a real mutation).
  - `anvil simulate <dir>` — **mechanistic coverage.** Enumerates the full safety
    matrix (each operation × auth, confirmation, idempotency, fault, pagination),
    drives every cell through the deterministic simulator, and runs the safety
    mutation battery — reporting coverage as a number, not a vibe.

## License

Apache-2.0.
