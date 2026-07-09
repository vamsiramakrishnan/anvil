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
        │  parse → normalize → classify → enrich → validate
        ▼
      AIR  (the Anvil Intermediate Representation — one source of truth)
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

```bash
pnpm install && pnpm build

# Compile the reference payments API into a full tool bundle.
node packages/cli/dist/bin-anvil.js compile \
  examples/payments/openapi.yaml \
  --manifest examples/payments/anvil.yaml \
  --service payments --out generated/payments

node packages/cli/dist/bin-anvil.js inspect generated/payments

# Dry-run an unsafe mutation — no side effects, secrets redacted.
ANVIL_ENV=prod ANVIL_ALLOWED_HOSTS=payments.internal.example.com \
node packages/cli/dist/bin-anvil.js run generated/payments \
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
| `@anvil/compiler` | Parse (OpenAPI) → normalize → **classify** → enrich → **validate** |
| `@anvil/runtime` | The safety runtime: error taxonomy, retry engine, idempotency ledger, auth profiles, policy hooks, executor |
| `@anvil/generators` | The artifact foundry: CLI, MCP, skill, docs, deploy, mocks, evals, conformance |
| `@anvil/harness` | The harness loop: connects to **published** MCP servers (GitHub/GitLab/Confluence/…) to gather evidence and **propose** a manifest patch |
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

MVP focus (spec §19): OpenAPI 3.x / Swagger 2.0 REST JSON. The parser layer is an
adapter interface, so gRPC / GraphQL / WSDL are additive. `pnpm test` runs the
full suite (49 tests). See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the
roadmap and what is implemented vs. staged.

## License

Apache-2.0.
