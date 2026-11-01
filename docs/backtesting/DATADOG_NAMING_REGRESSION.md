# Datadog temporary grant request naming, October 2026

This is the Datadog failure from issue [#80](https://github.com/vamsiramakrishnan/anvil/issues/80)
and [Quick differential run 41170475989](https://github.com/vamsiramakrishnan/anvil/actions/runs/41170475989/job/124447156216).
It reproduces independently of the Okta correction in #83.

## Immutable source comparison

Both versions are `.generator/schemas/v2/openapi.yaml` from
[`DataDog/datadog-api-client-go`](https://github.com/DataDog/datadog-api-client-go).
The October 30 passing job compiled Datadog at 10:15 UTC, after the 09:57
revision and before the afternoon additions. The current source below is
byte-identical to the cached spec that reproduced the October 31 failure.

| Version | Upstream revision | Operations | Zero overlap | Over-strip candidates |
| --- | --- | ---: | ---: | ---: |
| Passing | `895aba8fe59e6c088216212fb47c67c02b0d50ab` | 1,700 | 57 | 29 |
| Failing | `75501867b7c57b8b93e72c4c744d4acb0deb3735` | 1,712 | 58 | 29 |

Raw SHA-256: passing `3b65e9b251905416a0696584642789da62b5c948aa2bf352d4b860eb62791edc`;
failing `8657b01aff06a678f497362f01cd1e4955818ac373bdf7f0b67f291c11bcc0cd`.
Both compile with the same unchanged compiler. No operation is removed. The
original 57 zero-overlap cases remain; exactly one new operation adds the 58th.

### The twelve additions

The [13:39 UTC source commit](https://github.com/DataDog/datadog-api-client-go/commit/fd43c31199c3dadcd41c3bdd3af49ca0ea7aa1b0)
introduces the eight temporary grant request operations. Prefixes below are
`A = /api/v2/usage/admin/temporary-grant-requests` and
`U = /api/v2/usage/temporary-grant-requests`.

| Operation ID | Method | Path |
| --- | --- | --- |
| `ListTemporaryGrantRequests` | GET | A |
| `GetTemporaryGrantRequest` | GET | A/{request_id} |
| `UpdateTemporaryGrantRequest` | POST | A/{request_id}/decision |
| `DeleteRequestedTemporaryGrant` | DELETE | A/{request_id}/grant |
| `ListMyTemporaryGrantRequests` | GET | U |
| `CreateTemporaryGrantRequest` | POST | U |
| `GetMyTemporaryGrantRequest` | GET | U/{request_id} |
| `DeleteTemporaryGrantRequest` | DELETE | U/{request_id} |

The [15:43 UTC source commit](https://github.com/DataDog/datadog-api-client-go/commit/4d0e0d6af7d438467d4f9649f2598dae06a642c2)
adds four cloud-authentication intake mapping operations under
`/api/v2/wif/aws/intake_mapping`: `ListAWSCloudAuthIntakeMappings` (GET),
`CreateAWSCloudAuthIntakeMapping` (POST), `GetAWSCloudAuthIntakeMapping`
(GET /{intake_mapping_id}), and `DeleteAWSCloudAuthIntakeMapping`
(DELETE /{intake_mapping_id}). None adds a naming-conformance failure.

Those AWS additions do create ID collisions with four existing GitHub intake
mapping operations. The unchanged collision resolver appends `.github` to
their IDs and `_github` to their canonical/MCP names (and `.aws`/`_aws` to
the new family). This is a separate, expected consequence of the larger spec,
not a change introduced by the manifest. The repair is compared against the
entire **current** spec so these resolved identities are preserved.

## Trace and correction

`UpdateTemporaryGrantRequest` has summary "Decide a temporary grant request"
and tag `Usage Metering`. Its body supplies an approved/denied decision; its
response is a temporary grant request. Approval atomically writes the grant,
audit record and request decision, and requires an authenticated human with
Billing Edit permission. The request, rather than a generic decision, is the
resource being acted on.

`deriveNames` takes the final concrete segment `decision`. It is neither a
recognized trailing action nor a CRUD method segment, so re-homing leaves it
alone. `normalize` singularizes it to `decision`. The oracle compares that
token with `update_temporary_grant_request` and the summary; singularization
does not turn `decide` into `decision`, so there is no overlap.

The supplemental manifest uses the existing `name` axis:
`{ resource: temporary_grant_request, verb: decide }`. This produces
`decide_temporary_grant_request`, CLI `datadog temporary_grant_request decide`,
and MCP `datadog_decide_temporary_grant_request`. The stable operation ID remains
`datadog.decision.update`.

This is a vendor-semantic mapping, not evidence for globally discarding a
`decision` path segment: other APIs can have real decision resources. No
compiler heuristic, oracle, baseline, source selection or operation count is
relaxed. The existing mutation/action/risk, blocked state, required
confirmation, absent idempotency and single-attempt retry policy are retained.

## Regression checks

`tools/corpus/fixtures/datadog-naming.openapi.json` pins the affected upstream
path plus the neighbouring administrator/user get and user delete operations,
with their transitive schemas and auth. Its provenance records the source
revision and reduction. The test checks every unaffected operation for exact
equality and every affected field except names and derived naming metadata.
Removing the mapping makes the unmodified zero-overlap oracle fail again.
`expected/datadog.json` also pins the new MCP name and mutation/risk in the
full live-spec quick lane, alongside the existing retention-filter controls.

```bash
pnpm exec vitest run tools/corpus/datadog-naming.test.ts
node tools/corpus/run.mjs quick --systems datadog
```
