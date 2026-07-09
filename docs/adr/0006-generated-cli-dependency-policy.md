# ADR-0006 — Generated CLI dependency policy

**Status:** Accepted

## Context
The generated agent-adjacent CLI must stay tiny, inspectable, and zero-install —
size and cold start are product requirements. It must NOT be "fixed" by adopting
oclif or another framework for purity.

## Decision
- Keep the parsing core small and **schema-driven from one command projection**:
  the command tree is derived from each operation's `cli.command` string
  (`matchOperation`), and flags are projected from `op.input.params` + body
  fields. There is no separate command-metadata table for generated tools.
- The generated bundle's `package.json` depends **only on runtime packages**
  (`@anvil/air`, `@anvil/runtime`, `@anvil/mcp-runtime`, `@anvil/cli`, the MCP
  SDK) — never `@anvil/compiler`, `@anvil/generators`, or `@anvil/harness`. A
  boundary test enforces this.
- Do not hand-roll deep protocol/schema correctness: OpenAPI parsing, JSON Schema,
  and MCP protocol handling stay delegated to libraries. A small custom **arg
  parser** is acceptable because inspectability and zero-install win here.

## Consequences
- The generated CLI stays dependency-light and agent-native.
- Known parser gaps (arrays, aliases, stdin, `--`, unknown-flag errors) are
  documented as deferred, not silently missing — the parser remains small and
  schema-driven by design rather than growing into a framework.
