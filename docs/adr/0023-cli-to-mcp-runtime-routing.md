# ADR-0023 — The CLI routes through MCP, chosen per call at runtime

**Status:** Accepted

## Context
Anvil aligns three surfaces — skill, CLI, MCP — on one meaning. But a skill that
tells an agent to "use the CLI" and a platform that calls "the MCP tool" can still
execute along *different code paths* (the CLI hitting the upstream API directly,
the MCP server hitting it through the runtime hot path). Two paths are two places
for behaviour to drift: a retry guard, a confirmation gate, an idempotency key
applied in one and not the other. The surfaces agree on paper and diverge in
production.

The relationship we actually want is **skill → CLI → MCP**: the CLI is the
ergonomic front door, and it can *route through* an MCP server — the same safety
hot path the platform uses — rather than re-implementing execution. And whether
that MCP server is the local stdio one or a remote HTTP one should be a **runtime
choice**, made per call, not baked in at generation time.

## Decision
Give the generated tool-CLI two execution modes and let a per-call flag pick
between them (`packages/cli/src/tool-cli.ts`):

- **Direct** — the CLI executes the operation itself (the default).
- **Via MCP** — the CLI connects to an MCP server as a client and calls the tool,
  then re-renders the response through the *same* exit-code contract, so the user
  sees no difference except where the work ran.

The switch is `resolveMcpTarget(flags.mcp, env.ANVIL_MCP_TARGET)`:
- A per-call **`--mcp`** flag **wins** over the `ANVIL_MCP_TARGET` environment
  default, so the routing is genuinely a runtime choice, overridable per
  invocation.
- `direct` / `off` / `none` / empty force direct execution; a **bare `--mcp`**
  means `stdio`.
- `connectMcpClient` maps the target to a transport: **`stdio` / `local` ⇒
  `StdioClientTransport`** spawning the bundle's own sibling `mcp/server.js` (the
  "skill → CLI → MCP" loopback, wired at
  `packages/generators/src/entrypoints.ts`); **any other value ⇒
  `SSEClientTransport`** to that URL (an optional `sse:` prefix is stripped).

Routing through MCP reuses the reserved-argument contract: CLI safety flags map to
the synthesized `confirm` / `idempotency_key` inputs and `anvil_dry_run`, so a
confirmation gate or a non-idempotent-retry refusal fires identically whether the
CLI executed directly or over the tool. `anvil run <dir>` wires
`mcpServerPath = <dir>/mcp/server.js` so `--mcp stdio` targets that bundle's local
server; the harness `loopback` check drives every approved tool over the real
stdio MCP transport to prove the CLI and MCP surfaces receive identical logical
input (`cliFlagsFor` in `bundle-driver.ts` is the exact inverse of the flag→input
mapping).

## Consequences
- "The CLI and the MCP tool do the same thing" becomes testable and true by
  construction: with `--mcp`, the CLI *is* an MCP client of its own bundle.
- An operator can develop against a local stdio server and flip a single flag /
  env var to run the same command against a remote deployment — no regeneration.
- **Deferred / known nuances:**
  - The CLI's remote path speaks **SSE** (to `mcp/server-sse.js`), while the
    harness source path (`packages/harness/src/mcp-source.ts`) speaks
    **StreamableHTTP** for `kind:"http"` (to `runtime/server.js`'s `/mcp`). So the
    CLI's `--mcp <url>` does **not** currently talk to the Cloud Run StreamableHTTP
    endpoint; unifying the two remote dialects is future work.
  - The CLI's `--mcp <url>` constructs the SSE transport with **no auth headers**,
    so authenticated remote MCP calls from the CLI are not yet supported (the
    harness client path does forward headers).
