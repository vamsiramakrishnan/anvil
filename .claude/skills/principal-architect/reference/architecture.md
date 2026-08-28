# Architecture map

## AIR is the one canonical model — everything else is a projection

`@anvil/air` defines `AirDocument`: `service`, `operations[]`, `capabilities[]`,
`workflows[]`. An `Operation` carries everything needed to generate all three
agent-facing surfaces from one place: `effect` (mutation/read + risk),
`idempotency`, `retries`, `confirmation`, `auth`, `pagination`, plus the
`cli`/`mcp`/`skill` binding blocks. This is the whole point of the product —
grep `packages/air/src/schema.ts` before assuming a field doesn't exist; it
usually does, just not populated by the current pipeline stage you're looking
at (e.g. `pagination` is a real typed field long before anything infers it
from a spec).

## The compile → operate loop (in order)

```
anvil source add        lock an API spec as an immutable, content-addressed snapshot
anvil compile            spec -> AIR (parse/normalize/classify/validate)
anvil status/inspect/lint  see what compiled, its safety posture, diagnostics
anvil approve             mark specific operations exposable (nothing is live by default)
anvil certify/selftest/conformance/simulate   static + executable assurance gates
anvil publish              gated deployment plan (no cloud calls)
anvil refine / enrich / capability compose     ongoing quality loop, all propose-only
```

Every one of these is a separate CLI command with its own package behind it —
there is no single "god function." If a review touches more than one stage,
name every package it touches; don't say "the pipeline."

## The 12 packages, precisely

Core compile/serve path:
- **`@anvil/air`** — the IR itself: schema, enums, evidence/claim model,
  `resolveIdempotencyCarrier` (the one place idempotency carrier validity is
  computed — refinement's validation reuses this directly rather than
  reimplementing it, on purpose).
- **`@anvil/compiler`** — parse/normalize/classify/validate a spec into AIR.
  Also owns `manifest.ts` (the `AnvilManifest`/`OperationManifest`/
  `WorkflowManifest` shapes a human or the harness writes to patch AIR) and
  `buildWorkflows` (manifest workflow entries -> real `Workflow[]`).
- **`@anvil/runtime`** — the safety hot path: what actually gates a live call
  (confirmation, idempotency key handling, retry policy enforcement).
- **`@anvil/mcp-runtime`** — the thin MCP serving path; the actual deployed
  unit. One tool per `Operation`, plus approved `Workflow`s registered as
  composite tools (`server.ts` — an earlier version of this doc claimed no
  server-side orchestration existed, which had gone stale; verify here before
  citing).
- **`@anvil/generators`** — the build-time artifact foundry: turns AIR into
  the CLI, MCP server, skill docs, mocks, schemas.
- **`@anvil/cli`** — the `anvil` command itself + the shared tool-CLI engine
  every generated bundle's own CLI is built from.

Eval, enrich, and deploy-target packages:
- **`@anvil/refinement`** — deterministic deficiency detection over AIR
  (`detect.ts`), the typed skill contracts and their heuristic/case
  executors, deterministic proposal validation, and the asymmetric-trust
  approval policy. This is where "the agent stopped guessing" gets enforced
  for AIR's own documentation/safety-classification quality.
- **`@anvil/harness`** — two distinct jobs living in one package: (a)
  conformance/live-evidence checks against an already-deployed MCP server,
  and (b) `enrich.ts` — Anvil as an MCP *client*, connecting to published
  GitHub/GitLab/Confluence/Notion/Postman MCP servers to gather real
  external evidence and propose a manifest patch. Never mutates AIR itself.
- **`@anvil/simulator`** — a contract-faithful, deterministic capability
  simulator (drives the safety matrix without hitting a real backend).
- **`@anvil/certification`** — static + executable certification checks over
  a finished bundle.
- **`@anvil/system-pack`** — the portable, content-addressed artifact graph
  Anvil emits (what actually ships).
- **`@anvil/targets`** — versioned agent-platform target profiles + kit
  generation (e.g. Gemini Enterprise).

## Where cross-cutting concerns actually live

- **Capability composition** (finding overlap across *different* compiled
  bundles/services) lives in `packages/cli/src/capability-composition.ts` —
  it is CLI-package code, not a separate compositional package, because it's
  a read-only audit over already-generated bundle directories, not a
  compile-time concern.
- **Gateway vendor import** (Apigee/Kong/WSO2/MuleSoft/APIConnect/etc.) lives
  under `packages/compiler/src/gateway/`, sharing `coordinate.ts`'s
  `axisMatches`/`axisMatchesAny` for the "missing field = wildcard match"
  matching rule every vendor adapter needs — this used to be reimplemented
  per-adapter and produced the same bug three times before extraction.
