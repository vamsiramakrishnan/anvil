---
name: refinement-proposal-contract
description: The exact proposal JSON an executor emits — shape, grounding rules, and boundaries. Read this before emitting any proposal.
---

# The proposal contract

An executor turns a skill's context into a **proposal**: evidence-backed claims plus
the semantic patch they justify. Return `null` (no proposal) when you cannot ground
the change — do not guess.

## Shape
```json
{
  "skill": "describe-field",
  "skillVersion": 1,
  "deficiency": "missing_field_description",
  "target": { "kind": "field", "operationId": "payments.refunds.create", "path": "input.body.reason" },
  "claims": [
    {
      "subject": "input.body.reason",
      "predicate": "field.description",
      "value": "Customer-facing reason recorded with the refund.",
      "source": "source_impl",
      "sourceRef": "refunds/service.ts:142",
      "confidence": 0.9
    }
  ],
  "patch": {
    "target": { "kind": "field", "operationId": "payments.refunds.create", "path": "input.body.reason" },
    "set": { "description": "Customer-facing reason recorded with the refund." }
  }
}
```

## Rules
- Every value in `patch.set` MUST be grounded by a claim (`evidence_supports_value`).
- `patch.set` keys MUST be within the skill's writable fields and MUST NOT be structural.
- `claims[].source` MUST be one of the skill's admissible sources, and their aggregate
  strength MUST meet the skill's minimum.
- `subject` should name the target (its field path, error code, or operation id) so the
  claim is scoped to it and does not leak onto a sibling.
- A `SemanticPatch` is target-relative: you set `description`, not
  `operations[..].input.body.reason.description`. You cannot address anything outside the target.
