# Okta naming regression, October 2026

Issue [#80](https://github.com/vamsiramakrishnan/anvil/issues/80), failing
[run 41038764817](https://github.com/vamsiramakrishnan/anvil/actions/runs/41038764817).

The October 27 upstream spec update exposed existing path-based inference
limits. It was not an Anvil compiler change: `naming.ts`, `normalize.ts` and
the naming-conformance oracle are unchanged between baseline commit `9463f16`
and failing Anvil commit `cd72461`.

## Source comparison

Compile `dist/current/management-minimal.yaml` from these two immutable
[Okta source revisions](https://github.com/okta/okta-management-openapi-spec):

| Revision | Published | Operations | Zero-overlap resources |
| --- | --- | ---: | ---: |
| `f8d2042784f1b853d3778b2b952fcd9830c598b1` | October 20 | 731 | 32 |
| `5cf2dc4d2e288c1b9c33a8f6f53c94d6ea70e679` | October 27 | 782 | 36 |

The four added failures below are new operations. None of the original 32
failures disappeared. The unchanged oracle tokenizes `effect.resource` and
`canonicalName`/`displayName`, allowing singularization but no synonym or
derivational-stem matching.

| Operation ID | Method and source path | Before: resource / CLI | Cause |
| --- | --- | --- | --- |
| `getApplicationsCsvExport` | `GET /api/v1/apps/export` | `app` / `okta apps export` | The path abbreviates the `Application` tag and applications noun in the operation ID and summary. |
| `listApplicationsBySearch` | `GET /api/v1/apps/search` | `app` / `okta apps search` | The same abbreviation has no lexical overlap with applications. |
| `previewPolicyBranchPromotion` | `GET /api/v1/policies/{policyId}/branches/{branchId}/lifecycle/promote/preview` | `promote` / `okta promote simulate` | The trailing-verb rule removes preview but leaves the preceding lifecycle method as the resource. |
| `restoreFromHistory` | `POST /api/v1/policies/{policyId}/history/{branchId}/lifecycle/rollback` | `rollback` / `okta rollback create` | The unrecognized lifecycle method becomes the resource; the summary and `PolicyBranch` tag identify what is restored. |

## Historical correction (2026.42.1)

The pinned historical Okta supplemental manifest supplies reviewed `name` pairs,
following ADR-0024. This is the integration's semantic mapping, using the
compiler's existing extension point. A global abbreviation dictionary or a
rule that skips arbitrary path verbs would require evidence across other
vendors; neither follows from these four cases.

| Operation ID | Resource | Routing verb | MCP tool |
| --- | --- | --- | --- |
| `getApplicationsCsvExport` | `application` | `export_csv` | `okta_export_csv_application` |
| `listApplicationsBySearch` | `application` | `search` | `okta_search_application` |
| `previewPolicyBranchPromotion` | `policy_branch_promotion` | `preview` | `okta_preview_policy_branch_promotion` |
| `restoreFromHistory` | `policy_branch` | `restore` | `okta_restore_policy_branch` |

The axis reprojects canonical, CLI and MCP names together, retaining operation
IDs and wire coordinates. It changes no effect kind/action/risk, auth,
idempotency, confirmation or approval. Restoring a live policy remains an
unapproved mutation with no inferred idempotency. The two federated-claim
writes remain explicitly blocked.

No baseline or oracle change is needed: the whole revised spec returns to
32 zero-overlap resources, zero stutters and five over-strip candidates. All
782 operations remain present in that source revision. The historical expected
fixture pins the four repaired tool names and their effect/risk; the live
`expected/okta.json` retains the existing user-operation expectations.

## Regression proof

`tools/corpus/fixtures/okta-naming.openapi.yaml` retains the four upstream
paths, methods, IDs, summaries and tags, plus the two existing blocked
federated-claim controls, while omitting unrelated schema content.
`okta-naming.test.ts` compiles it with `fixtures/okta-naming.manifest.yaml`, checks
all routing surfaces and preserved safety/wire fields, and proves that
removing any one mapping makes the unchanged oracle fail again.

```bash
pnpm exec vitest run tools/corpus
node tools/corpus/run.mjs quick --systems okta
```

Corpus recipe changes also run all six corpus lanes on pull requests. Issue
lifecycle updates are restricted to default-branch runs, so a green repair PR
cannot close a regression that is still present on main. Issue #80 should
close only after the integrated revision passes the complete corpus gate.

## November source withdrawal and CI follow-up

[PR #92's Quick job](https://github.com/vamsiramakrishnan/anvil/actions/runs/42530995148/job/128884923576)
passed Datadog and failed only Okta compilation. Source revision
[`68eed9d2039a59b5c7cf045ba1993a6cac7e0ec5`](https://github.com/okta/okta-management-openapi-spec/commit/68eed9d2039a59b5c7cf045ba1993a6cac7e0ec5),
published November 3 as version **2026.44.0**, removes 56 endpoints and adds none.
All four naming operations in the table above are absent by both operation ID
and method/path. The whole source now declares **726 operations**.

The compiler correctly rejects those four unmatched manifest entries with
`manifest_operation_unresolved`. Removing operations from the live source also
requires retiring their live naming-differential expectations. This correction
updates those two corpus inputs and retains the original mappings and exact
tool/effect/risk expectations beside the immutable October fixture:

- `fixtures/okta-naming.manifest.yaml` preserves the six historical entries.
- `fixtures/okta-naming.expected.json` preserves all four historical names and
  classifications. Every original October regression and negative ratchet test
  remains active.
- The live manifest retains `createFederatedClaim` and `replaceFederatedClaim`
  as blocked. The four live user-operation expectations are unchanged.
- `fixtures/okta-current.openapi.json` pins the current claim operations,
  transitive schemas and auth. `okta-source-drift.test.ts` proves the historical
  manifest still fails strictly on this source, while the live manifest
  preserves every operation field and both safety blocks.

The previous raw source SHA-256 is
`074366b36fe33ecbaba0e35def4b0665104dd29b528939399fab7851e10fc4c2`.
The current raw source SHA-256 is
`0e1ccf7a1c12f4e77e2e5cebf2d625f8869f7603746360a54e0360673644049f`.
The current cached bytes also match the upstream Git blob
`9dc71438ca1cea60632e57e280626460a0b0259c` at the pinned revision.

The full-source comparison is stronger than a naming-only comparison: all
**726 operations, the service, capabilities and every other AIR field are
identical** before and after, except removal of the four unresolved-entry error
diagnostics. Naming remains at **32 zero-overlap resources, zero stutters and
five over-strip candidates**. No compiler, oracle, baseline, source URL or
source selection changes. The source still compiles whole.

[`okta-source-withdrawal.json`](okta-source-withdrawal.json) records both source
hashes, every removed endpoint, the unchanged AIR comparison and naming counts.
