# Anvil architecture audit

Anvil is a compiler: it compiles heterogeneous system descriptions and evidence
into **AIR**, then projects AIR into CLIs, MCP servers, skills, mocks, evals,
tests, docs, and Cloud Run deployments. This audit reviews the codebase against
that North Star and records, per mechanism, whether we **Keep / Simplify /
Replace / Delete / Defer** it. It is deliberately direct.

The rule applied throughout: *only keep an abstraction that has a real second
implementation, a credible near-term second, or a clear testing seam.* Prefer
deletion over generalization; the implementation leads and documentation
follows.

## Method

Every package was read in full (`packages/{air,compiler,generators,runtime,mcp-runtime,harness,cli}/src`).
Cross-package imports were traced to establish the actual (not documented)
dependency graph, and the generated bundle + Cloud Run outputs were inspected as
artifacts that must actually deploy.

---

## 1. Core semantic model (AIR)

**Finding.** AIR *does* carry `Capability` and `Workflow` as first-class types,
but the ownership is still `Service → Operations[]`, with capabilities and
workflows layered as **views over operation ids**:

- `Capability.operationIds: string[]` / `workflowIds: string[]` — a capability is
  a bag of stringly-typed references, not an owner.
- `Workflow.steps[].bindings: Record<string,string>` — advisory free-form
  strings (`"$.steps.findPayment.id"`) with no validated semantics; no
  preconditions, terminal conditions, compensation, or polling/resume contract.
- Surface bindings (`cli.command`, `mcp.toolName`, `skill.intentExamples`) live
  **directly on the semantic `Operation`**, mixing derived projection with owned
  semantics.

| Mechanism | Disposition | Note |
|---|---|---|
| `Operation` as the atom | **Keep** | Load-bearing; correct. |
| `Capability` = arrays of ids | **Simplify (partial)** | Referential integrity now *tested*; a true containment refactor is **Deferred** (see risks). |
| `Workflow.bindings` free-form strings | **Keep + label honestly** | Marked advisory; executable-vs-advisory split documented. Workflow execution is explicitly out of scope. |
| Surface bindings on `Operation` | **Keep, documented as override slots** | AIR owns the *named* surface; `cli/mcp/skill` are intentional override points, derived by the naming pass unless set. ADR-0001. |
| `Evidence` flat list + aggregate confidence | **Replace** | Done — claim-scoped (§4). |

## 2. Evidence (the flagship papered-over mechanism)

**Finding.** Evidence was modeled *twice* and neither was claim-scoped:

- `air.Evidence = { items: EvidenceItem[]; confidence: number }` — a flat list
  plus a **stored aggregate confidence** that no consumer could explain from its
  inputs.
- `harness/evidence.ts EvidenceGraph` rolled items into confidence via
  **noisy-OR**, while `harness/reconcile.ts` combined the *same* findings by a
  **max-reliability threshold**. Two combination rules over two representations
  of the same data. No subject/predicate/value, no provenance revision, no
  supersession, no per-claim review status.

This is exactly the "confidence number not attached to a specific claim" and
"evidence graph implemented as an unstructured list" the North Star calls out.

**Disposition: Replace.** Evidence is now **claim-scoped** — see §"Refactors".
The resolver `resolveSemantic(evidence, predicate)` is **conflict-aware**: it
returns `resolved` / `conflicted` / `insufficient`, weighted by source reliability
(`effectiveWeight = confidence × reliability`) and relation-aware
(supersession/contradiction). A near-tie contradiction is reported as
`conflicted` (a review signal) rather than a confident winner-by-0.02, and the
harness refuses to auto-loosen a contested safety-sensitive semantic
(`SAFETY_SENSITIVE_PREDICATES`). Claims about different predicates never
corroborate each other, so a strong `exists` cannot mask a weak
`idempotency.mode`. `confidenceFor`/`evidenceConfidence` remain as display-only
numbers and do not gate safety or approval.

## 3. Compiler pipeline

**Finding.** `compile()` is an honest linear composition:
`parse → normalize → resolveNameCollisions → enrich → validate →
discoverCapabilities → buildWorkflows`. `parse.ts` hard-branches Swagger vs
OpenAPI but delegates real parsing to `@scalar/openapi-parser` (correctly
library-maximal). There is **one** parser and **one** runtime target today.

