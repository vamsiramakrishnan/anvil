# ADR-0014 — The Agent System Pack and content-addressed artifact graph

**Status:** Accepted

## Context
Anvil emits many artifacts per capability — an MCP server, a CLI, a skill, a
simulator, target-platform kits, docs. Until now the portable unit was a
directory tree plus a catalog hash. That makes it hard to: verify a delivered
bundle has not been tampered with; explain what a rebuild will and will not
regenerate; diff two builds semantically; and hand a downstream agent platform
*one* thing it can trust. A directory is not an identity.

## Decision
Introduce `@anvil/system-pack`: the **Agent System Pack** is the portable,
content-addressed result of Anvil.

- **`AgentSystemPack`** binds a contract ref, capability refs, a surface-signature
  ref (Increment 5), an `ArtifactManifest`, bindings, and target kits under one
  **pack digest**. Every artifact carries a `contentDigest`; every `BuildNode`
  records the `inputDigests`, `implementationVersion`, and `configurationDigest`
  it was produced from. Identity is a pure function of content — timestamps and
  render-only metadata never feed a digest, so the same canonical inputs produce a
  byte-identical pack and archive.

- **`assembleSystemPack`** builds a pack from already-produced artifact bytes plus
  their build provenance. The package depends **only on `@anvil/air`** — never on
  the compiler or generators. A pack is assembled from outputs, not by running the
  build, which keeps the dependency direction clean (generators/runtime/simulator/
  system-pack all feed certification; none imports another's build).

- **Deterministic archive** (`archivePack`) is a canonical, path-sorted,
  self-contained envelope whose digest is its identity. A physical container
  (tar/zip via a streaming lib) can back it later without changing identity.

- **`verifyPack`** recomputes every digest from content and fails closed on a
  tampered artifact, a swapped file, a mismatched manifest, or a bad path —
  findings as data.

- **`explainRebuild`** (the data behind `anvil build --explain`) keys entirely on
  each build node's signature, so an unrelated projection stays cached: editing
  the skill never rebuilds the MCP; tightening auth rebuilds only the nodes that
  list the auth digest as an input.

- **`diffPacks`** reports what actually changed (artifacts by id/digest, contract,
  capabilities, bindings, targets) — a semantic diff, not a line diff.

- **`ArtifactStore`** is the content-addressed storage seam. An in-memory store
  ships; a durable backend (`cacache`) plugs in at a composition boundary without
  changing pack identity. The core never invents a cache database.

**Certification is excluded from the pack digest.** A certification record
references the pack digest, so folding it into the pack's own identity would make
the record circularly invalidate the pack. Attaching or removing certification
never changes pack identity.

## Consequences
- A pack is a single verifiable, diffable, portable unit for downstream agent
  tooling, with an executable determinism/verification contract.
- Incremental rebuild is explainable and does not over-invalidate.
- **Deferred:** the CLI verbs (`anvil pack inspect|verify|diff`, `anvil build
  --explain`) wire these library functions at the composition shell; the durable
  `cacache`/`ssri` backing store lands with that wiring; a formal architecture
  test enforcing the package dependency direction is a cross-cutting follow-up
  (the direction is currently enforced by `package.json` dependencies).
