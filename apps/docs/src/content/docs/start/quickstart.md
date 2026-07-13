---
title: Quickstart
description: Build, then drive Anvil — compile a spec into an aligned CLI + MCP + skill + hooks bundle, inspect risk, and approve operations.
sidebar:
  order: 2
---

## Build the toolchain

```bash
pnpm install
pnpm build
```

The `anvil` CLI is then at `packages/cli/dist/bin-anvil.js`:

```bash
node packages/cli/dist/bin-anvil.js --help
```

## Compile a spec

```bash
node packages/cli/dist/bin-anvil.js compile <spec> \
  --manifest <manifest> \
  --out generated/<service>
```

This writes a full bundle: `cli/`, `mcp/`, `skill/`, `runtime/`, the harness
`plugin/` (Claude Code + Codex + Antigravity hooks), and a conformance test —
every artifact a projection of the one AIR model.

## Inspect before you approve

```bash
node packages/cli/dist/bin-anvil.js inspect generated/<service>
node packages/cli/dist/bin-anvil.js lint generated/<service>
```

`inspect` shows each operation's effect, risk, and idempotency. Non-idempotent
mutations are `review_required` — a stop sign, not a nuisance. Enrich them with a
manifest to declare idempotency, confirmation, and retry policy.

## Approve, then deploy

```bash
# Expose an operation only after reading its risk
node packages/cli/dist/bin-anvil.js approve generated/<service> <operation-id>

# Package the skill and (optionally) deploy the server
node packages/cli/dist/bin-anvil.js package skill generated/<service>
node packages/cli/dist/bin-anvil.js deploy cloud-run generated/<service> --env prod
```

## Human-approval hooks (optional)

To require **explicit human sign-off** (not just a model-supplied `confirm`) on
gated mutations, compile with a human-approval policy:

```bash
node packages/cli/dist/bin-anvil.js compile <spec> --human-approval unsafe --out generated/<service>
```

The generated Claude Code / Codex / Antigravity hooks then escalate those
operations to the human permission dialog — the model cannot self-confirm past
them. See [Hooks and plugins](/anvil/design/hooks-and-plugins/).

## Next

- [Operating Anvil](/anvil/guides/operating-anvil/) — the full operating manual.
- [Command reference](/anvil/guides/commands/) — every command.
- [Architecture](/anvil/concepts/architecture/) — the AIR model and the packages.
