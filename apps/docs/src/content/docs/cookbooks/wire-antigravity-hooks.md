---
title: "Wire the Antigravity hook"
description: "Install the generated Antigravity PreToolUse hook and rules file so the approval, confirmation, and idempotency contract is enforced before a tool call executes."
sidebar:
  order: 1
---

**What you'll have at the end:** an Antigravity workspace where every call to
this bundle's tools passes through the generated `PreToolUse` hook — unsafe
mutations are denied or escalated to the human *before* they execute, and
`.agent/rules/anvil-safety.md` shapes the agent's behavior alongside it.

Every compiled bundle already contains the hook. `anvil compile` emits
`plugin/antigravity/hooks.json`, the shim `plugin/antigravity/hook.mjs`, the
shared decision core `plugin/hookcore.mjs`, and the prompt-shaping rules file
`.agent/rules/anvil-safety.md`. Nothing needs to be generated separately —
this recipe is about copying two files into the right place.

:::note[Before you start]
You need Anvil built from source (see [Install Anvil](/anvil/cookbooks/install-anvil/))
and a spec to compile. The commands below use the repo's payments example.
:::

## 1. Compile the bundle

```bash
anvil compile openapi.yaml --manifest anvil.yaml --out generated/payments
```

Using the repo's payments example, and proving the hook's two key behaviors
(deny an unconfirmed gated mutation; pass foreign tools straight through):

```bash
# [docs-tested]
WORK=$(mktemp -d)
node packages/cli/dist/bin-anvil.js compile examples/payments/openapi.yaml \
  --manifest examples/payments/anvil.yaml --service payments \
  --out "$WORK/payments" --root "$WORK"
# A gated mutation without confirm: true is denied by the hook.
DECISION=$(echo '{"toolCall":{"name":"payments_create_refund","args":{}}}' \
  | node "$WORK/payments/plugin/antigravity/hook.mjs")
echo "$DECISION" | grep -q '"decision":"deny"'
# A tool that is not part of this bundle passes through untouched.
PASSTHRU=$(echo '{"toolCall":{"name":"read_file","args":{"path":"README.md"}}}' \
  | node "$WORK/payments/plugin/antigravity/hook.mjs")
echo "$PASSTHRU" | grep -q '"decision":"allow"'
rm -rf "$WORK"
```

The deny carries the exact remediation, so the model can fix the call in the
same turn:

```json
{"decision":"deny","reason":"This operation creates an irreversible financial mutation. — re-invoke with confirm: true if the user intends the effect."}
```

## 2. Register the MCP server

Register the bundle's MCP server in Antigravity's MCP configuration, pointing
at the bundle's `mcp/server.js` (it boots with `node mcp/server.js` — see the
bundle's `docs/README.md`). The hook enforces; the server executes.

## 3. Copy `hooks.json` into the workspace

Copy (or merge) `plugin/antigravity/hooks.json` into your workspace's
`.agents/hooks.json` — or the global `~/.gemini/config/hooks.json`. The
generated config looks like this:

```json
{
  "anvil-payments-guard": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "node ./plugin/antigravity/hook.mjs", "timeout": 10 }
        ]
      }
    ]
  }
}
```

Two things are deliberate here:

- **The matcher is `*`.** Antigravity fires `PreToolUse` for its own built-in
  tools too, and MCP tool namespacing varies by build — so the *shim*, not the
  matcher, scopes enforcement. The shim looks each tool name up in the bundle's
  committed `catalog.json`; anything that is not one of this bundle's
  operations is passed through with `allow`, never denied. Firing on every
  tool is a small cost for reliable enforcement.
- **The command path is workspace-relative.** `node ./plugin/antigravity/hook.mjs`
  assumes the bundle sits at the workspace root. If it lives elsewhere, change
  the path to the bundle's actual location (absolute paths are fine).

## 4. Keep the rules file

`anvil compile` also emits `.agent/rules/anvil-safety.md` at the bundle root —
prompt-shaping guidance Antigravity picks up from the workspace's `.agent/rules/`
directory. It restates the same contract the hook enforces ("do NOT
self-confirm", "supply an idempotency key for `payments_create_refund`",
"prefer `dryRun: true` before any mutation"), listing the concrete gated
operations by tool name. Belt and suspenders: the rules steer, the hook
enforces, and the MCP server's runtime stays authoritative even if neither is
installed.

## 5. What the hook decides

For each tool call, the shim reads `toolCall.name` / `toolCall.args` and emits
`{ decision: "allow" | "deny" | "force_ask", reason? }`:

- **Not one of this bundle's operations** → `allow` (pass-through).
- **Unapproved or unknown-in-catalog operation** → `deny` (a stale or swapped
  server exposing something the catalog does not is caught here).
- **Model-confirm mutation without `confirm: true`** → `deny`, naming the flag.
- **Human-approval operation** → `force_ask` — Antigravity always prompts the
  user, **ignoring any cached "Always Allow"**, so the model cannot
  self-confirm past it. See [Require human approval](/anvil/cookbooks/require-human-approval/).
- **Missing required idempotency key** → `deny`.
- Otherwise → `allow`.

**If it refuses:** that is the hook doing its job. A `deny` names the exact
missing flag (`confirm: true`, `idempotency_key`) — re-invoke with it only if
the user actually intends the effect. A `force_ask` cannot be satisfied by the
model at all; it hands the decision to the human. Do not weaken the matcher or
remove the hook to get past a refusal — fill in the operation's manifest entry
or get the human's approval instead.

## Notes

- The hook is the outer, advisory check and **fail-open** by design: if it is
  never installed, the MCP server's runtime still refuses the same calls. The
  hook's value is denying
  *before* the model burns a turn, and escalating human-approval operations to
  a real prompt.
- The hook carries no per-operation data. It reads `catalog.json` at runtime,
  so re-approving and regenerating the bundle updates enforcement with no
  hook edit.
