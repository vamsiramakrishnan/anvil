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

## Targeting the residue with distill

Don't sweep every operation. `anvil distill <dir>` reduces the surface to its
eigenbasis (one canonical read per cluster, every write its own vector), and
`--as-enrich-plan` turns its open questions into a source-routed plan that
`anvil enrich --plan` probes — asking code hosts to prove idempotency and doc
hosts to describe intent, only for the operations that are actually uncertain.

```bash
anvil distill <dir> --as-enrich-plan --write plan.json
anvil enrich <dir> --sources sources.yaml --plan plan.json
```

## Re-homing a weak name

When `anvil lint` reports `weak_operation_name` — a name an agent cannot route
on (`do_transition`, `get_object`, `list_records`) — fix the routing name with
the `name` axis. It re-projects the canonical name, CLI command, and MCP tool
together from one `(resource, verb)` pair, so the three surfaces cannot drift,
and the stable operation `id` is preserved (a rename is not a new operation):

```yaml
operations:
  doTransition:
    name:
      resource: issue        # the concrete thing it acts on
      verb: transition       # a free string — not limited to the effect-verb set
    # → canonical `transition_issue`, CLI `<svc> issue transition`,
    #   tool `<svc>_transition_issue`
```

`name` renames only; `action` (list/get/create/…) reclassifies the *effect* and
is a separate axis. Set either `resource` or `verb`; the other is read from the
current name. A re-home that collides with another operation is re-disambiguated
deterministically, never silently.
