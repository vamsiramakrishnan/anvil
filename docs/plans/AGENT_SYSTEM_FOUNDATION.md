# Agent System Foundation — implementation plan

> Compile any API estate (OpenAPI / Swagger / SaaS docs / existing MCP servers /
> WSO2 · MuleSoft · Kong · Apigee · IBM API Connect) into **certified agent
> capabilities**, without bypassing the customer's existing control plane.

This document reconciles the *Anvil foundation* programme with the code that
actually exists on `main` today, then sequences the work into independently
mergeable increments. It is the reconnaissance-and-reconciliation artifact the
programme requires before code changes; each increment section states its own
acceptance criteria, migrations, and deletions.

The canonical pipeline the programme targets:

```
SourceSnapshot → ContractSnapshot → PolicyOverlay → EffectiveContract
  → CapabilityContract → SurfaceSignature → AgentSystemPack → Certification
```

Commands and generated directories are **projections** over these artifacts, not
the model.

---

## 1. Current state (as reconciled against `main`)

Anvil today is a working spec-to-agent-tool compiler. What exists, mapped to the
programme's canonical objects:

| Programme object | Exists today? | Where |
| --- | --- | --- |
| `SourceSnapshot` (immutable, content-addressed source) | **Yes** | `@anvil/compiler/source` (`model.ts`, `store.ts`, `service.ts`, `import.ts`) |
| `CompilerSource` + `compileSource()` (one compiler input) | **Yes** | `@anvil/compiler/source/compiler-source.ts`, `compile.ts` |
| Normalized meaning (`AIR`) | **Yes** (`AirDocument`) — plays the ContractSnapshot role for AIR content | `@anvil/air/schema.ts` |
| Semantic overlays (`PolicyOverlay`) | **No — the current manifest is the only override channel** | `@anvil/compiler/manifest.ts` |
| `EffectiveContract` + conflict records | **Partial** — `resolveSemantic` + `SAFETY_SENSITIVE_PREDICATES` model conflicts at the *claim* level, but there is no contract-level overlay resolver | `@anvil/air/schema.ts` |
| Capability (`CapabilityContract`) | **Partial** — an AIR `Capability` node + discovery pass exist; no editable contract with intents/counterIntents/authProfile/safetyProfile/disclosure | `@anvil/compiler/capabilities.ts` |
| `DisclosurePlan` | **No** — progressive disclosure is generated ad hoc per surface | `@anvil/generators/{skill,resources,docs}.ts` |
| `SurfaceSignature` | **No** | — |
| `AgentSystemPack` | **No** — `@anvil/generators` emits directories, catalog + compiled manifests | `@anvil/generators` |
| `Certification` (static + executable) | **Partial/static** — file-presence + coherence checks | `@anvil/generators/certify.ts`, `@anvil/cli/commands/certify.ts` |
| Gateway adapters | **No** | — |
| Simulator | **No** | — |

### Key existing mechanisms to reuse (do not reinvent)

- **Evidence + claims** (`@anvil/air`): `Claim`, `Evidence`, `resolveSemantic`,
  `SAFETY_SENSITIVE_PREDICATES`, `CONFLICT_MARGIN`, `SOURCE_RELIABILITY`,
  `effectiveWeight`. Conflict-aware, reliability-weighted resolution of one
  `(subject, predicate)` already exists — the overlay resolver builds on it.
- **Asymmetric trust** (`@anvil/harness/reconcile.ts`): `LOOSEN_THRESHOLD 0.85`,
  `TIGHTEN_THRESHOLD 0.4`, safer-claim-wins. This is the policy the overlay
  resolver must honour for safety-sensitive predicates.
- **Canonical hashing** (`@anvil/air/hash.ts`): `hashCanonical`, `contractHash`.
  All new digests use these — no second canonicalizer.
- **Deterministic operation resolution** (`@anvil/air/resolve.ts`):
  `resolveOperation` — the one selector resolver; overlay targets reuse it.
