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
        ├─ type-safe CLI            (discovery, --dry-run, --explain, --schema, --mcp)
        ├─ MCP server               (one tool per approved op, risk in metadata;
        │                            local stdio + remote Streamable HTTP;
        │                            explicit legacy SSE — ADR-0022/0023)
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
exercise → plan**. `agentify` is the one-shot front door — it locks the source
snapshot, compiles from it, assesses readiness, and proposes capabilities, then
stops for human review.

```bash
pnpm install && pnpm build
alias anvil='pnpm anvil'   # `pnpm anvil <cmd>` works immediately; the alias just shortens it

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

# 4. Build the capability's own aligned bundle, statically certify it, then
#    execute all three proof lanes against the same bundle digest.
anvil build generated/payments payments.refunds --out generated/refunds
anvil certify generated/refunds
anvil selftest generated/refunds
anvil conformance generated/refunds
anvil simulate generated/refunds

# 5. Plan: verify static + executable evidence and emit the Cloud Run deploy plan
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

The same command can **route through an MCP server** instead of executing
directly — `--mcp stdio` spawns the bundle's own local server, `--mcp <url>`
targets a remote one, and `ANVIL_MCP_TARGET` sets the default (the per-call flag
wins). This makes *skill → CLI → MCP* one code path, so the CLI and the MCP tool
provably do the same thing (see [ADR-0023](docs/adr/0023-cli-to-mcp-runtime-routing.md)).
For an OAuth-protected remote Streamable HTTP endpoint, store the bearer token
in an environment variable and pass only its name with
`--mcp-token-env <ENV_NAME>` (`ANVIL_MCP_TOKEN_ENV` sets the default name);
tokens never belong in the target URL or command arguments.

## How good is the generated MCP server & skill? Prove it — per bundle.

Quality is not a claim in this README; it is a property **each generated bundle
demonstrates about itself**, with evidence bound to the bundle's content hash:

| Proof | Command | What it demonstrates |
|---|---|---|
| Loopback selftest | `anvil selftest` | Boots the generated mock + MCP server and invokes **every approved tool over the real MCP transport**: arguments reach the wire faithfully, confirmation gates refuse before side effects, non-idempotent mutations are never auto-retried. |
| Tri-surface conformance | `anvil conformance` | The skill, CLI catalog, and MCP tool list name the same operations; the skill documents the **exact** posture the runtime enforces; the same input hits the wire identically via MCP and CLI. |
| Safety simulation | `anvil simulate` | Drives the full safety matrix (auth gating, confirmation, idempotent replay, injected faults, pagination) through a deterministic simulator — then **mutates each safety control and proves the surface detects it**. |
| Static certification | `anvil certify` | Byte-level agreement of every generated surface with canonical AIR, plus semantic gates (e.g. sibling operations may not share a description). |
| Agent-task benchmark | `anvil benchmark` | Derives tasks from each operation's intent examples and scores tool discovery, parameter satisfiability, and call success. `--check <threshold>` gates CI. |

All evidence is **hash-bound and freshness-checked**: a report recorded against
older bundle content is *stale*, never silently trusted, and `anvil publish`
fails closed for production without all fresh proof lanes. On the public-corpus
gauntlet (5,500+ operations compiled across Stripe, GitHub, Jira, Twilio, Slack,
Coda, Zendesk, TM Forum, Coupa, Workday, Zoho, Oracle OPERA, NOAA SOAP, and
more), fully-driven bundles pass **every** lane — e.g. Coda: 72/72 selftest,
136/136 conformance, 504/504 simulation cells with 4/4 safety mutants killed,
134/134 benchmark tasks.

The generated skill itself follows a strict operating ladder (discover an
approved operation → use an authored workflow → read the contract → dry-run →
stop and ask when unapproved), progressive disclosure (a compact SKILL.md router
over `reference/` detail), and honest exposure: unapproved operations are
listed as **not callable**, never hidden and never advertised.

## Shape the surface without forking the spec

The compiled surface is **malleable by declaration**, not by editing generated
code or forking the vendor spec. One manifest layer reshapes everything at once
— and every loosening stays review-gated:

```yaml
# anvil.yaml — the same file, shaping very different things
auth:
  type: oauth2_on_behalf_of        # remodel a blocked end-user OAuth estate to
                                   # per-caller RFC 8693 token exchange (one line)
operations:
  sendSms:
    idempotency: { strategy: required_request_key }   # turn "please don't re-run"
                                                      # into an enforced guarantee
  get_refund_by_id:
    description: Retrieve one refund by its refund id.  # fix a vendor's duplicate docs
query_templates:
  branch_names:                    # expose a constrained, read-only query instead
    operation: run_query           # of a raw SQL passthrough
    template: "SELECT name FROM accounts WHERE branch = '{branch}' LIMIT 10"
    target_param: sql
    params: { branch: { schema: { type: string, pattern: "^[A-Z0-9]+$" } } }
    read_only: true
```

`anvil refine run` closes documentation gaps the same way — evidence-gated
proposals (descriptions, examples, intent phrases, pagination) that a policy
auto-approves only when grounded, and `anvil refine apply` writes them back to
AIR. Recompile, and all three surfaces move together.

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

  Enrichment can be **targeted** rather than a full sweep: `anvil distill`
  reduces a surface to its eigenbasis (one canonical read per cluster, every
  write its own vector) and `--as-enrich-plan` turns its *open questions* into a
  source-routed plan that `anvil enrich --plan` probes — asking code hosts to
  prove idempotency and doc hosts to describe intent, only for the operations
  that are actually uncertain (see [ADR-0024](docs/adr/0024-distillation-eigenbasis-and-enrichment-plan.md)).

  ```bash
  anvil distill generated/payments --as-enrich-plan --write plan.json
  anvil enrich generated/payments --sources sources.yaml --plan plan.json
  ```

  A name an agent cannot route on (`do_transition`, `get_object`) is a
  first-class deficiency, and its fix re-homes every surface at once:

  ```yaml
  # anvil.yaml — re-project canonical name, CLI command, and MCP tool together
  operations:
    doTransition: { name: { resource: issue, verb: transition } }
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

- **Durable write protection is explicit and independently provable.**
  `anvil deploy ledger <dir> --project <id> --database <database-id>` reads the
  generated `deploy/idempotency-store.json`, lists every approved write, and
  verifies the shared/dedicated Firestore boundary, collection group, TTL, IAM,
  and `ANVIL_LEDGER` wiring against AIR without making a cloud call. Shared mode
  is the estate-scale default; dedicated mode additionally requires an immutable
  location. That is static
  wiring, not live readiness: after apply, require the deployed `/readyz`
  data-plane probe to return 200. The ledger provides bounded
  reservation/replay protection, not an exactly-once guarantee.
- **`publish` is plan-first, not a deployment.** It requires fresh static
  certification plus fresh passing `selftest`, `conformance`, and `simulation`
  reports for the current bundle digest, prints the Cloud Run deployment plan,
  and writes the evidence snapshot to `publication.json`. It makes **no cloud API
  calls**; `anvil deploy cloud-run` also only prints the operator plan. Your
  reviewed delivery workflow applies the generated Terraform or Cloud Build
  artifacts. Non-prod plans can explicitly use `--allow-incomplete-evidence`;
  prod always fails closed.
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
