---
title: "Handle a confirmation-required refusal"
description: "Read the structured error envelope, preview with --dry-run, and re-issue with --confirm and --idempotency-key only when the user actually intends the effect."
sidebar:
  order: 6
---

**What you'll have at the end:** a correct three-step response to a
`confirmation_required` refusal — understand the envelope, preview the exact
request with `--dry-run`, then execute deliberately with `--confirm` and a
pinned `--idempotency-key`.

## 1. Recognize the envelope — and why the refusal is correct

Call a gated mutation without confirmation and Anvil refuses with a structured
envelope, never a raw upstream error:

```bash
anvil run generated/payments refunds create --payment-id pay_123 --amount 500 --currency USD --json
```

```json
{
  "error": {
    "code": "confirmation_required",
    "message": "This operation creates an irreversible financial mutation.",
    "retryable": false,
    "safe_to_retry": false,
    "operation": "payments.refunds.create",
    "trace_id": "trace_5adcfc5e-a11e-4800-b041-997c55fa981d",
    "required_flags": ["--confirm", "--idempotency-key"]
  }
}
```

The exit code is `3` (needs-flags — the stable exit-code taxonomy is: 2 input,
3 needs-flags, 4 auth, 5 policy, 6 upstream state, 7 upstream availability).

The refusal is *correct behavior*, not an obstacle. `createRefund` is an
irreversible financial mutation; the contract says explicit refusal beats
accidental execution. Everything needed to proceed deliberately is in the
envelope: `message` says why, `required_flags` says exactly what to add, and
`safe_to_retry: false` says re-sending the same command blindly is not an
answer. If you are an agent reading this envelope: **stop and check the user's
intent** — `--confirm` asserts *their* intent, not yours.

## 2. Preview with `--dry-run` first

Add the required flags *plus* `--dry-run` to see precisely what would happen
without any side effect — the dry-run short-circuits before auth and before
anything leaves the machine:

:::note
The confirmation gate runs even before dry-run planning, so `--dry-run` on its
own still gets the same refusal. You need the flags too.
:::

```bash
anvil run generated/payments refunds create --payment-id pay_123 --amount 500 --currency USD \
  --dry-run --confirm --idempotency-key refund-pay_123-2026-07-13 --json
```

```json
{
  "operation": "payments.refunds.create",
  "method": "POST",
  "url": "https://payments.internal.example.com/payments/pay_123/refunds",
  "headers": { "accept": "application/json", "content-type": "application/json", "Idempotency-Key": "refund-pay_123-2026-07-13" },
  "body": { "amount": 500, "currency": "USD" },
  "idempotencyKeyPresent": true,
  "retryPlan": { "enabled": true, "maxAttempts": 3 },
  "confirmationRequired": true
}
```

Check the plan: right URL, right amount, idempotency key present and injected
into the declared header, retries enabled only because the key makes them safe.

The whole flow, executed against the repo's payments example:

```bash
# [docs-tested]
WORK=$(mktemp -d)
node packages/cli/dist/bin-anvil.js compile examples/payments/openapi.yaml \
  --manifest examples/payments/anvil.yaml --service payments \
  --out "$WORK/payments" --root "$WORK"
# 1. The bare call refuses with the structured envelope, exit code 3.
set +e
REFUSAL=$(node packages/cli/dist/bin-anvil.js run "$WORK/payments" refunds create \
  --payment-id pay_123 --amount 500 --currency USD --json 2>&1)
STATUS=$?
set -e
test "$STATUS" -eq 3
echo "$REFUSAL" | grep -q '"code": "confirmation_required"'
echo "$REFUSAL" | grep -q -- '--idempotency-key'
# 2. Dry-run with the required flags: a full request plan, zero side effects.
PLAN=$(node packages/cli/dist/bin-anvil.js run "$WORK/payments" refunds create \
  --payment-id pay_123 --amount 500 --currency USD \
  --dry-run --confirm --idempotency-key refund-pay_123-2026-07-13 --json)
echo "$PLAN" | grep -q '"idempotencyKeyPresent": true'
rm -rf "$WORK"
```

## 3. Execute — deliberately

Only when the user intends the effect, drop `--dry-run` and keep everything
else:

```bash
anvil run generated/payments refunds create --payment-id pay_123 --amount 500 --currency USD \
  --confirm --idempotency-key refund-pay_123-2026-07-13
```

Pin the idempotency key yourself and make it meaningful
(`refund-<payment>-<date>` beats a random UUID in an audit log). Reusing the
same key lets the durable ledger detect the same request and lets the upstream
carrier enforce its own idempotency contract. A completed replay returns the
stored result while its retention window is active; a concurrent replay is
refused as `in_progress`. This is deliberately not an exactly-once claim: if the
upstream succeeds and the runtime crashes before recording completion, Anvil
leaves the reservation in progress for operator reconciliation instead of
guessing that a retry is safe. A *new* key is a *new* refund. A
`required_request_key` operation refuses when the key is absent; Anvil only
derives a deterministic request-fingerprint key for the separate
`key_supported` strategy, where the caller key is optional.

**If it refuses again:** read the new envelope — the code will have moved on.
`idempotency_required` means the operation demands a key and none was supplied
or derivable (`required_flags: ["--idempotency-key"]`). `auth_required`
(exit 4) names the credential env var to set. `policy_denied` (exit 5) means
the upstream host is not allowlisted for this environment — a deployment
decision, not a flag. None of these are retry-until-it-works situations;
each envelope tells you the one thing it needs.

## Notes

- The same gates guard every place the operation shows up (CLI, MCP, hooks).
  Over MCP, the equivalent arguments are
  `confirm: true`, `idempotency_key`, and `dryRun: true` — and the
  [harness hooks](/anvil/cookbooks/wire-antigravity-hooks/) deny a missing
  flag before the call even leaves the harness.
- Operations marked `human_approval` cannot be cleared with `--confirm` at the
  harness layer at all — see
  [Require human approval](/anvil/cookbooks/require-human-approval/).