- **Classifier coherence** (`@anvil/compiler/classify.ts`): `classifyRetry`,
  `classifyConfirmation` — the derive-then-override contract that keeps
  idempotency/retry/confirmation internally consistent after any mutation.
- **Manifest application** (`@anvil/compiler/manifest.ts`): `enrich`,
  `OperationManifest`. This is the current semantic-override *application*; the
  overlay layer keeps exactly one application path by projecting resolved
  overlays back through it.

### Increment 1 (SourceSnapshot as the only compiler input) is already satisfied

PR #10 (merged, head `9a82737`) made `compileSource(CompilerSource)` the single
compiler entry point, bound AIR provenance to the snapshot
(`service.source.{snapshotId,sourceHash,origin,entrypoint}`), resolved `$ref`s
from the snapshot VFS only, and rejected refs escaping the snapshot. Its P1
follow-up added the integrity gate: `SourceService.compilerSource()` runs
`verifySnapshot` and refuses a modified/missing/added/hash-mismatched snapshot
before binding bytes to the compiler. This plan's Increment 1 is therefore a
**verification-and-hardening** pass (add the remaining integrity tests), not new
architecture — see §4.

---

## 2. Target architecture

Ownership — one canonical owner per fact (unchanged from the programme):

| Fact | Owner |
| --- | --- |
| Imported bytes + provenance | `SourceSnapshot` |
| Normalized source meaning | `ContractSnapshot` (wraps `AirDocument`) |
| Gateway / operator / evidence refinements | `PolicyOverlay` |
| Effective callable semantics | `EffectiveContract` |
| Agent-facing business boundary | `CapabilityContract` |
| Cross-surface compatibility | `SurfaceSignature` |
| Artifact identity + bindings | `AgentSystemPack` |
| Pass/fail judgement | `CertificationRecord` |

Package direction (target):

```
air ─┬─ compiler ─┬─ generators
     ├─ runtime   ├─ refinement
     └─ system-pack └─ simulator
generators + runtime + simulator + system-pack ─ certification
all build-time packages ─ cli
```

Invariants enforced by architecture tests (added incrementally):

1. **One compiler path** — every source enters via `SourceSnapshot`; the
   compiler never rereads ambient files, never resolves a `$ref` outside the
   snapshot VFS, never compiles bytes other than those the snapshot digest names.
2. **Pure core, impure shell** — core packages take injected `Clock`,
   `Environment`, `ArtifactStore`, `HttpClient`, `ProcessRunner`,
   `CredentialResolver`; no direct `process.env`/`cwd`/`Date.now`/`console`/
   `node:fs`/`child_process`/network in core.
3. **Expected failures are data** — discriminated unions, not exceptions, for
   invalid source, unsupported format, unresolved dependency, semantic conflict,
   blocked capability, failed certification.
4. **Determinism** — timestamps never in content identity; stable sort;
   canonical JSON digests; unchanged inputs → byte-identical artifacts; every
   output records its input digests.
5. **Safety is asymmetric** — a later source may tighten a policy; it may not
   silently loosen auth/authz/confirmation/idempotency/retry/sensitive-data
   controls. Contested safety semantics stay conflicted or blocked.
6. **Thin adapters** — gateway adapters emit `SourceSnapshot + GatewayPolicyOverlay`
   only; no per-vendor compiler; no vendor type escapes the adapter package.

---

## 3. Increment sequence and dependencies

Each increment is independently mergeable, keeps `main` green, deletes any
superseded mechanism, adds architecture tests, and leaves a clean seam.

