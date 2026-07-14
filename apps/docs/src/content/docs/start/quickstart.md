---
title: Quickstart
description: Build, then drive Anvil — compile a spec into an aligned CLI + MCP + skill + hooks bundle, inspect risk, and approve operations.
sidebar:
  order: 2
---

This is the short path from a raw API spec to an aligned bundle you can inspect,
approve, and deploy. The working loop is five steps:

> **compile → inspect → enrich → approve → deploy**

Every command below is exact. Replace `<spec>`, `<manifest>`, and `<service>`
with your own values.

## 1. Build the toolchain

```bash
pnpm install
pnpm build
```

The `anvil` CLI is then at `packages/cli/dist/bin-anvil.js`:

```bash
node packages/cli/dist/bin-anvil.js --help
```

:::tip
Set an alias so the rest of this page is shorter to type:
`alias anvil='node packages/cli/dist/bin-anvil.js'`
:::

## 2. Compile a spec

```bash
node packages/cli/dist/bin-anvil.js compile <spec> \
  --manifest <manifest> \
  --out generated/<service>
```

This writes a full bundle. Every part is generated from the one shared model
(AIR), so they can't disagree about what an operation does:

| Folder | What it is |
| --- | --- |
| `cli/` | A typed command per approved operation |
| `mcp/` | The same operations as MCP tools, with risk in the metadata |
| `skill/` | A step-by-step operating manual an agent reads |
| `runtime/` | The safety runtime that enforces the contract at call time |
| `plugin/` | Hooks for Claude Code, Codex, and Antigravity |
| conformance test | A test that proves the bundle honors its own safety rules |

## 3. Inspect before you approve

```bash
node packages/cli/dist/bin-anvil.js inspect generated/<service>
node packages/cli/dist/bin-anvil.js lint generated/<service>
```

`inspect` shows each operation's effect (read or mutation), risk, and
idempotency (whether it's safe to repeat).

:::note
Mutations that can't be safely repeated compile as `review_required` — held for
review, not exposed to any agent until a person approves them. That's a stop
sign, not a nuisance.
:::

To clear one, fill in what the spec left out with a **manifest** — a small YAML
file where you declare idempotency, confirmation, and retry policy — then
recompile with `--manifest`.

## 4. Approve, then deploy

```bash
# Expose an operation only after reading its risk
node packages/cli/dist/bin-anvil.js approve generated/<service> <operation-id>

# Package the skill and (optionally) deploy the server
node packages/cli/dist/bin-anvil.js package skill generated/<service>
node packages/cli/dist/bin-anvil.js deploy cloud-run generated/<service> --env prod
```

## Require a human, not just a model (optional)

By default, a gated mutation runs once the caller supplies `confirm: true` — but
a model can supply that itself. To require an actual person to sign off, compile
with a human-approval policy:

```bash
node packages/cli/dist/bin-anvil.js compile <spec> --human-approval unsafe --out generated/<service>
```

The generated Claude Code, Codex, and Antigravity hooks then escalate those
operations to the human permission dialog. The model cannot self-confirm past
them. See [Hooks and plugins](/anvil/design/hooks-and-plugins/).

## Next

- [Operating Anvil](/anvil/guides/operating-anvil/) — the full operating manual.
- [Command reference](/anvil/guides/commands/) — every command.
- [Architecture](/anvil/concepts/architecture/) — the AIR model and the packages.
