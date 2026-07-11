# ADR-0016 — BYO MCP adoption

**Status:** Accepted

## Context
Many teams already run an MCP server (their own or a SaaS provider's). Anvil's
value for them is not to make them regenerate that server — it is to wrap it in
the same certified capability contract, aligned CLI/skill/simulator, and portable
pack that Anvil produces from a spec. So an existing MCP server must be a
first-class **source**, not a special case.

## Decision
Add `@anvil/compiler/adopt`: capture an MCP server's live surface, bridge it into
AIR, and flow it through the one capability/signature/pack pipeline.

- **`McpSurfaceSnapshot`** — the immutable, content-addressed capture of a server's
  public surface: negotiated protocol version, server metadata + capabilities,
  transport, tools (name/description/inputSchema/annotations), resources, and
  prompts. Its digest excludes the endpoint address, so the same surface at two
  URLs is the same snapshot.

- **`McpProbe`** — the impure edge (it talks to a server) is an injected
  interface. A deterministic `FakeMcpProbe` drives the whole pipeline offline in
  tests; the real MCP-SDK-backed probe (StreamableHTTP/stdio) is the
  composition-shell implementation of the same interface.

- **Validation is a gate** (`buildMcpSurfaceSnapshot`): a non-object tool schema,
  duplicate tool names, an empty tool list, or a tool count over an agent-selection
  budget are refusals returned as diagnostics — not silently accepted.

- **AIR bridge** (`airFromMcpSurface`): each tool becomes one AIR operation whose
  `mcp.toolName` is the adopted name verbatim, so a `SurfaceSignature` derived from
  this AIR matches the provider's surface and any generated CLI/skill references
  exactly the adopted tools. Safety is inferred **conservatively** from MCP tool
  annotations — absent `readOnlyHint`, a tool is a non-idempotent mutation
  (confirm, never auto-retry). Operations are `generated`, preserving Anvil's
  approval gate for a BYO server.

- **Explicit modes** decide what is generated, never guessed:
  `adopt` (reference the provider endpoint — **no server is regenerated**),
  `facade` (Anvil policy/runtime controls in front of the provider), `replace`
  (generate a fresh MCP from the upstream API — which that mode additionally
  requires). `planAdoption` encodes this; only `replace` sets `regenerateServer`.

- **`diffMcpSurface`** detects server drift (added/removed/changed tools, protocol
  change) between two captures.

## Consequences
- An existing third-party MCP becomes an Anvil-certified pack (contract →
  capability → signature → CLI/skill/simulator/pack) without replacing the
  provider server — the "federated third-party connector foundry" use case.
- `SourceKind` gains `mcp` so AIR provenance records a captured server surface.
- **Deferred:** the real MCP-SDK probe and the `anvil mcp adopt|inspect|certify`
  CLI verbs are the composition-shell wiring; `replace` mode's upstream-API
  regeneration reuses the existing compiler once an OpenAPI source is supplied.
