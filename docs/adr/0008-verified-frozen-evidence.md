# ADR-0008 — Verified, frozen evidence artifacts

**Status:** Accepted

## Context
An investigation grounds every claim in evidence. The early
`EvidenceArtifact` shape (`case/model.ts`) let the agent supply
`{ uri, span?, excerpt?, relevance, source }` directly — the agent both located
the evidence *and* wrote down what it said. That trusts an agent-provided
`path + span + excerpt` triple as authoritative. An agent (or an untrusted page
it read) could then assert an excerpt that the file does not actually contain, or
cite a line range outside the file, and the downstream claim would inherit that
fabricated support. Evidence that the agent can author is not evidence.

## Decision
Evidence is ingested by **source coordinate**, not by content. The agent supplies
only a locator: `{ repositoryRevision?, path, startLine?, endLine? }`. Anvil then,
deterministically:

1. **verifies scope** — the path is within an allowed inspect scope (see the case
   policy) and resolves inside the repo; out-of-scope paths are refused;
2. **reads the exact bytes** at that path (at `repositoryRevision` when pinned);
3. **validates the line range** against the file's real length;
4. **computes a content hash** over the excerpted bytes;
5. **stores an immutable `EvidenceArtifact`**:
   `{ id, uri, source, revision?, contentHash, excerpt, acquiredAt }`.

The `excerpt` is the bytes Anvil read — the agent cannot supply an authoritative
excerpt separately from the verified source. Claims reference **frozen artifact
ids**; a claim's support is the artifact it points at, and that artifact's content
is fixed at acquisition time. Re-reading the same coordinate later can produce a
*new* artifact (with a new hash) if the file changed, but existing artifacts are
never mutated in place.

Non-filesystem sources reuse the **same canonical artifact shape**. A GitHub or
Confluence hit acquired over MCP is verified by its own connector, hashed, and
stored as the identical `{ id, uri, source, revision?, contentHash, excerpt,
acquiredAt }` record — so claim grounding is uniform regardless of origin and the
model is ready for those sources without a second evidence type.

## Consequences
- A claim's excerpt provably matches bytes Anvil itself read; the agent's role is
  to *locate* and *interpret*, never to *assert content*.
- `contentHash` makes evidence tamper-evident and lets a reviewer confirm nothing
  shifted between acquisition and reconciliation.
- Scope enforcement at ingest is a defence boundary: an investigation cannot cite
  files outside the paths its case permits.
- Cost: every piece of evidence requires a real read + hash at ingest; there is no
  fast path for "trust me." This is deliberate — see the asymmetric-trust rule in
  `docs/ARCHITECTURE.md` and reconciliation in ADR-0002.

## Alternatives considered
- **Trust an agent-provided path + span + excerpt.** Rejected: the excerpt is
  unverifiable and forgeable, so it grounds nothing; it is the core failure this
  ADR closes.
- **A separate evidence type per source kind (file vs. GitHub vs. wiki).**
  Rejected: it forks reconciliation and claim-grounding logic; one canonical
  artifact shape keeps the trust model uniform. See
  `docs/INVESTIGATION_ARCHITECTURE.md`.