| # | Increment | Depends on | New canonical object | Deletes / subsumes |
| --- | --- | --- | --- | --- |
| 1 | SourceSnapshot = only compiler input | — | (done) `CompilerSource` | ambient path reads |
| 2 | ContractSnapshot + PolicyOverlay + EffectiveContract | 1 | `ContractSnapshot`, `PolicyOverlay`, `EffectiveContract` | manifest as an *independent* override channel |
| 3 | Gateway-neutral foundation (no vendor adapter) | 2 | `GatewayAdapter`, `GatewayApiImport`, `GatewayInventorySnapshot`, conformance | — |
| 4 | System pack + artifact graph | 2 | `AgentSystemPack` | ad-hoc directory identity |
| 5 | CapabilityContract + projection API + `DisclosurePlan` + `SurfaceSignature` | 2,4 | `CapabilityContract`, `DisclosurePlan`, `SurfaceSignature` | per-surface disclosure duplication |
| 6 | BYO MCP adoption | 2,5 | `McpSurfaceSnapshot` | — |
| 7 | Contract-faithful simulator (`@anvil/simulator`) | 5 | `SimulatorDefinition` | — |
| 8 | Executable certification (`@anvil/certification`) | 4,5,7 | `CertificationRecord` levels | "files exist ⇒ certified" |
| 9 | Gemini Enterprise target profile | 4,5,8 | `AgentPlatformTargetProfile` | scattered target checks |
| 10 | Offline gateway-adapter harness | 3 | `ArchiveReader`, evidence coordinates | — |
| 11 | Gateway adapters (Kong → WSO2/Apigee → MuleSoft → API Connect) | 3,10 | per-vendor adapters (thin) | — |
| 12 | Estate assessment + live drift | 3,11 | inventory/assess/drift | — |

Parallel hardening lane (may begin after Increment 2): sandboxed execution
backend + real investigator battery. It must not redesign the compiler or pack.

Deferred out of this programme: **gateway publication** (mutating a customer
gateway). When built it uses a separate `GatewayPublisher` with
desired-state → diff → reviewable plan → explicit approval → apply. `anvil build`
never mutates a gateway.

---

## 4. Increment 1 — verification & hardening (mostly done)

**State.** Satisfied by merged PR #10 + its P1 fix. `compileSource` is the one
entry; `compile({spec})` is a thin ephemeral-source wrapper; `agentify`/`sync`
compile the locked snapshot; AIR records snapshot provenance; the integrity gate
refuses a tampered snapshot.

**Gap closed here.** The P1 fix shipped only 1 of the 4 required integrity tests
(the "modified/tamper" case, at the CLI level). This increment adds the missing
service-level coverage so the invariant is executable at the boundary that owns
it (`SourceService.compilerSource`):

- modified raw file → compile refuses;
- missing raw file → compile refuses;
- added raw file → compile refuses;
- intact snapshot → compile succeeds.

No production code change; tests only.

---

## 5. Increment 2 — ContractSnapshot + PolicyOverlay + EffectiveContract

**Files.** `packages/compiler/src/contract/{model,overlay,resolution,conflicts,digest,snapshot,index}.ts`
plus `manifest-overlay.ts` (migration bridge) and tests.

**Canonical objects.**

- `ContractSnapshot` — `{ schemaVersion, id, digest, source{snapshotId,sourceHash,entrypoints}, air, appliedOverlays[], diagnostics }`.
  The digest covers source digest + normalized AIR + applied overlay digests +
  compiler implementation version + relevant config; excludes timestamps and
  render-only metadata.
- `PolicyOverlay` — `{ schemaVersion, id, origin, assertions[SemanticOverlayAssertion], evidence[], digest }`
  with `origin ∈ {manifest, gateway, investigation, operator, observed_traffic}`.
- `SemanticOverlayAssertion` — `{ target: SemanticTarget, predicate: SemanticPredicate, operation: set|restrict|remove|assert, value, evidenceRefs[] }`.
  Not raw JSON Patch: the mutation language is semantic, reusing AIR predicate
  coordinates (`idempotency.mode`, `confirmation.required`, `auth.scopes`, …).
