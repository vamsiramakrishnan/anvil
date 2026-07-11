# ADR-0012 — Contract snapshots and semantic overlays

**Status:** Accepted

## Context
A compiled `AirDocument` was the end of the compiler's authority: the only way to
refine it after normalization/classification was the supplemental **Anvil
manifest**, applied by `enrich` inside `compileSource`. That worked for a single
operator-authored override channel, but the product needs many sources to refine
the same contract — gateway policy, operator configuration, investigation
findings, observed traffic — and to combine them *safely*. A last-write-wins
manifest cannot:

- combine restrictions (two sources each requiring a scope);
- distinguish a tightening (always cheap) from a loosening (needs authority);
- record a contradiction as data instead of silently picking a winner;
- give the refinement a content identity so a build can be cached on it.

Adding a second override mechanism per source would fork the semantics and let a
later source silently loosen a safety control — exactly the failure Anvil exists
to prevent.

## Decision
Introduce a **contract layer** (`@anvil/compiler/contract`) with one refinement
model and one resolution engine.

- **`PolicyOverlay`** is the single refinement channel. It carries
  `SemanticOverlayAssertion`s — `{ target, predicate, operation, value,
  evidenceRefs }` — where `predicate` is an AIR semantic coordinate
  (`idempotency.mode`, `confirmation.required`, `auth.scopes`, …) and `operation`
  is `set | restrict | remove | assert`. The mutation language is **semantic**,
  never raw JSON Patch, so restrictions combine and contradictions are detectable.
  Overlay origin ∈ `{manifest, gateway, investigation, operator, observed_traffic}`.

- **Resolution** (`resolveOverlays`) resolves each `(operation, predicate)` to one
  effective value with predicate-specific rules: auth scopes union under
  `restrict`; safety booleans move to the safer pole; a loosening of a
  safety-sensitive predicate requires an authoritative origin (operator / manifest
  / gateway) or evidence ≥ `0.85`, else the safer base wins; contradictory `set`s
  on a safety-sensitive predicate become a `SemanticConflict`; a contested retry
  posture on a mutation **blocks** the operation. Resolution is deterministic and
  order-independent (assertions are canonically keyed and deduped).

- **`ContractSnapshot`** wraps the effective `AirDocument`, the applied overlay
  identities, and a content **digest** covering source digest + effective AIR
  (via `contractHash`) + applied overlay digests + compiler version — excluding
  timestamps and render-only metadata. Same source + same overlays → identical
  digest.

- **`compileContract(source, overlays, options)`** returns an
  `EffectiveContractResult`: `resolved` when no safety-sensitive semantic is
  contested, else `conflicted` with a partial contract that still carries the
  safer value for each contested predicate.

**The manifest is migrated, not duplicated.** `manifestToOverlay` re-expresses an
Anvil manifest as an `origin:"manifest"` overlay, and overlays are applied at the
same pipeline slot `enrich` used, through the same application function
(`applyOperationManifest`). There is exactly one resolution mechanism and one
application mechanism; the manifest is now authoring syntax over the overlay model.
`compileSource({ manifest })` remains as a convenience for callers that have not
migrated and is proven equivalent to the overlay path by test.

## Consequences
- A single evidence-backed effective contract can be built from any mix of
  sources, with safety asymmetry enforced and conflicts surfaced as data.
- Overlays and contract snapshots are content-addressed, which the Agent System
  Pack (a later increment) will key its build graph on.
- **Deferred:** runtime-coordinate replacement (gateway route/server wins, backend
  stays in provenance) and transformation resolvers (deterministic → update
  schema; opaque → finding) are defined as the gateway-overlay seam and land with
  the gateway-neutral foundation increment, so the resolver is not shaped by one
  vendor. Service/capability-scope resolution beyond `auth.scopes` is likewise
  staged. `applyOperationManifest` still stamps a manifest-flavoured evidence
  claim for any overlay origin; per-origin provenance on applied assertions is a
  follow-up.
