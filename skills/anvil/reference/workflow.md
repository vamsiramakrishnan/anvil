---
name: anvil-workflow
description: The enrich-then-approve workflow and the supplemental manifest shape for unsafe operations. Read this before approving any non-idempotent mutation.
---

# The enrich → approve workflow

Specs are incomplete. When `anvil lint` reports `unproven_idempotency`, enrich
the model with a supplemental manifest instead of blindly approving.

```yaml
# anvil.yaml
operations:
  createRefund:               # match by operationId, canonicalName, or AIR id
    side_effect: mutation
    risk: financial
    reversible: false
    idempotency:
      strategy: required_request_key   # natural | required_request_key | key_supported | client_id | none
      key_location: header
      header: Idempotency-Key
    confirmation:
      required: true
      risk: financial
    retries:
      enabled: true
      only_on: [timeout, "429", "503"]
      max_attempts: 3
    state: approved
```

Then `anvil compile <spec> --manifest anvil.yaml --out <dir>` regenerates every
artifact consistently. If you cannot prove idempotency, leave the operation
unapproved — an unexposed operation is safer than an unsafe one.
