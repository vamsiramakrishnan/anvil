---
title: "Install the Claude Code plugin"
description: "The generated bundle root is an installable Claude Code plugin: one install registers the skill, the MCP server, and an enforcing PreToolUse hook together."
sidebar:
  order: 2
---

**What you'll have at the end:** Claude Code running the bundle as a plugin —
skill, MCP server, and PreToolUse hook installed together, all generated from
the same Anvil model and versioned as one unit.

:::note[Before you start]
You need Anvil built from source and Claude Code installed. See
[Install Anvil](/anvil/cookbooks/install-anvil/) for the one-time setup.
:::

There is no separate plugin build step. The composition is deliberate: a
Claude Code plugin *is* skills + MCP server + hooks in one directory, which is
exactly what an Anvil bundle already is. `anvil compile` writes
`.claude-plugin/plugin.json` at the bundle root, so the whole bundle **is** the
plugin.

## 1. Compile and check the plugin manifest

```bash
# [docs-tested]
WORK=$(mktemp -d)
node packages/cli/dist/bin-anvil.js compile examples/payments/openapi.yaml \
  --manifest examples/payments/anvil.yaml --service payments \
  --out "$WORK/payments" --root "$WORK"
# The bundle root is the plugin: the manifest wires skill, hooks, and MCP server.
test -f "$WORK/payments/.claude-plugin/plugin.json"
grep -q '"hooks": "./plugin/claude/hooks.json"' "$WORK/payments/.claude-plugin/plugin.json"
# The PreToolUse hook denies an unconfirmed gated mutation before it leaves the harness.
OUTPUT=$(echo '{"tool_name":"mcp__plugin_anvil-payments_payments__payments_create_refund","tool_input":{}}' \
  | node "$WORK/payments/plugin/claude/hook.mjs")
echo "$OUTPUT" | grep -q '"permissionDecision":"deny"'
rm -rf "$WORK"
```

The generated `.claude-plugin/plugin.json`:

```json
{
  "name": "anvil-payments",
  "version": "2026-07-09-prod",
  "skills": ["./skill"],
  "hooks": "./plugin/claude/hooks.json",
  "mcpServers": "./plugin/claude/mcp.json"
}
```

`version` tracks the service version, so re-approving operations and
regenerating the bundle ships as a normal plugin update — the tools the agent
can call move with it.

## 2. Install it

Per the bundle's generated `plugin/README.md`:

- **Local:** `claude --plugin-dir <path-to-this-bundle>`
- **Marketplace:** publish the bundle, then `claude plugin install anvil-payments`

One install registers all three components: the skill (how to use the
operations), the MCP server (the operations themselves), and the hook
(enforcement before a call leaves the harness).

## 3. What the PreToolUse hook enforces

The hook (`plugin/claude/hook.mjs`) is a thin shim over the shared decision
core `plugin/hookcore.mjs`, which reads the bundle's committed `catalog.json` —
never the server's self-report. Its matcher is scoped to exactly this plugin's
tools (`mcp__plugin_anvil-payments_payments__.*`), and for each call it returns
a permission decision:

- **Unknown tool name** (not in the catalog) → `deny`. This is tamper/staleness
  detection: a swapped or stale server exposing an operation the committed
  catalog does not know is blocked.
- **Unapproved operation** → `deny` — mirrors the approval filter (the server
  never compiles an unapproved operation into a tool in the first place).
- **Model-confirm mutation without `confirm: true`** → `deny`, with the exact
  required flag in the reason and a `dryRun: true` suggestion in
  `additionalContext`, so the model can correct the call in the same turn
  instead of burning a round trip on a `confirmation_required` envelope.
- **Human-approval operation** → `ask` — escalates to Claude Code's real
  permission dialog. A model-supplied `confirm: true` can never clear this
  tier: the model cannot self-approve. See
  [Require human approval](/anvil/cookbooks/require-human-approval/).
- **Missing required idempotency key** → `deny`, naming `idempotency_key`.
- **Clean but high-risk or irreversible mutation** → `allow`, with dry-run
  steering attached as context. Reads get zero noise on the hot path.

An example deny, exactly as the harness receives it:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "This operation creates an irreversible financial mutation. — re-invoke with confirm: true if the user intends the effect.",
    "additionalContext": "Preview with dryRun: true first, then re-invoke with confirm: true."
  }
}
```

**If it refuses:** the refusal is the contract working, not a bug. The reason
names what is missing. Supply `confirm: true` (and `idempotency_key` where
required) only when the user intends the effect; for an `ask`, the human
answers the permission dialog. Never bypass by disabling hooks — the runtime
executor refuses the same calls anyway, just one turn later.

## Notes

- The hook is the outer, advisory check and fail-open: uninstall the plugin or
  disable hooks and the MCP server's runtime still refuses unsafe calls. The
  generated conformance test (`tests/conformance.test.ts` in the bundle)
  asserts the hook core and the executor agree, so the rings cannot silently
  drift apart.
- The same `plugin/hookcore.mjs` also drives the
  [Antigravity](/anvil/cookbooks/wire-antigravity-hooks/) and
  [Codex](/anvil/cookbooks/wire-codex-hook/) hooks — one decision core, thin
  per-harness shims.
