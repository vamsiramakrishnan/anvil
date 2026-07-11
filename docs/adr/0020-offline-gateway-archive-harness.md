# ADR-0020 — Offline gateway-import archive harness

**Status:** Accepted

## Context
Vendor gateway exports (Kong `deck` dumps, Apigee bundles, WSO2 CAR/ZIPs, MuleSoft
JARs, API Connect archives) arrive as archives full of **untrusted** paths and
bytes. Extracting them naively invites zip-slip (path traversal), symlink escape,
and decompression bombs. Every vendor adapter would otherwise re-implement these
defences — inconsistently. The safe-decode layer must exist and be proven before
any real vendor adapter reads a byte.

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

No gateway *semantics* live here — only safe decoding. A vendor adapter consumes
the normalized files and cites them with the gateway `EvidenceCoordinate` model.

## Consequences
- A vendor export can be decoded into safe, byte-preserving evidence files
  deterministically, with every hostile construct refused and reported.
- The next increment (Kong) and every later vendor adapter build on this one
  harness instead of re-deriving traversal defence.
- **Deferred:** wiring the real `fflate` ZIP backend and format sniffing at the
  shell; large-archive streaming; per-vendor decoders (tar, JAR) as thin
  `ArchiveDecoder`s.
