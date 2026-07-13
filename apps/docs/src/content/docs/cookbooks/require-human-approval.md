---
title: "Require human approval"
description: "Escalate gated mutations from model confirmation to explicit human sign-off — the compile-time policy flag, the per-operation manifest knob, and what each harness does with it."
sidebar:
  order: 4
---

**What you'll have at the end:** operations whose confirmation can only be
satisfied by a *human* — Antigravity force-asks past "Always Allow", Claude
Code escalates to the permission dialog, and Codex blocks fail-closed — set
either service-wide at compile time or per operation in the manifest.

`confirm: true` is an argument the **model** supplies. For most gated
mutations that is enough — the runtime refuses until the flag is present, and
the flag is supposed to reflect the user's intent. But for the worst
operations (irreversible, financial, destructive) you may want a stronger
tier: the model must not be able to clear the gate at all. That is
`human_approval`.

## 1. Knob one: `--human-approval` at compile time

```bash
anvil compile openapi.yaml --manifest anvil.yaml --human-approval unsafe --out generated/payments
```

The policy takes `none | unsafe | all` and applies a coarse default to
**confirmation-required** operations that don't already carry an explicit
per-op value:

- `none` — no escalation (the default).
- `unsafe` — escalate gated operations that are irreversible or
  high/financial/destructive risk.
- `all` — escalate every gated mutation. Reads are never touched.

An explicit per-op manifest value (true *or* false) always wins over the flag.

## 2. Knob two: per-operation manifest `confirmation.human_approval`

```yaml
# anvil.yaml
operations:
  createRefund:
    side_effect: mutation
    risk: financial
    reversible: false
    confirmation:
      required: true
      human_approval: true
      reason: Refunds move real money and cannot be reversed.
    state: approved
```

`human_approval: true` implies `required: true` (an escalation without a gate
would be meaningless, so Anvil tightens automatically). This is the durable
form: it lives in the diffable manifest, survives every recompile, and — unlike
the CLI flag — is visible to `anvil sync`, so drift detection won't
misreport it (see the caveat below).

Verify the result end-to-end — the catalog records the tier, and the
Antigravity hook turns it into `force_ask`:

```bash
# [docs-tested]
WORK=$(mktemp -d)
node packages/cli/dist/bin-anvil.js compile examples/payments/openapi.yaml \
  --manifest examples/payments/anvil.yaml --service payments \
  --human-approval unsafe --out "$WORK/payments" --root "$WORK"
# catalog.json (what every hook reads) now carries humanApproval: true.
node -e "
const c = require(process.argv[1] + '/payments/catalog.json');
const op = c.operations.find((o) => o.mcpTool === 'payments_create_refund');
if (!(op.confirmationRequired && op.humanApproval)) process.exit(1);
" "$WORK"
# Antigravity: force_ask, even though the model supplied confirm: true.
DECISION=$(echo '{"toolCall":{"name":"payments_create_refund","args":{"confirm":true}}}' \
  | node "$WORK/payments/plugin/antigravity/hook.mjs")
echo "$DECISION" | grep -q '"decision":"force_ask"'
rm -rf "$WORK"
```

## 3. What each harness does with it

| Harness | Human-approval behavior |
|---|---|
| **Antigravity** | `force_ask` — always prompts the user, **ignoring cached "Always Allow"**. The model cannot self-confirm past it. |
| **Claude Code** | `ask` — escalates to the real permission dialog; a model-supplied `confirm: true` never clears it. |
| **Codex** | `deny`, **fail-closed** — Codex's PreToolUse hook cannot prompt a human and has no `ask`, so the operation is blocked outright. Gate it interactively with Codex's own approval flow / `PermissionRequest` hook instead. |

In every harness the reason travels with the decision, e.g.:

```text
This operation creates an irreversible financial mutation. — requires explicit human approval.
```

**If it refuses:** that is the tier working. There is nothing the model can
add to the call — no flag clears human approval. The human either approves in
the harness dialog (Antigravity, Claude Code) or runs the operation through
the harness's own approval flow (Codex). Do not downgrade the tier to make an
agent run unattended; if unattended execution is genuinely intended, that is a
deliberate manifest change a human reviews (`human_approval: false`), not a
workaround.

## Caveats

- **Prefer the manifest knob for anything long-lived.** `--human-approval` is a
  one-shot compile input: `anvil sync` (drift detection) recompiles the spec
  with only the manifest, so a bundle whose escalation exists *only* via the
  flag will show `Human-approval requirement REMOVED (true → false)` —
  **blocking** drift — on every sync. Putting `human_approval: true` in the
  manifest keeps compile and sync seeing the same contract.
- The runtime executor still gates on `confirm` — human approval is enforced at
  the harness hook layer, where a human dialog actually exists. The hook layer
  is fail-open by design; the runtime's confirmation gate is what holds with no
  hooks installed.
