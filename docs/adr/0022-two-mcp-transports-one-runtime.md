# ADR-0022 — Two MCP transports over one serving core

**Status:** Accepted

## Context
A generated MCP server has to run in two very different places: on a developer's
machine, spoken to over stdio by a local agent (Claude Code, an IDE), and in the
cloud, reached over HTTP by a remote agent platform. These have opposite
lifecycles — a stdio server is a child process with one implicit session; a
remote server is a long-lived listener multiplexing many. If each transport grew
its own tool-registration and safety logic, the surface an agent sees would drift
between "local" and "remote" — the exact drift Anvil exists to prevent.

## Decision
Keep **one transport-agnostic serving core** and wrap it in **per-transport
entrypoints** generated into every bundle. The core registers tools once; the
transport is only how bytes arrive.

- **The core** is `buildMcpServer(air, options)` in `@anvil/mcp-runtime`
  (`packages/mcp-runtime/src/server.ts`). It registers one MCP tool per
  *approved* operation, carrying risk/effect in `annotations` + `_meta`, plus the
  precomputed resources. `@anvil/mcp-runtime` is the thin deployed unit — it never
  imports `@anvil/generators`, so the hot path stays small.

- **The build-time foundry** (`@anvil/generators`) emits three entrypoints from
  that one core (`packages/generators/src/bundle.ts`):
  - `mcp/server.js` — **local, stdio** (`generateMcpServerSource`,
    `StdioServerTransport`). What a local agent spawns.
  - `mcp/server-sse.js` — **remote, HTTP + SSE** (`generateMcpSseServerSource`):
    `GET /sse` streams, `POST /messages?sessionId=…` receives, one transport per
    session, plus `/healthz` / `/readyz`.
  - `runtime/server.js` — the **stateless StreamableHTTP** Cloud Run server
    (`generateRuntimeServer`, `StreamableHTTPServerTransport` with no session id),
    serving `/mcp`, `/healthz`, `/readyz`, `/metrics`, `/openapi`.

- **The transport is expressed by which file you run**, not by a runtime enum in
  the core. `package.json` scripts make the two poles explicit: `mcp` =
  `node mcp/server.js` (local), `start` = `node runtime/server.js` (remote). The
  only `kind: "stdio" | "http"` discriminator lives on the *client/source* side
  (see ADR-0023), never in the served tool surface.

Because all three wrap `buildMcpServer`, the set of exposed tools, their
annotations, and the approval gate are byte-identical across transports. Moving
from a laptop to Cloud Run changes the socket, not the contract.

## Consequences
- One bundle ships both a local and a remote server with a single source of truth
  for what an operation *is*; a reviewer approves once, for every transport.
- The deployed unit stays minimal — the transport wrappers are generated code in
  the bundle, not weight in `@anvil/mcp-runtime`.
- **Deferred:**
  - `anvil serve mcp` boots the **stdio** server only
    (`packages/cli/src/commands/serve.ts`). The SSE and StreamableHTTP servers are
    run out-of-band (`node runtime/server.js`, the container `CMD`, or `npm
    start`) — there is no `anvil serve` subcommand for them yet.
  - The SSE server notes but does not implement session-affinity / sticky routing
    for horizontal scaling, and generates no auth layer of its own (auth is the
    platform's or gateway's responsibility, per ADR-0019).