- `EffectiveContractResult` — `{ status:"resolved", contract } | { status:"conflicted", partialContract, conflicts[SemanticConflict] }`.
  A `SemanticConflict` names target, predicate, competing values, per-value
  source/evidence/authority, whether it is safety-sensitive, and allowed
  resolution actions.

**Resolution policy (predicate-specific).**

- **Auth scopes** — restrictions combine (union; `remove` subtracts).
- **Confirmation** — `required` dominates `not_required` unless an authoritative
  overlay proves a safe loosening; contested → conflicted (safety-sensitive).
- **Retry on a mutation** — conflicting retry assertions → **blocked**.
- **Idempotency / effect.kind / auth.principal** — safety-sensitive; contested
  distinct values → conflicted (never a silent winner).
- **Non-safety predicates** (risk, action, display, description, …) — highest
  authority wins; equal-authority disagreement resolves deterministically (value
  sort) with a diagnostic.
- **Runtime coordinate replacement** (gateway route/server wins; backend stays in
  provenance) and **transformations** (deterministic → update schema; opaque →
  finding + no auto-cert): the *seam* is defined here; the gateway-origin
  resolvers land with Increment 3. Documented, not silently missing.

**Manifest migration (delete the second override channel).** The current
`AnvilManifest`/`enrich` stays as *authoring syntax* but is re-expressed as a
`PolicyOverlay` via `manifestToOverlay()`. Resolution (overlay engine) and
application (`applyOperationManifest`, extracted from `enrich`) are shared, so
there is exactly one resolution mechanism and one application mechanism — the
manifest is now just `origin:"manifest"`. Equivalence is proven by a test:
`compileContract(source, [manifestToOverlay(m)])` yields the same operation
semantics as `compile({spec, manifest:m})`.

**Determinism.** Overlays are sorted by `(origin-rank, id)`; assertions dedupe on
`(target, predicate, operation, canonical(value))`; the contract digest is
order-independent for commutative resolution.

**Tests.** deterministic overlay order · duplicate-equivalent dedupe ·
restrictions combine · safety loosening conflicts · tightening succeeds ·
evidence stays attached · identical digest for identical inputs · commutative
order-independence · manifest⇄overlay equivalence.

**Exit criteria.** The compiler produces one evidence-backed effective contract
from source + overlays, with conflicts as data. Manifest is no longer an
independent mechanism.

---

## 6. Increments 3–12 — summaries

These are planned in full in the programme; the per-increment acceptance criteria,
files, and library choices there are adopted verbatim. Highlights and the
reconciliation notes specific to this codebase:

- **3 · Gateway-neutral foundation.** `packages/compiler/src/gateway/`. Adapter
  emits `GatewayApiImport { source: SourceSnapshot; overlay: GatewayPolicyOverlay }`
  only. `GatewayAdapterCapabilities` makes partial support visible.
  `gatewayAdapterConformance(fixture, adapter)`. A fake fixture adapter proves the
  full pipeline. No vendor type escapes the package.
- **4 · `@anvil/system-pack`.** Build graph with input/output digests,
  path-sorted deterministic archive, `anvil pack inspect|verify|diff`,
  `anvil build --explain`. Prefer `ssri`/`cacache` over a bespoke cache; evaluate
  first.
- **5 · CapabilityContract + projections.** `ProjectionTarget` static registry
  (`mcp`, `cli`, `skill`, `simulator`, `gemini-enterprise`). Generators refactor
  to consume `CapabilityContract` + `DisclosurePlan`, emit `SurfaceSignature`, and
  write only through an `ArtifactWriter` (no fs/env). `diffSurfaceSignature` →
  compatible | additive | breaking | safety-sensitive.
- **6 · BYO MCP adoption.** `anvil mcp adopt|inspect|certify`, modes
  adopt/facade/replace, official MCP SDK, `McpSurfaceSnapshot` → capability
  proposal → the same pipeline.
- **7 · `@anvil/simulator`.** OpenAPI Backend + Ajv + XState + seeded Faker +
  fault profiles. Hard invariant: simulator `SurfaceSignature` == generated MCP
  `SurfaceSignature`.
