---
title: "Respond to spec drift"
description: "Detect semantic drift when the upstream spec changes, read the findings by severity, and resolve a dropped safety guard deliberately — restore it or re-approve it, never ignore it."
sidebar:
  order: 7
---

**What you'll have at the end:** a pipeline habit for spec changes — run
`anvil sync`, read the drift record by severity, and resolve blocking items by
either restoring the guard or deliberately re-approving the loosened contract.

The upstream spec will change. Drift detection answers one question: *does the
new spec still mean what the artifacts you shipped say it means?* `anvil sync`
re-imports the spec through the snapshot layer, recompiles it **in memory**,
and diffs the fresh contract against your stored AIR. It never mutates the
model — the only writes are a locked snapshot and a drift record under
`.anvil/drift/` — and it exits non-zero on high/blocking drift, so it gates a
pipeline.

## 1. Run `anvil sync` when the spec changes

```bash
anvil sync openapi.yaml generated/payments --manifest anvil.yaml
```

Pass the same `--manifest` you compile with — sync's in-memory recompile must
see the same enrichment, or your own manifest guards will misreport as drift.
Unchanged content is a fast path (same source hash, no compile, no drift).

A worked run, end to end — compile, simulate an upstream spec change, detect:

```bash
# [docs-tested]
WORK=$(mktemp -d)
cp examples/payments/openapi.yaml "$WORK/spec.yaml"
node packages/cli/dist/bin-anvil.js compile "$WORK/spec.yaml" \
  --manifest examples/payments/anvil.yaml --service payments \
  --out "$WORK/payments" --root "$WORK"
# Upstream change: the refund body's optional 'reason' becomes required.
sed -i.bak 's/required: \[amount, currency\]/required: [amount, currency, reason]/' "$WORK/spec.yaml"
set +e
node packages/cli/dist/bin-anvil.js sync "$WORK/spec.yaml" "$WORK/payments" \
  --manifest examples/payments/anvil.yaml --root "$WORK" > "$WORK/sync.out"
STATUS=$?
set -e
test "$STATUS" -eq 1              # high/blocking drift gates the pipeline
grep -q "HIGH" "$WORK/sync.out"
node packages/cli/dist/bin-anvil.js drift list --root "$WORK" | grep -q UNREVIEWED
rm -rf "$WORK"
```

## 2. Read the findings

```text
Drift payments-5d0d33fd268a — payments: 1 item(s) vs generated/payments
  HIGH (1)
    [c6adbb54afbef809] payments.refunds.create input.body.reason: body field 'reason' is now required (was optional — breaking).
  affected capabilities: payments.refunds
  invalidated certifications: (none)

Wrote .anvil/drift/payments-5d0d33fd268a.json. Review it with `anvil drift show payments-5d0d33fd268a`;
mark it reviewed with `anvil drift accept`. AIR was not changed.
```

Items are grouped by severity, and the severity encodes a policy, not a diff
size:

- **blocking** — the contract *loosened* safety-wise: a dropped confirmation
  requirement, a removed human-approval requirement, retries appearing where
  there were none, an idempotency claim crossing `none`, auth vanishing, or an
  approved-and-exposed operation removed from the spec.
- **high** — safety-semantic but not loosening (breaking input changes,
  tightened auth).
- **medium/low/info** — new operations (they arrive unapproved), pagination,
  documentation-only edits.

The record also names the affected capabilities and which certifications are
invalidated even though their bundle bytes are untouched — those must be
re-earned with `anvil certify`.

## 3. Why a dropped confirmation is blocking

A confirmation guard exists because a human judged an effect dangerous. If a
recompile of the new spec+manifest no longer produces that guard, agents
holding the regenerated bundle would execute the mutation *without the check a
human previously required*. The stored contract said "gated"; the new one says
"open" — that must stop a pipeline:

```text
  BLOCKING (2)
    [774e87de41eea4b5] payments.capture.create confirmation.human_approval: Human-approval requirement REMOVED (true → false).
    [4b2322d17d4bd339] payments.refunds.create confirmation.human_approval: Human-approval requirement REMOVED (true → false).
```

(A common accidental source of exactly this finding: the bundle was compiled
with `--human-approval unsafe` but the escalation was never written into the
manifest. Sync recompiles from spec + manifest only, so the flag-only guard
looks dropped. The fix is to make the guard durable:
`confirmation: { human_approval: true }` per operation — see
[Require human approval](/anvil/cookbooks/require-human-approval/).)

## 4. Resolve it — two legitimate paths

Sync never edits anything, so resolution is always a deliberate act:

**Path A — restore the guard (the default).** Put the confirmation back in the
manifest so the recompiled contract matches what was reviewed:

```yaml
operations:
  createRefund:
    confirmation:
      required: true
      human_approval: true
      reason: Refunds move real money and cannot be reversed.
```

Then recompile and re-run sync until it reports no safety drift:

```bash
anvil compile openapi.yaml --manifest anvil.yaml --out generated/payments
anvil sync openapi.yaml generated/payments --manifest anvil.yaml
```

**Path B — deliberately accept the loosening.** If the guard is genuinely no
longer wanted, that is a *new approval decision*: update the manifest to say
so explicitly, recompile (regenerating every artifact from the loosened
model), re-earn any invalidated certifications with `anvil certify`, and only
then mark the record reviewed:

```bash
anvil drift accept payments-5d0d33fd268a --note "refund gate relaxed per payments-platform sign-off, recertified"
```

`anvil drift accept` is bookkeeping only — it stamps `reviewedAt` on the
record and nothing else. It never edits AIR, never restores a certification,
never changes capability lifecycles. Accepting a record you haven't acted on
doesn't make the drift go away; it just records that a human saw it.

**If it refuses (exits non-zero):** that is the gate working — sync found
high or blocking items. Do not wrap it in `|| true` in CI. Read
`anvil drift show <id>`, resolve via Path A or B, and let the next sync run
pass on its own merits. New operations in the spec are *not* an emergency:
they arrive unapproved and unexposed, and go through the normal
`inspect → enrich → approve` loop.
