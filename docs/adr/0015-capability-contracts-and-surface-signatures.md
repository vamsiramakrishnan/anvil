# ADR-0015 — Capability contracts, disclosure plans, and surface signatures

**Status:** Accepted

## Context
Agents reason about business capabilities ("Refunds"), not URLs. AIR already has a
`Capability` node, but three problems remained: (1) the grouping was
take-it-or-leave-it — moving one operation between capabilities meant editing AIR
or generated files; (2) progressive disclosure was re-derived ad hoc in each
generator (CLI help, MCP resources, skill references), so the three could drift;
(3) there was no cross-surface compatibility fingerprint, so "does the simulator
match production?" or "is this change breaking?" had no single answer.

## Decision
Add an agent-facing layer over the effective contract (`@anvil/compiler/capability`):

- **`CapabilityContract`** — the reviewable business boundary. Its membership is
  the one thing a reviewer edits; `authProfile`, `safetyProfile`, `disclosure`,
  and `digest` all *derive* from the member operations, so the same AIR always
  yields the same contract. `editCapabilityContract` / `moveOperation` apply
  declarative edits (include/exclude/intents/counterIntents/owner/…) **without
  touching AIR or generated files** — moving one operation is a one-call edit.

- **`DisclosurePlan`** — the single owner of progressive disclosure. `overview`,
  `operation`, `schema`, `examples`, `errors`, `policy`, and `procedure` nodes
  each carry a surface-neutral `contentRef`; the CLI (`--help`/`--schema`/…), MCP
  (concise tools + detailed resources), and skill (SKILL.md + reference files) all
  resolve the same nodes, so disclosure cannot drift between surfaces.

- **`SurfaceSignature`** — the compatibility fingerprint, derived from the
  *contract* (AIR operations), not any one surface. Each operation contributes
  `publicName` + digests for input/output/error schema, effect (the safety
  posture: effect + idempotency + retries + confirmation), and auth. Because the
  input digest hashes `operationInputSchema` — the shape the MCP tool `inputSchema`,
  `cli --schema`, and the skill already share — an MCP server, CLI, skill, and
  simulator that project the same operations produce the **same** signature.

- **`diffSurfaceSignature`** classifies a change as `compatible` | `additive` |
  `breaking` | `safety-sensitive` (worst-wins). Auth/effect changes are
  safety-sensitive; input-schema/public-name changes are breaking;
  output/error widening is additive.

Only `approved` operations enter a signature or disclosure plan — an unapproved
op is on no public surface, so it must not appear in either.

## Consequences
- CLI, MCP, skill, and simulator share one capability contract and one signature;
  compatibility and simulator/production parity are single digest comparisons.
- Reviewers reshape capabilities declaratively; the safety profile recomputes.
- This layer lives in `@anvil/compiler` (capability compilation) so both
  `@anvil/generators` and `@anvil/simulator` (each depends on the compiler) can
  import the signature without a cycle; `@anvil/system-pack` references it by
  digest (`SurfaceSignatureRef`).
- **Deferred:** migrating the existing MCP/CLI/skill generators to *consume* the
  `DisclosurePlan` and *emit* the `SurfaceSignature` through an `ArtifactWriter`
  (pure projections, no fs/env) is a mechanical follow-up; the signature is
  already the shared fingerprint and is proven to match the MCP tool surface by
  test, so the parity invariant is executable now.
