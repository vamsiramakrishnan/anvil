# Plaid user transfer limit naming, October 2026

This is the Plaid failure from issue [#80](https://github.com/vamsiramakrishnan/anvil/issues/80)
and [Quick differential run 41170475989](https://github.com/vamsiramakrishnan/anvil/actions/runs/41170475989/job/124447156216).
It reproduces independently of the Okta correction in #83.

## Immutable source comparison

Both versions are `2020-09-14.yml` from
[`plaid/plaid-openapi`](https://github.com/plaid/plaid-openapi).

| Version | Upstream revision | Published (UTC) | Operations | Over-strip candidates |
| --- | --- | --- | ---: | ---: |
| Passing | `496cde4222c0e6e9911796886b2b6fee45502ac9` | October 15, 19:25 | 350 | 15 |
| Failing | `09fe9d7026d935db59e59f3ed92dd65fd9d9d707` | October 30, 15:27 | 351 | 16 |

Raw SHA-256: passing `ea443cd78f6f6bb648c6f0c13f4b00095c3520dcaf45fc7930c36594227a43ee`;
failing `0914d09677392d647dd4c37740ea1b30bfdd33ac71a254c20c89822c9566c4be`.
The failing revision is byte-identical to the cached October 31 reproduction.
Both compile through the same unchanged compiler. No operation is removed.

The only addition is `userTransferLimitsGet`,
`POST /user/transfer/limits/get`, summary "Retrieve a user's transfer limits",
tag `plaid`. It returns persisted Guaranteed ACH transaction limits and daily,
weekly and monthly ceilings. The description explicitly says a transaction
limit is computed when no active limit exists. The upstream path is marked
`x-hidden-from-docs`; the corpus still compiles it and does not trim it away.

## Trace and correction

The CRUD trailing-method rule walks left from `get` to `limits`; normalization
correctly singularizes `limits` to `limit`. The canonical name remains
`user_transfer_limits_get`. No operation name or summary in the full spec
contains the standalone token `limit`, while `limits` is present. Therefore
the over-strip *candidate* oracle grows by one. This is not a malformed singular:
`singularize("limits") === "limit"` is correct. Zero overlap stays at one and
disambiguation stutters stay at 25.

The reviewed manifest names the complete source-scoped resource:
`{ resource: user_transfer_limit, verb: get }`. This produces
`get_user_transfer_limit`, CLI `plaid user_transfer_limit get`, and MCP
`plaid_get_user_transfer_limit`. The stable ID remains `plaid.limits.create`.
The explicit resource scopes the limit to the user and transfer domain;
its singular noun is now corroborated by the authored routing name. The
unrelated fifteen candidate resources remain measured by the same oracle.

Changing the general singularizer would break valid plural handling. Adding
an oracle exception or increasing its baseline would weaken the gate. This
case instead uses the existing supplemental-manifest extension point, with
no compiler, oracle, baseline, operation-count or source-selection changes.

The operation remains a **blocked financial mutation**, with the original
`create` effect action, irreversible classification, required confirmation,
no proven idempotency and no retries. The naming verb reflects the vendor's
declared operation; it does not assert pure-read semantics or approve exposure.
Wire inputs, output schemas, auth and stable identity remain unchanged.

## Regression checks

`tools/corpus/fixtures/plaid-naming.openapi.json` pins the new upstream path
and the existing `institutionsSearch` control, including transitive schemas
and provenance. Tests retain the valid singularization, prove that the
unrelated institution candidate is still counted, preserve every non-naming
field, and fail the unmodified oracle when the mapping is removed.
`expected/plaid.json` pins the MCP name and financial mutation classification
alongside the existing search/remove expectations in the complete spec.

```bash
pnpm exec vitest run tools/corpus/plaid-naming.test.ts
node tools/corpus/run.mjs quick --systems plaid
```
