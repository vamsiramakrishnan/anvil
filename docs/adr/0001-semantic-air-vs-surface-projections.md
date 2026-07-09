# ADR-0001 — Semantic AIR vs. surface projections

**Status:** Accepted

## Context
AIR is the single canonical model. Generators need per-surface bindings (a CLI
command string, an MCP tool name, skill intent phrases). The risk is that these
generator-facing strings become co-equal semantics stored redundantly, so a
rename in one place silently desyncs the others.

## Decision
AIR **owns semantics**; surfaces are **projections**. The naming pass derives the
canonical name and the CLI/MCP/skill bindings from that one name. The binding
fields (`cli.command`, `mcp.toolName`, `skill.intentExamples`) remain on the
operation, but only as **intentional override slots** — set when a human
deliberately overrides the derived surface, otherwise computed. Compiled runtime
projections (`operations.manifest.json`, `schemas.compiled.json`) are derived
views, not second sources of truth.

## Consequences
- One naming pass, one projection; no per-command metadata table to keep in sync.
- Deferred: physically *removing* the binding fields from the semantic operation
  in favour of a separate projection object. Referential coherence is tested; the
  structural move is not yet done (see remaining risks in the audit).
