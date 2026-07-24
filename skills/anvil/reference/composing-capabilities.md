---
name: anvil-composing-capabilities
description: Compare read capabilities across verified generated bundles, investigate evidence candidates, and record human-reviewed semantic and source-authority decisions without generating a multi-source MCP server.
---

# Review cross-source capability composition

Use this workflow only after each source API is a verified generated Anvil
bundle. It compares read outputs across bundle boundaries without changing the
input bundles and writes new audit/review artifacts outside them.

This is deliberately different from single-bundle capability grouping:

- `capability propose/show/approve/build` groups reviewed operations inside
  one bundle and can build a child bundle after approval.
- `capability compose` compares two or more bundles and stops at an audit or
  a human-reviewed plan record. It never writes AIR, CLI, MCP, skill, approval,
  build, deploy, or fallback routing.

## Roles and flow

1. **Deterministic discovery** extracts output data points, full schema closure,
   operation coordinates, receipt lineage, auth identity, and safety policy. It
   emits evidence candidates and contradictions; it never assigns authority.
2. **Coding-agent investigation** can trace handlers, repositories, contract
   tests, and owners; write a bounded local evidence artifact; and propose edits
   to the review manifest. Its similarity judgement is not proof or approval.
3. **Human authority** reviews the frozen evidence, records semantic relation
   separately from scoped read authority, and leaves uncertainty explicit.

```bash
anvil capability compose <bundle-a> <bundle-b> [bundle-c...] \
  --out composition.audit.json \
  --init-review composition.review.yaml

# Preserve the scaffold bindings, edit a separate review file, then rerun.
anvil capability compose <bundle-a> <bundle-b> [bundle-c...] \
  --out composition.reviewed.audit.json \
  --review composition.reviewed.yaml
```

Inputs must be verified generated bundle directories. The command is offline
and does not modify them, but it does write the required new external
`--out` and review artifacts. Every destination is exclusive/no-overwrite,
must be outside every input bundle, and is published transactionally.

## What discovery means

Candidate kinds have intentionally different strength:

- `data_point_duplicate` requires the same explicit
  `x-anvil-data-point`; a generic `/id` pointer is not semantic identity.
- `output_duplicate` requires the full normalized output schema and referenced
  schema closure to match.
- `output_projection` proves only that one exact leaf signature is a strict
  subset of another. Its minimized disclosure is the projected field set; it
  does not invent an executable transform.
- `structural_leaf_overlap` is an investigation lead, never a duplicate.

For example, an explicit `customer.id` exposed by five APIs yields an
unresolved duplicate candidate. A customer application view that is an exact
field subset of a customer master output yields a bounded projection candidate.
Two same-shaped case views with different OAuth scopes remain blocked, even if
their JSON is identical.

Read these audit fields before editing review:

- `sources[].contractDigest`, lineage, receipt trust, exact gateway identity,
  environment, and revision;
- candidate `id`, `digest`, `eligibleSources`, `eligibleMembers`,
  evidence coordinates, confidence basis, contradictions, and effective
  auth/safety constraints;
- projection proof and `minimizedDisclosure`, when present;
- `disposition` (`unresolved|candidate|reviewed`) and separate semantic/read
  review status;
- report, input, candidate, and review digests; and
- the hard boundary: `generatedMcp:false`, `autoApproved:false`,
  `buildReady:false`.

Gateway receipt status is part of source identity. Different prod/test
environments or same-API revisions are blocked contradictions; missing,
invalid, stale, or blocker-bearing receipt lineage cannot be laundered through
composition.

## Exact review contract

Do not change `inputDigest`, `candidateDigest`, candidate ids/digests, or the
sorted `eligibleSources` and `eligibleMembers` copied into the scaffold.

For `semanticRelation: same_fact` or `projection`:

- add a non-empty review note;
- cite relation evidence whose `memberIds` name every exact eligible member;
- reach effective confidence of at least 0.5 (declared confidence multiplied by
  AIR's canonical `sourceKind` reliability); and
- provide `sourceKind`, a normalized relative local-file `sourceRef`, and
  mandatory `artifactDigest: sha256:<64 lowercase hex>`.

Each `sourceRef` resolves below the review manifest directory. It must be a
non-empty regular file, not a symlink, at most 1,048,576 bytes. Anvil re-hashes
its current bytes and records the verified reference in the audit. This proves
the cited local bytes were present and digest-matched at rerun time, not the
claim's truth or source freshness.

For `readAuthority: { decision: select, selectedMember: ... }`:

- select one exact eligible member, never a source label or inferred fallback;
- cite verified `system_of_record=true`, `lineage`, and
  `freshness=current` factors for that member;
- give each necessary factor effective confidence at least 0.5; and
- acknowledge every otherwise-resolvable `review_required` finding id.

The aggregate authority confidence is transparent, display-only, and never
selects or qualifies a source. `write_authority` is recorded debt and
contributes nothing to a read selection. A blocked finding, missing data
classification/minimization semantic, or unproven auth tenant cannot be waived
by acknowledgement, a note, or high confidence. Auth intersection preserves
issuer, audience, carrier, principal, provider/grant/delegation, credential
profile, tenant, secret source, and every required scope; equal absence is not
proof.

`generated_mock` and `inferred` have canonical reliabilities below 0.5, so
they can never establish a reviewed semantic relation or necessary authority
factor by themselves, even with declared confidence 1.

Use `readAuthority: { decision: unproven }` with a note when no scoped read
authority is established. Use `semanticRelation: not_equivalent` with a note
to close a false match. Either can be a reviewed decision but creates no plan.
Writes, write authority, runtime fallback, cross-source retry, and multi-source
transactions are outside this read-only semantic slice.

## Honest stopping point

Only a reviewed semantic relation plus a separately reviewed exact read member
can produce `status: reviewed_plan_only`. That record remains
`buildReady:false`; it is an input-, review-, evidence-, and contract-digest
bound design record for a future explicit materialization gate, not executable
input today. The audit report itself must
never be passed to `capability approve`, `build`, `publish`, or `deploy`.
Anvil has no safe multi-source AIR/MCP materializer yet; stop here.
