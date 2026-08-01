# Quality bug-bash — findings

Produced by a 6-cluster, 3-stage agent fleet (find → adversarially verify →
fix) covering every package: `air`+`generators`+compiler-core, the gateway
estate adapters, `runtime`+`mcp-runtime`, `cli`, `refinement`, and the
eval/cert infra (`harness`+`simulator`+`certification`+`system-pack`+`targets`).
Each cluster's finder read source with no prior bias; a separate verifier
agent then re-read the same code adversarially, defaulting to skeptical, and
only "confirmed" defects it personally reproduced from the current source.

**Result: 22 candidate defects found, all 22 independently confirmed (zero
false positives), all 22 fixed.** `pnpm build`, `pnpm typecheck`, `pnpm lint`,
and `pnpm test` (2,596 tests across 23 packages) are green on the resulting
tree. Severities below are the verifier's post-review call, not the finder's
initial guess.

## AIR, codegen foundry & compiler core (2 found, 2 fixed)

| # | Sev | Location | Defect | Fix |
|---|-----|----------|--------|-----|
| 1 | high | `compiler/src/contract/overlay.ts` | `state` was absent from `CONTRACT_SAFETY_PREDICATES` (and had no case in `resolution.ts`'s `isLoosening`), so an overlay could flip an operation straight to `approved` — or lift a `blocked` state — from *any* origin, including low-authority `investigation`/`observed_traffic`, with only an info diagnostic. | Added `state` to `CONTRACT_SAFETY_PREDICATES` and a dedicated `isLoosening` case: a move to `approved` or off `blocked` now requires an authoritative origin via the existing `canLoosen`/`authorityFor` gate, and two operators contesting `state` now raises a safety-sensitive conflict. |
| 2 | high | `generators/src/mcp.ts` | The generated MCP **SSE** server template (`generateMcpSseServerSource`) performed no inbound-auth check on `GET /sse` or `POST /messages`, unlike the StreamableHTTP `generateRuntimeServer` output — a generated SSE deployment served every tool unauthenticated. | Generated SSE template now imports the same `loadInboundAuthConfig`/`verifyInboundToken`/`protectedResourceMetadata` machinery, serves `/.well-known/oauth-protected-resource`, and gates both routes behind `authorized()`; session identity threads through `withInboundIdentity` so OBO credential resolution works over this transport too. |

## Gateway estate adapters (7 found, 7 fixed)

| # | Sev | Location | Defect | Fix |
|---|-----|----------|--------|-----|
| 1 | high | `compiler/src/gateway/apigee/adapter.ts` | `extractApi()`'s proxy matcher treated a missing `revision`/environment on a candidate as a wildcard match instead of a hard constraint (`!proxy.revision \|\| proxy.revision === api.version`) — a caller requesting a specific revision of a duplicate-named proxy could silently get routed to an unrelated (e.g. draft) proxy while the receipt still claimed the requested revision. | Rewrote the predicate so a caller-supplied version/environment is a hard `!==` constraint, never satisfied by an absent candidate field. |
| 2 | high | `compiler/src/gateway/apiconnect/adapter.ts` | Same class of bug: `(!api.version \|\| !candidate.version \|\| candidate.version === api.version)` let a versionless candidate satisfy any requested version. | Same hard-constraint rewrite. |
| 3 | high | `compiler/src/gateway/mulesoft/adapter.ts` | Same class of bug for `productVersion`/`instanceLabel`. | Same hard-constraint rewrite. |
| 4 | med | `compiler/src/gateway/kong/adapter.ts` | `extractApi()` ignored `api.version`/`api.environmentId` entirely — Kong declarative config has no such field, so the caller's disambiguating axis was silently dropped rather than surfaced. | Kong genuinely has nothing to check the axis against, so instead of a false hard-match, a `kong/unenforced_coordinate_axis` warning diagnostic now tells the caller the axis could not be verified. |
| 5 | med | `compiler/src/gateway/apiconnect/adapter.ts` | Inventory `authSummary` was derived only from `api.oauthProviders`, ignoring scope-derived auth facts surfaced elsewhere in the same adapter. | `authSummary` now also considers `norm.facts.length > 0`. |
| 6 | med | `compiler/src/gateway/mulesoft/adapter.ts` | `authSummary` was set only inside one policy branch, ignoring resource-level `scopes` facts collected elsewhere in `normalizeApi`. | Falls back to `"scoped"` when facts were collected but no policy branch set it. |
| 7 | low | `compiler/src/gateway/wso2/adapter.ts` | Inventory `authSummary` derived solely from the API-wide `securityScheme` array, ignoring per-operation `authType`/`scopes`. | `authSummary` now also reflects per-operation `authType`/`scopes`. |

## Safety hot path & MCP serving (2 found, 2 fixed)

| # | Sev | Location | Defect | Fix |
|---|-----|----------|--------|-----|
| 1 | high | `runtime/src/executor.ts` | When an upstream mutation returned 2xx but `ctx.ledger.complete()` then threw, `execute()` returned the structured `idempotency_ledger_unavailable` error **without ever invoking `postResponse`/`postExecute`/`postError` policy hooks** — a real HTTP response existed but no hook ever saw it. | `postResponse` then `postExecute` are now run (mirroring the success path) before returning the ledger-unavailable failure. |
| 2 | low | `runtime/src/executor.ts` | In that same catch branch, `record.ledger` was left at the stale `"reserved"` instead of reflecting the now-ambiguous/orphaned state. | Same fix sets `record.ledger = "in_progress"`, matching the sibling `sawPostResponseFailure` branch. |

## CLI + shared tool-CLI engine (6 found, 6 fixed)

| # | Sev | Location | Defect | Fix |
|---|-----|----------|--------|-----|
| 1 | med-high | `cli/src/commands/simulate.ts` | `--seed` parsed via `Number.parseInt(opts.seed ?? "1", 10) \|\| 1` silently coerced **both** `--seed 0` and a non-numeric seed to `1`, contradicting the command's documented determinism contract. | `--seed 0` now runs with seed 0; a non-finite/negative value is a structured validation error (exit 1) naming `--seed`. |
| 2 | low | `cli/src/commands/case.ts` | `add-evidence --confidence <v>` silently dropped a non-numeric value to `undefined` instead of erroring. | Non-finite `--confidence` is now a validation error naming the flag. |
| 3 | med | `cli/src/commands/case.ts` | `--lines abc` fell back to `undefined` start/end via a `NaN` → `Number.isFinite` guard instead of erroring — recorded evidence against the whole file silently. | A `--lines` value that fails to parse is now a validation error naming the flag. |
| 4 | med | `cli/src/commands/idempotency-store.ts` | `runDeployLedger` returned via `renderNoStore` for `backend === "none"` **before** validating `--ttl-seconds`/`--database-mode` consistency, so a no-store bundle silently accepted flags a firestore-backed one would reject. | Validation now runs before the `backend === "none"` early return; `--tfvars` handling for `none` is intentionally left last since it always emits `{}`. |
| 5 | med | `cli/src/commands/conformance.ts` | Delegated straight to `@anvil/harness`'s `runConformance`, which does a bare `readFileSync(air.json)` — a bundle missing `air.json` surfaced a raw `ENOENT` instead of the friendly "run `anvil compile` first" message its sibling commands give. | CLI command layer now checks for `air.yaml`/`air.json` before delegating and raises the same friendly message (fixed at the CLI boundary per this cluster's file scope; harness's own raw-`ENOENT` behavior is unchanged). |
| 6 | low | `cli/src/commands/approve.ts` | `markGatewayLineageStale`'s substantive body (target-kit verification, stale-receipt rewrite) was dead: `assertImmutableGatewayLineage` unconditionally throws first whenever a receipt-bound bundle's projections changed, so the function's real logic was unreachable. | Removed the dead function; `reprojectBundleAtomically` now passes a literal `false` (its only ever-reachable return value) directly. The now-vestigial `gatewayStaleReason` parameter was also removed from `reprojectBundleAtomically` and all three call sites (`approve.ts`, `capability.ts` ×2). |

## Refinement: case battery, evals, review, skills (2 found, 2 fixed)

| # | Sev | Location | Defect | Fix |
|---|-----|----------|--------|-----|
| 1 | high | `refinement/src/case/battery/effectiveness.ts` | `runEffectivenessCase` called `closeCase()` unguarded whenever `readInvestigation` reported `"proposal_generated"` — but that status is also true when `validate-proposal` was simply never run, and `closeCase` then **throws**, crashing the whole battery loop and discarding every row computed so far. | The realistic "agent stopped before validate-proposal" case is now caught and scored as a non-grounded, non-crashing outcome, matching how the scripted-scenario runner already treats it. |
| 2 | med | `refinement/src/case/proposal.ts` | `validateCaseProposal`'s per-clause loop used an unscoped `.find()` over validation outcomes, so one key's failure reason (e.g. `retryable` failing `evidence_supports_value`) could be misattributed to a different, fully-grounded clause (e.g. `message`); `evidence_meets_verification` failures weren't consulted at all, so a proposal rejected only on that check reported every clause as supported. | The lookup is now scoped to each clause's own key (`o.reason.includes(key)`) and includes `evidence_meets_verification`. |

## Eval harness, simulator, certification, system-pack, targets (3 found, 3 fixed)

| # | Sev | Location | Defect | Fix |
|---|-----|----------|--------|-----|
| 1 | high | `certification/src/checks.ts` | The `exec/fault_injection` check picked any served operation (`served[0]`) when no read op existed, so a mutation-only approved surface hit the confirmation/idempotency gates before ever reaching the fault-injection branch — a false certification failure unrelated to fault handling. | The check now invokes the picked operation with `confirm: true` and an `idempotencyKey` set regardless of read/mutation, so it reaches the fault path. |
| 2 | med-high | `harness/src/reconcile.ts` | `reconcile()` computed the acceptance threshold from the **max-reliability** claim in a group but wrote the applied patch from `considered[0]` — the first claim in source-config order — so `applyClaim` could receive a different, lower-reliability finding's fields than the one that actually justified acceptance. | Now selects the claim that achieved the max reliability (via `reduce`) as the one actually applied. |
| 3 | low | `certification/src/coverage.ts` | The `"none"` fault-variant's expected outcome was a ternary whose two branches were both the literal `"ok"` — dead conditional, no behavior difference, just confusing to read. | Replaced with the literal `"ok"`. |

## Process notes

- Two of the six fixer agents mis-reported their own output (one returned an
  empty `changes: []` despite doing the work; one hit a structured-output
  retry cap after making its edits) — in both cases the on-disk diff was
  verified directly against every confirmed finding rather than trusting the
  agent's self-report, per "trust but verify."
- One mechanical follow-up beyond the fleet's own scope: removing
  `markGatewayLineageStale` (CLI finding #6) left `reprojectBundleAtomically`'s
  `gatewayStaleReason` parameter unused; that parameter and its three call
  sites (`approve.ts`, `capability.ts` ×2) were removed by hand after the
  fleet finished, verified by `pnpm lint`/`typecheck`/`test`.
- Biome flagged pre-existing lint debt in two files this bash's fixers never
  touched (`air/src/idempotency-carrier.bugbash.test.ts`,
  `cli/src/wso2-apictl.bugbash.test.ts`, plus a couple of others under
  `harness/`) — left untouched as out of scope; `pnpm lint` still exits 0
  since those are warnings (`noExplicitAny`), not errors.
