# ADR-0004 — Minimal runtime document

**Status:** Accepted (with a scoped deferral)

## Context
The Cloud Run serving path must not drag in the build-time foundry, and should
not carry more of AIR than execution needs.

## Decision & current state
- **Dependency boundary (done + enforced).** `@anvil/runtime` and
  `@anvil/mcp-runtime` import **only** `@anvil/air` — never `@anvil/compiler`,
  `@anvil/generators`, or `@anvil/harness`. A boundary test
  (`packages/cli/src/architecture.test.ts`) fails the build if that edge ever
  appears, and asserts the same for the *declared* dependencies.
- **Compiled projections (done).** The generator emits `operations.manifest.json`,
  `schemas.compiled.json`, and `errors.compiled.json` — minimal projections with
  no descriptions, examples, or provenance — and only approved operations are
  compiled in.
- **Deferred, honestly.** `buildMcpServer` still binds the full AIR `Operation`
  type on the execute path. This is a *type-shape* coupling, not a
  dependency-graph leak (the serving packages already pull in nothing from the
  foundry). Trimming the bound `Operation` to a dedicated `RuntimeOperation` type
  is low residual value and is listed as a remaining risk rather than done with a
  fake seam.

## Consequences
- Cold-start-sensitive imports on the serving path are already minimal and
  guarded by tests.
- The residual (full `Operation` shape at runtime) is documented, not hidden.
