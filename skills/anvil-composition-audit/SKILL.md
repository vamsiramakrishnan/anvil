---
name: anvil-composition-audit
description: Run a deterministic cross-bundle overlap audit after large gateway imports and produce a bound, evidence-backed authority review before any multi-source execution.
---

# Compose audit harness for duplicated outputs and read authority

Use this skill when the estate already has multiple verified gateway-import bundles
and you need to find overlapping data exposures and decide *which exact source is
authoritative* for each overlap.

This is an audit workflow only. It never creates a child bundle, never approves
operations, and never emits a deployable MCP or multi-source tool surface.

## Preconditions

- The source contracts are imported as separate verified bundles: one coordinate
  per API/version/revision/environment (or per intentionally separate API
  contract).
- Every bundle was produced by `anvil estate import` and still passes:
  `anvil status <bundle> --json` and `anvil certify <bundle> --json` if used.
- You have local copies of any evidence you may cite in review files (code, docs,
  tests, architectural notes, traffic notes).

## 1) Build the estate selection + imports per coordinate

```bash
anvil estate connect <export> --vendor <vendor> --json
anvil estate plan <export> --vendor <vendor> --gateway-id <stable-gateway-id> \
  --init-selection estate-selection.yaml --out estate-plan.json
```

Use `estate-selection.yaml` as a bounded starting queue, then compile only rows you
intend to import:

```bash
anvil estate import <export> --vendor <vendor> \
  --api <api-id> --gateway-id <stable-gateway-id> --strict-identity \
  --revision <revision> --environment <environment> \
  --spec <contract.openapi.yaml> --gateway-url <https://gateway.example.test> \
  --out <bundle-out-dir> --json
```

`--spec` is preferred for the overlap layer; it converts route-only synthesis into
typed, bounded output shapes that composition can compare by schema and data-point.

## 2) Run a composition audit with explicit review scaffolding

Collect at least two verified bundle directories and initialize the scaffold:

```bash
anvil capability compose <bundle-a> <bundle-b> [bundle-c...] \
  --out composition.audit.json \
  --init-review composition.review.yaml
```

Outputs must be outside all input bundles and must not pre-exist.

`composition.audit.json` now contains:

- candidates (`output_duplicate`, `output_projection`, `data_point_duplicate`,
  `structural_leaf_overlap`)
- constrained auth intersections
- contradictions and lineage intersections (gateway identity, environment, revision,
  stale lineage, blocked findings)
- draft `authority` and `semantic` status (`unresolved` unless explicitly reviewed)

## 3) Review candidates without inventing authority

Edit `composition.review.yaml` as an offline artifact:

- Keep `inputDigest` and `candidateDigest` unchanged.
- For each selected candidate, set:
  - `semanticRelation` (`projection`, `same_fact`, or `not_equivalent`)
  - `readAuthority.decision` (`select` or `unproven`)
  - `note`
- Cite local evidence for `relationEvidence` and `authorityEvidence` using digest-bound
  local evidence files.

Authority is not inferred; it is a separate review axis.

For selection to be accepted for review output:

- selected member must be an exact `eligibleMember` id
- cited evidence factors for `system_of_record`, `lineage`, `freshness`
- every necessary factor passes the effective-confidence threshold

## 4) Re-run with review and inspect outputs

```bash
anvil capability compose <bundle-a> <bundle-b> [bundle-c...] \
  --out composition.reviewed.audit.json \
  --review composition.review.yaml
```

A reviewed overlap can move to:

- `status: reviewed` plus a `compositionPlan` with `buildReady: false` and
  `semanticRelation`, or
- `status: reviewed` with `semanticRelation: not_equivalent`

It still does not build MCP/CLI/skill. No auto-build output is possible from
cross-source composition yet.

## Good read-shaped evidence pattern

When two candidates are semantically equivalent or projected:

- verify output signatures at exactly the same scope
- verify same tenant/issuer/audience/principal story
- verify provider/grant/credential shape and scope intersection where available
- prefer a high-integrity source (implementation/docs with source impl evidence) over
  generated docs only as the authority driver

If blocked or stale identity differences remain, the candidate must stay unresolved
or unresolved-but-documented; never acknowledge around blocked findings to force
plan creation.

## What to keep separate

- Cross-bundle composition never changes operation states.
- It never resolves writes vs read conflicts.
- It never replaces enterprise runtime configuration.
- It does not create a deployable multi-source artifact.

Use it as the upstream signal for human semantic/authority review, then apply those
decisions in downstream, single-bundle approval flows.

## Reference

- `skills/anvil/reference/composing-capabilities.md`
- `skills/anvil/reference/gateway-estates.md`
- `skills/anvil/reference/durable-idempotency.md`
