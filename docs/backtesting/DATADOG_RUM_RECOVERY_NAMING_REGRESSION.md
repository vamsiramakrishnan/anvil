# Datadog RUM recovery count naming, November 2026

Issue [#90](https://github.com/vamsiramakrishnan/anvil/issues/90),
[November 8 run 42471774489](https://github.com/vamsiramakrishnan/anvil/actions/runs/42471774489/job/128703976485).
One operation causes both new counters: `GetRUMRecoverySessionCount`,
`POST /api/v2/rum/recover/count`. This is independent of the temporary grant
request mapping shipped in [#85](https://github.com/vamsiramakrishnan/anvil/pull/85).

## Source comparison

All revisions below are `.generator/schemas/v2/openapi.yaml` in
[`DataDog/datadog-api-client-go`](https://github.com/DataDog/datadog-api-client-go).
The [last passing Quick job](https://github.com/vamsiramakrishnan/anvil/actions/runs/41818610849/job/126535720550)
was November 4, even though that run's aggregate
Corpus gate failed in another lane. Its Quick job passed all 34 systems.

| Source | Revision | Operations | Zero overlap | Over-strip candidates |
| --- | --- | ---: | ---: | ---: |
| November 4, last passing Quick | `9bd636d3a72ecbaac7dcdc7c8fc68e523a198b0c` | 1,712 | 57 | 29 |
| Immediately before RUM addition | `5fd312c98640d29033b76cc5ad5ee6ab700b174f` | 1,774 | 57 | 29 |
| November 8, before repair | `b3efbc77fc7ff765a88e87b5906c47dcf4f3bdba` | 1,784 | 58 | 30 |
| Same November 8 source, repaired | same | 1,784 | 57 | 29 |

The source SHA-256 values are, in table order:

- `8cba49be1f1dbf93b88340c6bd4e92e93d8dd09d69cfb36ab3894492509f393f`
- `702cb6bda56c128f8a99bce24f337fb319ec702b2ce0d62a6337677ac0f3b2ff`
- `3f70db62432916ca59e0f17c27997eef477cd7e2c2d185ed22c9abc1ac6f9f62`

The [introducing commit](https://github.com/DataDog/datadog-api-client-go/commit/b3efbc77fc7ff765a88e87b5906c47dcf4f3bdba)
landed November 6 at 20:57:13 UTC. It adds ten operations: four RUM archive
configuration operations, the recovery-session count, four recovery-request
operations, and archived-session search. Only the count adds a naming defect.
The parent revision proves that the other additions since November 4 do not
raise either counter.

The November 4 to November 8 delta is **78 added method/path coordinates and
six removed**, for a net increase of 72. The removed operations belong to the
Salesforce-incidents integration: four incident-template operations and two
organization operations. Anvil still compiles every operation declared by
the November 8 source. The immutable
[`datadog-rum-recovery.sources.json`](../../tools/corpus/fixtures/datadog-rum-recovery.sources.json)
lists every added, removed, and RUM-introduced coordinate, with revisions,
hashes, and run IDs.

| Added operation family | Count |
| --- | ---: |
| AI Gateway | 52 |
| Temporal Cloud OpenMetrics accounts | 5 |
| Custom OIDC cloud authentication | 8 |
| Security Agent investigations | 3 |
| RUM archives and recovery | 10 |

These 78 additions and six Salesforce-incidents removals account for the
complete 72-operation net increase; no unrelated additions need renaming.

## Inference trace and repair

1. The source declares `GetRUMRecoverySessionCount`, summary “Estimate
   recoverable sessions”, with `RumRecoveryCountRequest` and
   `RumRecoveryCountResponse`. The response contains `estimated_count` and
   `max_recoverable_sessions`. The endpoint estimates a count; it does not
   create a recovery request.
2. `deriveNames` initially selects the trailing `count` segment.
   `rehomeMethodSegments` recognizes that CRUD method word and walks left to
   `recover`. The estate's non-terminal-segment guard retains `recover`, which
   also appears before `requests` and `sessions`.
3. `normalize` assigns resource `recover`. The canonical name remains
   `get_rum_recovery_session_count`; the HTTP/path routing action produces
   stable ID `datadog.recover.create` and CLI `datadog recover create`.
4. The unchanged oracle finds no shared token between `recover` and the
   canonical/display names. It also sees `recovery`, two letters longer than
   `recover`, and adds `recover` to the distinct over-strip candidate set.
   `singularize("recover")` is already `recover`: this is a resource-inference
   defect and a lexical candidate, not an inflector truncating a noun.
5. The supplemental manifest's existing `name` axis sets
   `{ resource: rum_recovery_session_count, verb: get }`.
   `manifestToOverlay` carries only the naming assertions; the shared
   `applyOperationManifest` projection corrects the resource and CLI command.

| Field | Before | After |
| --- | --- | --- |
| Stable ID | `datadog.recover.create` | unchanged |
| Canonical name | `get_rum_recovery_session_count` | unchanged |
| MCP tool | `datadog_get_rum_recovery_session_count` | unchanged |
| Resource | `recover` | `rum_recovery_session_count` |
| CLI | `datadog recover create` | `datadog rum_recovery_session_count get` |
| Effect / action / risk | mutation / simulate / medium | unchanged |
| State / idempotency / attempts | blocked / none / 1 | unchanged |
| Confirmation | required | unchanged |

A global change to `recover` handling would lack evidence: other APIs can
expose actual recovery actions or resources. The precise source semantics are
available here, so an operation-scoped manifest is sufficient. No compiler,
oracle, naming baseline, source selection, or quality threshold changes.

The source requires API-key **and** application-key authentication. Naming does
not approve the operation or remove either factor. Existing manifest enrichment
adds its provenance claim and an additional diagnostic about the existing
missing credential carrier; all earlier blocking notes remain. Authentication
fields and the blocked state are exact. The conservative mutation classification
also remains, despite the endpoint's estimation semantics.

## Regression evidence

[`datadog-rum-recovery.openapi.json`](../../tools/corpus/fixtures/datadog-rum-recovery.openapi.json)
pins five upstream operations with all 52 transitive local references, security
schemes, servers, and relevant tags. Controls include create/get recovery
requests, archived-session search, and the already-corrected temporary grant
request. The original October fixture is unchanged; its test applies only its
own mapping because strict absent-operation diagnostics still apply.

The targeted test failed before the repair with both fixture counters at 1
instead of 0. It now checks:

- exact equality for neighbouring operations;
- exact stable identity, canonical/MCP names, inputs, outputs, auth, effects,
  risk, confirmation, idempotency, retries, and other fields on the target;
- the two permitted routing changes and exact derived evidence/review metadata;
- both unchanged ratchets fail again if only the new mapping is removed;
- immutable source provenance, complete local references, and both auth factors.

The full-spec comparison at Anvil base
`c2d31108e2b02d8a543a7c1b01e8246f546bd6c9` compares serialized AIR from the
same 1,784-operation source with the shipped manifest before/after this change.
**1,783 operations are identical.** Exactly one has the two routing changes and
derived evidence/review metadata described above. The complete service definition
is unchanged. The RUM Recovery capability's derived resource list replaces
`recover` with `rum_recovery_session_count`; its identity, operation membership,
approval state, and other fields are exact. Every other top-level field is
unchanged. Machine-readable counters and every changed field are in
[`datadog-rum-recovery-comparison.json`](datadog-rum-recovery-comparison.json).

```bash
TURBO_TELEMETRY_DISABLED=1 ASTRO_TELEMETRY_DISABLED=1 pnpm build
pnpm exec vitest run tools/corpus
node tools/corpus/run.mjs quick --systems datadog
```

To reproduce the immutable full-spec comparison, fetch the failing revision's
raw source using the repository, path, revision, and SHA-256 in the sources
fixture. Compile the same bytes twice with `serviceId: "datadog"`: first with
the current manifest minus `operations.GetRUMRecoverySessionCount`, then with
the complete manifest. Apply `measureNamingConformance` and
`namingConformanceOracle` with the unchanged Datadog baseline. Compare all
serialized operation fields, allowing only the target deltas recorded in the
comparison JSON. For the historical rows, use the November 4 and parent source
revisions with the manifest minus the new mapping; the earlier temporary grant
request mapping remains present in every comparison.

The November 8 Quick log also contains an independent Okta compile error from
manifest entries absent in its upstream spec. Fixing Datadog cannot repair that
failure. It is outside this naming correction.

The live Datadog quick lane passes compilation, determinism, round-trip, lint,
time/size budgets, naming differential, naming conformance, and operation-count
checks. Its self-test oracle reports a skip because the manifest approves no
operations; this change grants no execution authority. The report JSON retains
each oracle's exact result and detail. All five tracked corpus baseline files
are byte-identical to the repository base; their SHA-256 values are recorded.

| Local check | Result |
| --- | --- |
| Corpus regression tests | 51 passed across seven files |
| Workspace build and typecheck | Passed |
| Workspace lint | Passed; 28 existing warnings and three informational diagnostics |
| Documentation check / production build | Passed; 94 pages validated / 96 built |
| Full live Datadog corpus | Green, 1,784 operations; unchanged 57 / 29 naming counters |
| Full Quick sweep | All 33 compiled systems hold their naming counters; Okta does not compile |
| Confluence timing recheck | Passed at 1,177 ms after an initial 3,985 ms time-budget failure during concurrent checks; threshold unchanged |
| Workspace suite | Two unchanged network-interface suites fail at module load: `uv_interface_addresses` returns system error 1 in this environment |

The environment failures occur in
`packages/generators/src/mock-server.test.ts:27` and
`packages/harness/src/served-loopback-guard.test.ts:164`, before their assertions
run. Both files are byte-identical to the base commit, and the same OS call fails
in a standalone Node process. The workspace continuation run uses
`--continue=always`; it stopped before the final CLI/harness summaries, so the
unfinished files were checked in bounded batches. No tests or quality checks
are disabled. Results account for all 478 package test files; the two module-load
failures above are the remaining environment limits. The separate seven-file
corpus suite passes all 51 tests.