- **8 · `@anvil/certification`.** `failed | static_passed | certified | expired`.
  Executable checks boot simulator + MCP, compare live schemas to signature,
  exercise CLI conformance, confirmation refusal, idempotent replay, fault
  injection, error normalization, skill-example replay, evals. Mutation tests
  must be killed. Testcontainers + `execa` (behind the process abstraction) +
  `p-limit`.
- **9 · Gemini Enterprise target.** Versioned `AgentPlatformTargetProfile`;
  verify against current official Google Cloud custom-MCP docs at implementation
  time; platform requirements never leak into AIR / capability contracts / pack
  identity.
- **10 · Offline gateway harness.** `packages/compiler/src/gateway/archive/`;
  zip-slip / traversal / symlink / size / depth defence; byte-preserving evidence
  coordinates. Pick one ZIP lib (fflate vs yauzl) after comparison; document it.
- **11 · Gateway adapters.** Kong → (WSO2|Apigee) → MuleSoft → IBM API Connect.
  Differential fixtures: equivalent logical API + equivalent policy → equivalent
  `EffectiveContract`.
- **12 · Estate assessment + live drift.** `anvil gateway connect|inventory|assess|import|sync`.
  Read-only by default, named credential profiles, no persisted secrets, bounded
  concurrency; drift invalidates only affected capabilities/certifications.

---

## 7. Migration & deletion plan

| When | Delete / replace | Replaced by |
| --- | --- | --- |
| Inc 2 | Manifest as an *independent* semantic-override path | `PolicyOverlay` (origin `manifest`) + shared `applyOperationManifest` |
| Inc 5 | Per-surface ad-hoc progressive disclosure | one `DisclosurePlan` consumed by all surfaces |
| Inc 5 | Generators reading fs/env directly | `ArtifactWriter` + pure projections |
| Inc 4 | Directory identity / catalog hash as the portable unit | `AgentSystemPack` digest graph |
| Inc 8 | File-presence "certification" | executable certification levels |
| Inc 2→3 | Any gateway-shaped assumption in overlays | gateway-origin resolvers behind the adapter seam |

Nothing is deleted before its replacement is green and tested. Compatibility
wrappers that would preserve *duplicate architecture* are explicitly disallowed;
thin syntax front-ends (manifest YAML → overlay) are allowed.

---

## 8. Risks & deferred work

- **Byte-identical AIR through the overlay path.** The manifest migration must
  not perturb the 561-test baseline. Mitigation: extract, don't rewrite, the
  application logic (`applyOperationManifest`), and prove equivalence with a test.
- **Overlay resolver scope creep.** Runtime-coordinate replacement and
  transformation resolvers genuinely belong with the gateway increment; defining
  the seam now and landing the resolvers in Inc 3 avoids Apigee-shaping the core.
- **Pure-core debt.** Generators currently touch fs; the `ArtifactWriter`
  refactor (Inc 5) is where that is paid down, not Inc 2.
- **Determinism regressions** are caught by digest-stability and
  order-independence property tests (fast-check adopted when Inc 2's tests need
  it; native loops suffice for the first pass).
- **Deferred:** gateway publication; live gateway connectors (after offline
  fixtures); LLM harness agents; incremental compilation; sandboxed execution
  backend (parallel lane).

---

## 9. Definition of done (programme-level)

All source forms enter one compiler path; gateway adapters are thin and
normalized; effective semantics preserve evidence and conflicts; capability
contracts are editable and reviewable; progressive disclosure has one owner; MCP,
CLI, skill and simulator share a surface signature; system packs are deterministic
and portable; certification executes the generated surfaces; BYO MCP adoption
works without forced regeneration; gateway inventories scale independently from
per-API compilation; downstream agents swap simulator/production bindings without
rewriting their business contract; no vendor-specific implementation leaks past
the adapter boundary.
