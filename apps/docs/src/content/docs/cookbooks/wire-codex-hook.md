---
title: "Wire the Codex hook"
description: "Install the generated Codex PreToolUse hook: the trust prompt is the point, and its deny-only semantics make human-approval operations fail closed."
sidebar:
  order: 3
---

**What you'll have at the end:** Codex enforcing the bundle's safety contract
through a `PreToolUse` hook — model-confirm mutations denied until
`confirm: true`, human-approval operations blocked fail-closed, and the trust
prompt reviewed deliberately rather than skipped.

Codex's hook contract is a near-clone of Claude Code's, so the generated hook
reuses the same decision core (`plugin/hookcore.mjs`) behind a Codex-specific
shim (`plugin/codex/hook.mjs`). What differs is what Codex lets a hook *say* —
and that difference matters for safety, so read step 4 before relying on it.

## 1. Compile the bundle

```bash
anvil compile openapi.yaml --manifest anvil.yaml --out generated/payments
```

The bundle contains `plugin/codex/hooks.json`, `plugin/codex/hook.mjs`, and a
generated `plugin/codex/README.md` with these same install steps.

## 2. Copy `hooks.json` into `.codex/`

Copy (or merge) `plugin/codex/hooks.json` into `<repo>/.codex/hooks.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "mcp__plugin_anvil-payments_payments__.*",
        "hooks": [{ "type": "command", "command": "node ./plugin/codex/hook.mjs" }]
      }
    ]
  }
}
```

Adjust the command path to wherever the bundle lives relative to the repo (or
make it absolute). If you register the MCP server directly rather than as a
plugin, also adjust the matcher to Codex's naming for a directly-configured
server.

## 3. Accept the trust prompt — by reading it

Codex deliberately makes non-managed hooks install-by-review: it shows a trust
prompt for the hook definition and there is no silent install path. **That
review is the point.** You are approving a command that will run on every
matching tool call — read `plugin/codex/hook.mjs` and `plugin/hookcore.mjs`
(both are short, dependency-free, and generated to be readable) before
accepting.

Then add the MCP server under `mcp_servers` in `~/.codex/config.toml` (or the
project config), pointing at the bundle's `mcp/server.js`.

## 4. Understand the deny-only semantics

Codex's PreToolUse contract supports only two decisions: `deny`, and `allow`
**with** `updatedInput` (a rewrite). A bare `allow` is unsupported — Codex
marks the hook run failed and **runs the tool anyway** — and there is no
interactive `ask`. So the generated shim only ever emits `deny` or no decision
at all:

- **Clean call** → *no* `permissionDecision` (just `additionalContext` when
  there is dry-run steering). Absence lets the tool proceed; a bare `allow`
  would be rejected.
- **Model-confirm mutation** → `deny` until the model re-invokes with
  `confirm: true`; the reason names the flag.
- **Human-approval operation** → **also `deny`, fail-closed.** Codex cannot
  prompt a human from a PreToolUse hook, and the model must never self-approve,
  so the only honest enforcement is to block the tool here — even when the
  model supplies `confirm: true`. These operations are therefore *not runnable
  autonomously in Codex*. To gate them interactively, use Codex's own approval
  policy / `PermissionRequest` hook — that is the mechanism designed for user
  approval, not `PreToolUse`.
- **Unknown / unapproved operation, missing idempotency key** → `deny`.

Proof, against the repo's payments example compiled with the human-approval
policy — note the deny fires *despite* `confirm: true`:

```bash
# [docs-tested]
WORK=$(mktemp -d)
node packages/cli/dist/bin-anvil.js compile examples/payments/openapi.yaml \
  --manifest examples/payments/anvil.yaml --service payments \
  --human-approval unsafe --out "$WORK/payments" --root "$WORK"
# Human-approval tier: fail-closed deny, even with a model-supplied confirm.
OUTPUT=$(echo '{"tool_name":"payments_create_refund","tool_input":{"confirm":true}}' \
  | node "$WORK/payments/plugin/codex/hook.mjs")
echo "$OUTPUT" | grep -q '"permissionDecision":"deny"'
echo "$OUTPUT" | grep -q 'human approval'
rm -rf "$WORK"
```

The deny reason spells out why and where to go instead:

```text
… requires explicit human approval. Codex cannot prompt for human approval
from a PreToolUse hook, so this operation is blocked here — run it with a
human in the loop via Codex's own approval flow.
```

**If it refuses:** for a model-confirm deny, re-invoke with `confirm: true`
(and `idempotency_key` if named) only when the user intends the effect —
preview with `dryRun: true` first. For a human-approval deny there is nothing
the model can add; the operation needs a human in the loop via Codex's approval
flow, or a different harness (Antigravity's `force_ask` and Claude Code's `ask`
both escalate to a real prompt).

## Caveats

- An org policy of `allow_managed_hooks_only = true` silently drops this hook.
  The MCP server's runtime still refuses unsafe calls regardless — the hook is
  the outer ring, not the contract.
- The output shape mirrors Claude's `hookSpecificOutput`. If your installed
  Codex build documents different PreToolUse field names, adjust
  `plugin/codex/hook.mjs` against the current Codex hooks reference — the
  decision logic in `hookcore.mjs` stays the same.
