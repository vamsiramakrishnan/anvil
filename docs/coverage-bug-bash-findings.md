# Coverage bug-bash — findings

Produced by the mixed Sonnet/Haiku coverage bug-bash (see
`docs/coverage-bug-bash-plan.md`). 22 new `*.bugbash.test.ts` files added
~890 test cases. Each genuine defect below was first **encoded in the test
suite** as an `it.fails(...)` (or `it.skip`) with a `// BUG:` comment — the
assertion documenting the *correct* behavior.

**Status: all 12 confirmed defects are now FIXED.** Each fix landed in its
source file and its pinned test was flipped from `it.fails`/`it.skip` to a
normal passing `it(...)` that asserts the corrected behavior, so the suite now
proves the fix rather than the bug. The "Fix" column records the change; the
low-severity observations at the bottom remain open (noted, not fixed).

## Defects found — all fixed

| # | Sev | Location | Defect | Fix |
|---|-----|----------|--------|-----|
| 1 | med-high | `cli/src/tool-cli.ts` | Second, **unguarded** `remoteMcpTarget()` (custom `--mcp` + `--mcp-token-env`) threw uncaught instead of a structured `validation_error`. | Wrapped in the same try/catch as the first call → `validation_error`, exit 2. |
| 2 | med-high | `harness/src/conformance.ts` | **Safety-contract violation** — a JSON key `bearer_token` was **not** redacted (the `token` pattern's `\b` boundary fails across `_`), leaking into the conformance report. | Generalized the pattern to `[a-z]+[-_]token` so every `*_token`/`*-token` key is redacted. |
| 3 | high | `refinement/src/case/battery/effectiveness.ts` (`buildAir`) | Synthetic op omitted the required `displayName`, so `anvil case battery --real` crashed (Zod) on the first of 30 cases. | Set a derived `displayName`; the command now validates and reaches the real containment preflight. |

<details><summary>Original defect table (for reference)</summary>

## Confirmed defects (originally asserted via `it.fails` / `it.skip`)

| # | Sev | Location | Defect |
|---|-----|----------|--------|
| 1 | med-high | `cli/src/tool-cli.ts:496` | When a custom `--mcp` connector is combined with a resolved `--mcp-token-env`, a malformed target reaches a **second, unguarded** `remoteMcpTarget()` call and throws an uncaught exception instead of the structured `validation_error`/exit 2 the connector-less path returns — violates the "structured errors, never raw exceptions" guarantee. |
| 2 | med-high | `harness/src/conformance.ts:760-761` (`safeCliStream` ~896-904) | **Safety-contract violation.** The secret-redaction pattern set covers `access_token`/`refresh_token`/`id_token` but **not** a JSON key literally named `bearer_token` (the `\b` boundary fails across the underscore). CLI stdout/stderr containing `"bearer_token":"<secret>"` lands in the conformance report **unredacted**. |
| 3 | high | `refinement/src/case/battery/effectiveness.ts:78-98` (`buildAir`) | The synthetic operation built for each of the 30 effectiveness cases never sets `displayName`, which `air/src/schema.ts:668` declares **required**. `anvil case battery --real` therefore crashes with a Zod error on the first case, in JSON mode, human mode, and the refusal path alike — the whole subcommand is broken regardless of inputs. |
| 4 | med | `cli/src/commands/approve.ts:100-119` | `runApprove` computes `newlyApproved` from **pre-mutation** state and unconditionally prints `Approved N operation(s)` + exit 0 — even when `approveOperations()` (`compiler/src/compile.ts:444-459`) actually leaves an op `blocked` (e.g. unresolvable idempotency carrier). Success message and exit code can't be trusted to mean "exposed". |
| 5 | med | `cli/src/commands/refine.ts:239` | `runApply` always serializes via `airToYaml` and writes it, even when the resolved AIR path is an `air.json` file — an auto-approved refinement corrupts a `.json`-named AIR with YAML syntax. (`loadAir` reads by extension; the write path ignores it.) `it.skip` + `// BUG:` (couldn't confirm an auto-approving fixture without running end-to-end). |
| 6 | med | `cli/src/tool-cli.ts:55-69,93-98` | Vestigial `BOOLEAN_FLAGS` (`auth`, `evidence`, `operations`, `quiet`, …) force a business parameter literally named e.g. `auth` to boolean `true`, silently discarding its CLI value and forwarding `auth=true` onto the wire with no error. |
| 7 | med | `cli/src/tool-cli.ts:93-98,1005-1009` | A required flag left value-less because the next token is another flag (`--payment-id --dry-run`) coerces to boolean `true`; the runtime presence-check doesn't catch a boolean, and `String(value)` yields a corrupted request (`/payments/true`) instead of a clean `validation_error`. |
| 8 | mod | `runtime/src/executor.ts:607,903,949,1059,1118,1153` | `PolicyContext.response` is declared (`policy.ts`) but **never assigned** — every `runHook` call site forwards only `request`. A `postResponse` policy hook (the one meant to inspect the upstream result for audit/redaction) can never see status/body; it silently degrades to a `postExecute` alias. |
| 9 | mod | `runtime/src/executor.ts:877-880` | Dry-run `retryPlan.maxAttempts` uses `retrySafe` alone while `enabled` factors in the `ctx.retries===false` override — so a dry-run for a safe idempotent mutation with retries forced off reports the self-contradictory `{ enabled: false, maxAttempts: 3 }` instead of `maxAttempts: 1`, misrepresenting execution. |
| 10 | mod | `compiler/src/protocols/postman.ts:389-390` (`lowerUrl`) | When a collection variable used as the whole host already includes a scheme (`https://internal.corp.com`), the separately-declared `url.port` is never appended — silently dropped from the server base, though it is applied correctly in the other two branches. |
| 11 | mod | `runtime/src/credentials.ts:379-390` | The RFC 7523 `jwt_bearer` grant computes `audience`/`resource` (from `ANVIL_<P>_AUDIENCE`/`_RESOURCE`) like the sibling grants but never puts them in the POST body — only `grant_type`/`assertion`/`scope`. Since `auth.ts` advertises `ANVIL_<P>_AUDIENCE` as an optional credential for this shape, an operator who sets it has it silently dropped. |
| 12 | med | `cli/src/commands/sources.ts:49-52` | `runSourcesInit` returns inside the `opts.json` branch before the `opts.write` branch runs, so `anvil sources init <dir> --write <file> --json` **never writes the file**, despite the command documenting `--write` and `--json` as independent flags. |

**Fixes for #4–#12** (analogous to #1–#3, each with its pinned test flipped to a
passing assertion): #4 `approve` now re-checks post-mutation state and refuses
(throws before writing) if a requested op ended up `blocked`; #5 `refine apply`
writes JSON via `airToJson` when the AIR path is `.json`; #6 removed the
vestigial `BOOLEAN_FLAGS` entries so business params keep their values; #7 a
value-less flag on a non-boolean param now yields a structured `validation_error`;
#8 `PolicyContext.response` is threaded into the post-response hooks; #9 dry-run
`maxAttempts` now uses the combined `retrySafe && ctx.retries !== false`
condition; #10 `postman lowerUrl` appends the port in the schemed-host branch
(guarded against double-append); #11 `jwt_bearer` now includes `audience`/
`resource` in the token request; #12 `sources init` writes the file and emits
JSON when both flags are given.

</details>

## Lower-severity observations (noted in tests, still OPEN — not fixed)

| Location | Note |
|----------|------|
| `cli/src/commands/approve.ts:277-335` | `markGatewayLineageStale` / `gatewayStaleReason` appear to be **dead code** — `assertImmutableGatewayLineage` unconditionally throws first, so the "mark stale" branch is unreachable. |
| `cli/src/commands/case.ts:418-422` | A malformed `--lines` value (`--lines abc`) isn't rejected — `Number(...)`→`NaN`→falls back to "no line range", recording evidence against the whole file instead of erroring. |
| `cli/src/commands/idempotency-store.ts:228-266` | For `backend === "none"`, `runDeployLedger` returns via `renderNoStore` before validating `--ttl-seconds`/`--database-mode`, so those flags are silently accepted-and-ignored where a firestore bundle would reject them. |
| `cli/src/commands/conformance.ts:69` | Forwards `dir` to harness `runConformance`, which does a bare `readFileSync(join(dir,"air.json"))` — a bundle lacking `air.json` gets a raw `ENOENT` instead of the friendly "Run `anvil compile` first" message its sibling commands give. |

## Next steps

The 12 confirmed defects are fixed and their tests now assert the corrected
behavior. Remaining open items are the four low-severity observations above —
each is a validation/UX tightening rather than a correctness or safety defect;
they're left as documented notes (no failing test) for the maintainers to
decide on.
