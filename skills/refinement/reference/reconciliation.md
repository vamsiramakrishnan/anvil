# Reconciliation: validation, measurement, approval

A proposal is validated, then measured, then routed by policy. Only a grounded,
in-boundary, demonstrably-better, safe proposal is applied.

## Validation checks (deterministic)
A proposal is rejected unless every check its skill declares passes.
- `patch_within_boundary` — every patched key is one the skill may write
- `no_semantic_schema_change` — no structural key (type/required/schema/enum) is touched
- `claims_from_allowed_sources` — every claim is from a source the skill admits
- `evidence_meets_minimum_strength` — the claims' aggregate strength meets the skill's minimum
- `evidence_supports_value` — each patched value is asserted by a claim (nothing invented)
- `description_nonempty` — the description is non-empty
- `description_not_tautological` — the description adds meaning beyond the name
- `examples_validate_against_schema` — every example validates against the field's schema
- `error_message_nonempty` — the error message is non-empty

## Eval families (the measurement)
For a refinement we score ONLY the families it affects, before and after applying
the patch to a throwaway clone. The verdict per family is improved / neutral /
regressed. The safety guard is always among the measured families.
- `operation_routing` — a leave-one-out router picks the right operation for its intent phrase
- `argument_mapping` — required fields have a usable value for an agent to fill in
- `field_interpretation` — fields carry both a description and a value an agent can use
- `error_recovery` — errors carry a message and known retryability for recovery
- `unsafe_operation_refusal` — SAFETY GUARD: unsafe mutations keep confirmation or proven idempotency. Always measured; must never regress.

## Statuses
- `improved` — an affected family rose and none regressed.
- `neutral` — nothing measured changed and none regressed.
- `regressed` — an affected family (or the guard) fell — never applied.
- `approved` — cleared the approval policy and is safe to apply.
- `rejected` — failed validation or approval.

## Approval tiers
- **auto** — grounded, low-risk, non-safety-loosening: a description from a
  corroborated+ source, an example grounded by evidence/schema, an error message
  from corroborated+ evidence, or tightening retryability. Applied without a human.
- **review** — a human decides: weaker evidence, or anything the policy does not
  positively clear.
- **reject** — never applied (decided by validation or a measured regression).

## Never auto-approve from weak evidence
Loosening safety (`retryable=true`), removing confirmation, enabling retries,
changing requiredness, broadening permissions, or declaring a mutation reversible —
each needs strong (authoritative) evidence and, absent it, goes to review. Safety is
asymmetric: tightening is cheap, loosening is expensive.
