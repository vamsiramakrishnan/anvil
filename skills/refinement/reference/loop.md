---
name: refinement-loop
description: The anvil refine commands, the deficiency catalog, and the refinement-pack layout. Read this to drive the loop end to end.
---

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
- `anvil refine export-task <dir> <target-key> --out FILE [--skill N] [--repo-root DIR]`
  — export one deterministic, hash-bound JSON task for any external coding harness.
- `anvil refine import-proposal <dir> <task.json> <submission.json> --out DIR [--json]`
  — verify Git-bound evidence, validate, measure, and write a normal refinement pack.
- `anvil refine review <pack-dir>` — print the human review (review.md) of a pack.
- `anvil refine approve|reject <pack-dir> <refinement-id...> --reviewer ID --reason TEXT`
  — write a decision receipt bound to the source contract, pack, and exact proposal.
- `anvil refine apply-pack <dir> <pack-dir> [--receipt FILE] [--dry-run]` — apply the
  original measured pack plus valid receipts. It never reruns detection or proposal generation.
- `anvil refine apply <dir> [--dry-run] [filters]` — apply ONLY the auto-approved
  refinements from a fresh deterministic run. `--dry-run` prints the semantic diff.
- `anvil refine skill [<out-dir>]` — emit this skill package.

## Deficiency catalog
Every code a detector can raise, its category, default severity, the skill that owns
it, and whether that skill is implemented today.

| code | category | severity | skill | implemented |
| --- | --- | --- | --- | --- |
| `required_field_no_example` | coverage | low | generate-examples | yes |
| `missing_capability_description` | documentation | low | describe-capability | yes |
| `missing_field_description` | documentation | medium | describe-field | yes |
| `missing_operation_description` | documentation | medium | describe-operation | yes |
| `missing_service_description` | documentation | low | describe-service | — |
| `opaque_enum_values` | documentation | medium | describe-enum | — |
| `phantom_operation_documented` | documentation | high | align-artifacts | — |
| `undocumented_error` | documentation | low | enrich-errors | yes |
| `undocumented_pagination` | documentation | low | document-pagination | yes |
| `auth_principal_unclear` | safety | medium | clarify-auth | — |
| `confirmation_posture_incomplete` | safety | blocking | confirm-posture | — |
| `contested_safety_semantic` | safety | blocking | classify-idempotency | yes |
| `error_retryability_unclear` | safety | medium | enrich-errors | yes |
| `mutation_effect_unproven` | safety | high | classify-idempotency | yes |
| `query_language_passthrough` | safety | high | review-query-passthrough | yes |
| `retry_basis_unproven` | safety | high | classify-idempotency | yes |
| `capability_missing_routing_phrases` | usability | low | author-routing-phrases | yes |
| `cross_surface_disagreement` | usability | high | align-artifacts | — |
| `indistinct_operation_descriptions` | usability | medium | disambiguate-operations | yes |
| `operation_lacks_intent_examples` | usability | low | author-intent-examples | yes |
| `resource_contradicted_by_own_name` | usability | medium | rehome-resource | yes |
| `schema_too_large_for_disclosure` | usability | medium | reduce-schema-disclosure | yes |
| `ui_projection_contract` | usability | high | investigate-ui-projection | yes |
| `unit_ambiguous_field` | usability | high | rename-field | yes |
| `unpaginated_large_response` | usability | medium | constrain-response-size | — |
| `weak_field_name` | usability | medium | rename-field | yes |
| `weak_operation_name` | usability | low | rename-operation | yes |

## A refinement pack
`anvil refine run --out <dir>` writes a reviewable, auditable record — one facet per file:
- `pack.json` — the complete machine-readable pack, including the source contract hash.
- `plan.json` — the detected deficiencies.
- `claims.json` — the evidence behind each refinement.
- `proposed.patch.json` — the semantic patches.
- `validation.json` — per-check validation outcomes.
- `eval-delta.json` — the before/after of each affected eval family.
- `artifacts-affected.json` — the projections each patch re-derives.
- `review.md` — the human review, worst/most-actionable first.
- `harness-tasks.json`, `harness-submissions.json`, `harness-evidence.json` —
  present on portable imports; the task, response, and Git/SHA-256 evidence record.

Human decisions are written under `receipts/`. Application fails closed if AIR changed,
the pack changed, the proposal changed, a receipt is duplicated, or a rejected/regressed
proposal is presented for promotion.
