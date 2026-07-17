---
title: "Add the safety facts a WSDL leaves out"
description: "Compile a WSDL, then use a manifest to state the idempotency and confirmation facts a WSDL can't carry — so you approve on facts, not guesses."
sidebar:
  order: 5
---

**What you'll have at the end:** a WSDL compiled into a full bundle whose
unsafe operations carry declared idempotency strategies and confirmation
policy — approved because a human stated the contract, not because the
compiler guessed.

A WSDL says even less about safety than OpenAPI does: no idempotency headers,
no risk annotations. Anvil compiles it anyway — conservatively. Operation
names drive the read-vs-write guess (`Get*`/`List*` become reads; everything
else becomes a write), and a mutation with no proven idempotency (safe to
repeat: calling twice does the same thing as calling once) is held for review
(`review_required`) and **not exposed** until you say otherwise. The manifest —
a small YAML file where you fill in what the spec left out — is how you say
otherwise.

The repo ships a worked example: `examples/soap/bank.wsdl` (a retail-banking
SOAP 1.1 service) and `examples/soap/anvil.yaml` (the manifest that fills in
its safety facts).

## 1. Compile the bare WSDL and read the posture

```bash
anvil compile bank.wsdl --out generated/banking
anvil inspect generated/banking
anvil lint generated/banking
```

Without a manifest, the payments-moving operations arrive gated and unexposed:

```text
RetailBanking @ 1.0.0 — 4 operations
  banking GetAccountBalance list     read               generated
  banking ListTransactions list      read               generated
  banking TransferFunds create       mutation/financial review_required ⚠
  banking CloseAccount create        mutation/medium    review_required ⚠
```

and `anvil lint` explains why:

```text
WARNING  unproven_idempotency  banking.transfer_funds.create  Operation 'banking.transfer_funds.create' is a mutation with no proven idempotency; auto-retry disabled and confirmation required.
```

This is the decision point. Do **not** respond with `anvil approve` — an
approval doesn't make `TransferFunds` idempotent, it just exposes an unsafe
operation. Respond with facts.

## 2. Declare the semantics in a manifest

Write what you actually know about the service (this is the shape of
`examples/soap/anvil.yaml`, trimmed):

```yaml
# anvil.yaml — semantics the WSDL cannot express
service:
  name: banking
  display_name: Retail Banking SOAP Service

operations:
  GetAccountBalance:            # match by operationId, canonicalName, or AIR id
    state: approved
  ListTransactions:
    state: approved

  # TransferFunds moves money — irreversible, financial — but the backend
  # deduplicates on a caller-supplied key in the request body, so retries
  # with the same key are safe. Declare that, and gate the operation.
  TransferFunds:
    side_effect: mutation
    risk: financial
    reversible: false
    idempotency:
      strategy: required_request_key   # natural | required_request_key | key_supported | client_id | none
      key_location: body               # header | query | body | path
    confirmation:
      required: true
      risk: financial
      reason: TransferFunds moves money between accounts and cannot be reversed.
    retries:
      enabled: true
      only_on: [timeout, soap_transport_fault]
      max_attempts: 3
    state: approved

  # CloseAccount is destructive and has no idempotency story at all: gate it,
  # approve it, and leave retries off. Anvil never auto-retries it.
  CloseAccount:
    side_effect: mutation
    risk: destructive
    confirmation:
      required: true
      risk: destructive
    state: approved
```

:::caution
Only claim `strategy: required_request_key` (or `natural`, `key_supported`,
`client_id`) if the backend genuinely behaves that way. The manifest is a
statement of fact: it unlocks retries and shapes every generated tool. Claim
idempotency the backend doesn't have, and a retry can double-charge.
:::

For header-carried keys, add `header: Idempotency-Key` and the runtime injects
the key into that header on execution. If you cannot prove idempotency, leave
`strategy` out and the operation stays non-retryable; if you cannot justify
exposure at all, leave `state` out and it stays unexposed.

## 3. Recompile with the manifest and verify

```bash
# [docs-tested]
WORK=$(mktemp -d)
# Bare compile: unsafe mutations arrive review_required and unexposed.
node packages/cli/dist/bin-anvil.js compile examples/soap/bank.wsdl \
  --service banking --out "$WORK/banking-bare" --root "$WORK"
node packages/cli/dist/bin-anvil.js inspect "$WORK/banking-bare" | grep -q review_required
# With the manifest: it declares idempotency + confirmation and approves.
node packages/cli/dist/bin-anvil.js compile examples/soap/bank.wsdl \
  --manifest examples/soap/anvil.yaml --service banking \
  --out "$WORK/banking" --root "$WORK"
node packages/cli/dist/bin-anvil.js inspect "$WORK/banking" \
  | grep -qE 'TransferFunds create +mutation/financial approved'
node packages/cli/dist/bin-anvil.js lint "$WORK/banking"
rm -rf "$WORK"
```

With the manifest in place, `inspect` shows all four operations `approved`, with
`TransferFunds` as `mutation/financial ⚠` (gated) — and `lint` still warns
`unproven_idempotency` for `CloseAccount`, which is honest: we approved it
*without* an idempotency claim, so auto-retry stays disabled and confirmation
stays required. A warning you understand is better than a claim you can't
back.

## 4. What the manifest bought

- **Retry safety:** `TransferFunds` may now retry on `timeout` and
  `soap_transport_fault` — because the same idempotency key makes a retry a
  duplicate-suppressed no-op. `CloseAccount` never retries.
- **Confirmation:** both mutations refuse without `--confirm` (CLI) /
  `confirm: true` (MCP), with your stated reason in the refusal envelope.
- **Alignment:** the CLI, MCP server, skill, and harness hooks are all
  generated from the same filled-in model — they cannot disagree about what
  `TransferFunds` means.

**If it refuses:** a `confirmation_required` envelope at call time means the
gate you just declared is working — see
[Handle a confirmation-required refusal](/anvil/cookbooks/handle-confirmation-required/).
If compile itself reports errors, the manifest is claiming something
incoherent (for example enabling retries on a non-idempotent mutation, which
`lint` flags as `unsafe_retry` and Anvil disables); fix the claim, not the
diagnostic.