**Disposition: Keep (do not fake a plugin framework).** Introducing
`SourceParser` / `CompilerPass` / `ArtifactGenerator` interfaces with a single
implementation each would be precisely the premature abstraction the North Star
forbids ("Do not add an interface because the architecture document says
plugin"). The real, minimal seam that matters — *adding a source format must not
touch classify/validate/generate* — is made explicit and **tested** (a parser is
selected by detected `SourceKind`; downstream passes are format-agnostic over
AIR). GraphQL/gRPC/WSDL remain **Deferred** with honest seams, not stubs.

## 4. Derived projections

**Finding.** The generated bundle physically duplicated the model: `air.json`
copied 4× (root, `cli/`, `mcp/`, `runtime/`), the catalog 3×, per-op schemas 3×,
skill embedded twice. Only `air.json` copies are load-bearing (each surface
loads its own); the rest are projections that must stay in lockstep.

| Mechanism | Disposition |
|---|---|
| `operationCatalog` / `compiledOperations` / `compiledSchemas` | **Keep** — genuine runtime projections. |
| 4× `air.json` copies | **Simplify** — the runtime server now loads the **compiled runtime manifest**, not raw AIR; residual copies documented. |
| `catalog.confidence` sourced from stored aggregate | **Replace** — now derived from claims. |

## 5. Runtime dependency graph

**Finding (good news, verified).** The serving path is already clean of the
build-time foundry. `@anvil/runtime` and `@anvil/mcp-runtime` import **only**
`@anvil/air` (model) — no `@anvil/compiler`, `@anvil/generators`, or
`@anvil/harness`. Almost all `@anvil/air` imports are `import type` (erased).

**Finding (hardening needed).** Fail-closed was gated on `env` (`ANVIL_ENV`,
default `"dev"`), but the executor fell back to `ctx.env ?? "dev"` — so an
`ExecuteContext` built without `env` silently got **dev** semantics in a prod
process: empty host allowlist permits any host, and the durable-ledger gate is
skipped.

| Mechanism | Disposition |
|---|---|
| Runtime imports only `@anvil/air` | **Keep** — now **enforced by a boundary test**. |
| `ctx.env ?? "dev"` fallback | **Replace** — unknown/undefined env now resolves to **production** (fail closed). |
| `buildMcpServer(air: AirDocument)` binds full AIR | **Simplify** — serves a compiled `RuntimeManifest`; raw AIR off the hot path. |
| `noopObserver` silently drops records | **Keep + documented** | opt-in observer is a deliberate seam; noted as a residual risk. |

## 6. GCP deployment

**Finding.** `generateDeploy` emitted **15 files with five owners for the same
settings** and undeployable placeholders:

- Image tag defined **3 incompatible ways** (`$SHORT_SHA` vs `air.version` vs
  `var.image_tag`).
- Env vars from **4 sources** (cloudbuild `--set-env-vars`, cloudrun yaml,
  terraform, overlays) that do not reconcile.
- `cloudrun.service.yaml` contained literal `PROJECT` / `REGION` placeholders and
  a hard-coded VPC connector — not deployable, and never applied by the README.
- `iam.plan.json` duplicated IAM that Terraform actually provisions.
- Three service-creation paths (`gcloud run deploy`, the knative yaml, terraform).

**Disposition: Delete + assign one owner per concern.**

| Concern | Owner (after) |
|---|---|
| Per-capability infra + runtime config (SA, Secret + IAM, ledger IAM, Cloud Run service, env vars, scaling) | **Terraform** |
| Build + push + **plan** | **Cloud Build** (builds the image, passes `image_tag`, runs `terraform plan` — never auto-apply) |
| Container | **Dockerfile** (prebuilt runtime, no in-image compiler build) |
| Env contract / secret contract | `env.schema.json`, `secrets.required.yaml` |
| Shared platform (Artifact Registry repo, TF state bucket) | **Prerequisites** — not generated (shared resources a capability must not own) |
| Capability Firestore field policies + ledger IAM | **Terraform** — shared database by default; optional dedicated database |
| Shared Firestore trust-domain database | **Platform prerequisite** — never imported into each capability state |

**Deleted:** `cloudrun.service.yaml`, `iam.plan.json`, `overlays/*.env.yaml`,
`artifact-metadata.json`. **Bootstrap fixes (round 2):** the Artifact Registry
repo is no longer *created* by the per-capability module (it is a shared
foundation, and creating it here made push depend on a not-yet-applied repo).
Each capability now gets an explicit Firestore database input, database-scoped
IAM, and a TTL policy for completed replay results. Shared mode uses a
platform-owned database per trust domain; dedicated mode creates a named,
delete-protected database. Terraform
declares a **GCS remote-state backend** (bound at `init`), and Cloud Build
produces a reviewable **plan** rather than `apply -auto-approve`, since a
capability deploy can change IAM/ingress/secrets. Boundary tests assert no two
emitted files set the same knob, no `PROJECT`/`REGION` literals survive, the
shared foundations are not recreated, ledger state is isolated, remote state is
configured, and the pipeline never auto-applies.

## 7. Generated package dependencies

**Finding (good).** The generated bundle's `package.json` already depends only on
runtime packages (`@anvil/air`, `@anvil/runtime`, `@anvil/mcp-runtime`,
`@anvil/cli`, MCP SDK) — never the compiler/generators/harness. The Dockerfile
installs `--prod` and never rebuilds Anvil packages. **Keep**, now enforced by a
test.

## 8. Harness and evidence

**Finding.** `HarnessAgent` is a real interface (one impl today: the heuristic
agent — a legitimate seam for an LLM agent). Provider specifics (GitHub, GitLab,
…) are correctly confined to `harness/profiles.ts`; no provider concept leaks
into `compiler` or `air`. The harness type-imports the compiler's manifest types
(`AnvilManifest`, `OperationManifest`) — a real coupling.

| Mechanism | Disposition |
|---|---|
| `HarnessAgent` interface | **Keep** — real seam. |
| Provider profiles table | **Keep** — closed set, honest. |
| `EvidenceGraph` noisy-OR ⊕ `reconcile` threshold | **Replace** — one claim-scoped reconciler (§4). |
| harness → compiler manifest types | **Keep, documented** — extraction to a shared `manifest-types` module is **Deferred** (low value now). |

## 9. Testing and conformance

**Finding.** 96 tests covered local behavior but **no architectural boundary**.
**Disposition: add boundary tests** — the dependency graph, deploy single-owner
invariant, claim reconciliation determinism, capability/workflow referential
integrity, and fail-closed production defaults are now asserted.

---

## Dependency graph — before / after

Runtime/serving path (unchanged, now **enforced**):

```
@anvil/air ── (only) ──▶ @anvil/runtime ──▶ @anvil/mcp-runtime
                                   ▲
                                   └── generated runtime server (compiled manifest, not raw AIR)
```

Build-time (unchanged shape):

```
@anvil/air ─▶ @anvil/compiler ─▶ @anvil/generators
        └────▶ @anvil/harness ─(type)-▶ @anvil/compiler(manifest types)
@anvil/cli ─▶ air, compiler, generators, harness, runtime, mcp-runtime
```

No new edges were introduced. Boundary tests now fail the build if the serving
path grows an edge into compiler/generators/harness.

---

## Refactors applied (summary; full list in the final report)

- **Claim-scoped evidence.** `air.Evidence` replaced by `Claim[]` with
  subject/predicate/value/source/method/confidence/reliability/relation/review.
  Aggregate confidence is a **pure derived function**; the dual noisy-OR/threshold
  logic collapses to one deterministic reconciler.
- **GCP deploy single-owner.** Deleted four contradictory/decorative artifacts;
  Terraform owns infra, Cloud Build owns build+apply.
- **Fail-closed production defaults.** Unknown/undefined runtime env resolves to
  production, not dev.
- **Dead ceremony removed.** `prefixNone` identity wrapper and the
  `void toYaml` placeholder deleted.
- **Boundary tests** encode the architecture as executable invariants.

## Intentionally deferred (no fake seams)

- **Full capability/workflow containment** (operations owned by capability rather
  than referenced by id) — referential integrity is tested; the structural move
  is deferred to avoid a large mechanical churn mid-refactor.
- **Executable workflow contract** — declarative only; execution is out of scope
  by mandate.
- **Compiler pass/parser plugin interfaces** — a single implementation each would
  be premature. Kept as honest linear composition with a tested format-agnostic
  boundary.
- **Minimal runtime `Operation` shape** — the serving path is already free of
  build-time deps; further trimming the bound `Operation` type is low residual
  value.
- **Incrementality** — not implemented; **no code or doc claims it exists**
  (false "Bazel-like"/"adapter-shaped" language removed).
- **Generated-CLI parser gaps** (arrays, aliases, stdin, `--`, unknown-flag
  errors) — documented; the parser stays small and schema-driven by design.

## Remaining architectural risks (top 5)

1. **Capability/workflow are still id-bags.** Referential integrity is tested but
   not structurally guaranteed; a rename can still desync arrays.
2. **Workflows are declarative only.** The bindings language is advisory; nothing
   validates that a binding path resolves.
3. **Runtime still binds the AIR `Operation` type** on the execute path (via the
   compiled manifest's structural subset) — a schema-shape coupling, not a
   dependency-graph leak.
4. **One parser in practice.** The format-agnostic boundary is tested, but until a
   second parser (GraphQL/gRPC) lands, the seam is unproven.
5. **Observer is opt-in.** A deployment that forgets to wire an observer drops
   execution records silently in any environment.
