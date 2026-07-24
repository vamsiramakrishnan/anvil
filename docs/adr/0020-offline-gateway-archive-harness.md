# ADR-0020 — Offline gateway-import archive harness

**Status:** Accepted

## Context
Vendor gateway exports (Kong `deck` dumps, Apigee bundles, WSO2 per-API ZIPs,
MuleSoft JARs, API Connect archives) arrive as containers full of **untrusted**
paths and bytes. WSO2 bulk export also arrives as a filesystem directory
containing hundreds or thousands of those archives. Extracting or traversing
them naively invites zip-slip, symlink escape, special-node reads, and
decompression bombs. Every vendor adapter would otherwise re-implement these
defences inconsistently. The safe-decode layer must exist and be proven before
any adapter reads semantic input.

## Decision
Add `packages/compiler/src/gateway/archive` — a format-agnostic security
normalizer over a pluggable decoder.

- **`ArchiveDecoder`** decodes a container's bytes into raw `ArchiveEntry`s. The
  format backend (a real ZIP lib — **fflate**, chosen for streaming support, no
  native deps, and ESM) is the composition shell; an `InMemoryArchiveDecoder`
  drives tests, including deliberately hostile entries.

- **`normalizeArchive`** applies the full battery, in order: reject absolute paths,
  `..` traversal, backslash separators, and NUL; reject symlinks outright; enforce
  `maxFileBytes`, `maxDepth`, `maxFiles`, and cumulative `maxExpandedBytes`; and
  detect conflicting duplicate paths (identical content dedupes, different content
  is refused). It returns **byte-preserving** `NormalizedFile`s plus diagnostics —
  a rejected entry never reaches an adapter, and the reason is always reported
  (silent truncation would read as "we imported everything" when we did not).

- **`decodeArchiveText`** decodes UTF-8 with `fatal: true`, so an invalid encoding
  is a typed refusal, not mangled text.

- The WSO2 CLI shell extends that posture to a native apictl collection
  directory: deterministic lexical traversal; no symlinks or special nodes;
  safe relative POSIX paths; depth, file-count, per-file, and cumulative-byte
  limits; then the same ZIP battery for every per-API archive. It accepts
  sibling per-API ZIPs, extracted per-API project directories, or both.
  Collection traversal allows at most 100,000 filesystem and expanded-member
  records, 25 MiB per filesystem file, 200 MiB combined raw and expanded bytes,
  and depth 32. Every nested ZIP separately retains the generic 10,000-member,
  25 MiB/member, 200 MiB-expanded, depth-32 battery.

- A directory is stored in the immutable receipt as a deterministic
  path-and-byte envelope. Host paths, mtimes, ownership, and enumeration order
  do not affect the digest. The collection, each per-API ZIP or extracted
  project, and every accepted member receive separate content-addressed
  evidence records with parent lineage.

No gateway *semantics* live in the generic archive layer. A vendor adapter
consumes normalized files and cites them with `EvidenceCoordinate`; the WSO2
collection shell classifies only structural artifact roles before its adapter
interprets `api.yaml`.

## Consequences
- A vendor export can be decoded into safe, byte-preserving evidence files
  deterministically, with every hostile construct refused and reported.
- Kong and every later archive-backed adapter build on this harness instead of
  re-deriving traversal defence. The CLI shell uses the real `fflate` ZIP
  backend and refuses tar/gzip by name until a bounded decoder exists.
- A real WSO2 `apictl export apis` directory can be inventoried without
  flattening per-API projects or discarding their evidence boundary.
- **Deferred:** large-archive streaming and bounded tar/gzip decoders. A CAR,
  proxy XML tree, or JAR becoming safely readable does not make its behavior
  semantically understood; that remains the vendor adapter's responsibility.
