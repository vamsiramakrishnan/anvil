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

## Correction

The existing Okta supplemental manifest supplies reviewed `name` pairs,
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
782 operations remain present. `expected/okta.json` pins the four new tool
names and their effect/risk alongside the existing user operations.

## Regression proof

`tools/corpus/fixtures/okta-naming.openapi.yaml` retains the four upstream
paths, methods, IDs, summaries and tags, plus the two existing blocked
federated-claim controls, while omitting unrelated schema content.
`okta-naming.test.ts` compiles it with the shipped manifest, checks
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
