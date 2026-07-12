# The refinement loop

## Commands
- `anvil refine plan <dir|air.yaml> [--json]` — detect deficiencies; a triage view
  (blocking safety gaps first) plus counts by severity, category, and owning skill.
  Read-only.
- `anvil refine skills [--json]` — list the skill contracts (trigger, evidence policy,
  output boundary, validation). Read-only.
- `anvil refine run <dir> [--severity S] [--skill N] [--safe-only] [--out DIR] [--json]`
  — propose → validate → measure → reconcile into a refinement pack. `--out` writes
  the pack. Read-only (never mutates AIR).
- `anvil refine review <pack-dir>` — print the human review (review.md) of a pack.
- `anvil refine apply <dir> [--dry-run] [filters]` — apply ONLY the auto-approved
  refinements to AIR. The single mutating step; `--dry-run` prints the semantic diff.
- `anvil refine skill [<out-dir>]` — emit this skill package.

## Deficiency catalog
Every code a detector can raise, its category, default severity, the skill that owns
it, and whether that skill is implemented today.

| code | category | severity | skill | implemented |
| --- | --- | --- | --- | --- |
| `required_field_no_example` | coverage | low | generate-examples | yes |
| `missing_capability_description` | documentation | low | describe-capability | — |
| `missing_field_description` | documentation | medium | describe-field | yes |
| `missing_operation_description` | documentation | medium | describe-operation | yes |
| `missing_service_description` | documentation | low | describe-service | — |
| `opaque_enum_values` | documentation | medium | describe-enum | — |
| `phantom_operation_documented` | documentation | high | align-artifacts | — |
| `undocumented_error` | documentation | low | enrich-errors | yes |
| `undocumented_pagination` | documentation | low | document-pagination | — |
| `auth_principal_unclear` | safety | medium | clarify-auth | — |
| `confirmation_posture_incomplete` | safety | blocking | confirm-posture | — |
| `contested_safety_semantic` | safety | blocking | classify-idempotency | — |
| `error_retryability_unclear` | safety | medium | enrich-errors | yes |
| `mutation_effect_unproven` | safety | high | classify-idempotency | — |
| `retry_basis_unproven` | safety | high | classify-idempotency | — |
| `capability_missing_routing_phrases` | usability | low | author-intent-examples | — |
| `cross_surface_disagreement` | usability | high | align-artifacts | — |
| `indistinct_operation_descriptions` | usability | medium | disambiguate-operations | — |
| `operation_lacks_intent_examples` | usability | low | author-intent-examples | — |
| `schema_too_large_for_disclosure` | usability | info | reduce-schema-disclosure | — |
| `weak_operation_name` | usability | low | rename-operation | — |

## A refinement pack
`anvil refine run --out <dir>` writes a reviewable, auditable record — one facet per file:
- `plan.json` — the detected deficiencies.
- `claims.json` — the evidence behind each refinement.
- `proposed.patch.json` — the semantic patches.
- `validation.json` — per-check validation outcomes.
- `eval-delta.json` — the before/after of each affected eval family.
- `artifacts-affected.json` — the projections each patch re-derives.
- `review.md` — the human review, worst/most-actionable first.
