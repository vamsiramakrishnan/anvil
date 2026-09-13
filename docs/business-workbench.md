# Business capability workbench

Anvil business projects keep a definition, reviewed source AIR snapshots, and held-out evaluation tasks in one versioned document. The console and CLI call the same project, build, and evaluation services. Source endpoints, credentials, and choreography remain private; public artifacts expose business actions.

## Start a project

`examples/business/project.json` contains three owned calibration journeys: complete a return, amend a pending order, and provision account access. It also contains cross-tenant and lost-response tasks. These sources are synthetic fixtures, not authority for a production integration.

```sh
anvil capability project save . examples/business/project.json
anvil capability project list .
anvil console .
```

Open **Business capabilities** in the console. Select an action, edit its public outcome, input and result schemas, and intent guidance. Review the private source authority, explicit bindings, guards, effects, and failure instructions. The complete-project editor also supports adding actions and changing source snapshots.

Imported actions are proposals. The review checkbox approves exposure of the selected action; changing an action clears that checkbox. Approval does not establish facts about a backend. The reviewer must establish source authority and inspect the actual effects. The compiler refuses unresolved bindings, unapproved source operations, and incompatible schemas.

Choose **Validate & preview**, then **Save revision**. A stale browser cannot overwrite a newer CLI or browser revision. Previous revisions remain available by their SHA-256 digest. **Build bundle** writes a new generated directory and emits the same MCP, CLI, skill, TypeScript, Python, Go, and Java artifacts as `capability compile`.

```sh
anvil capability project show . business-calibration --against PRIOR_DIGEST
anvil capability project build . business-calibration --expected CURRENT_DIGEST
```

Change impact follows source operations into dependent business actions. It identifies input, output, guidance, effects, authority, policy, and execution changes, plus affected task ids. Schema changes require review; Anvil does not claim to prove arbitrary JSON Schema compatibility or infer that similarly named identifiers refer to the same business entity.

## Comparative agent evaluations

A trusted operator module supplies a `BusinessEvaluator`: one agent adapter with versioned model configuration, a fresh isolated fixture for each trial, and independent backend properties. The runner compares:

| Lane | Agent context |
| --- | --- |
| `raw` | Approved source operations and their input schemas |
| `business` | Approved business actions and their input schemas |
| `business-skill` | The same business actions plus the generated skill and references |

All lanes receive the same held-out prompt, fixture seed, model configuration, call budget, and timeout. Lane order rotates between repeats. Private fixture setup and expected outcomes are given to the evaluator, never inserted into the agent prompt. The evaluator must preserve equivalent backend state and authorization policy across lanes.

`ownedBusinessEvaluator(agent)` supplies the repository's owned backend and drives generated MCP servers in all three lanes. Its oracles inspect actual backend effect counters, including forbidden effects. Connect a real provider through `processAgent` using the `anvil-fuzz-agent/v1` bridge described in [Fuzzing](fuzzing.md). `examples/business/evaluator.mjs` shows the operator configuration.

```sh
anvil capability project evaluate . business-calibration \
  --expected CURRENT_DIGEST --adapter ./examples/business/evaluator.mjs --repeats 3
anvil console . --business-evaluator ./examples/business/evaluator.mjs
anvil capability project jobs . business-calibration
```

Console jobs persist beneath the project and support cancellation. Each completed trial is saved before the next starts, so an interrupted run retains its traces. A restarted console labels unfinished jobs as interrupted; it never silently reruns them. A completed job means the runner finished, not that the agent succeeded. Reports retain failed, unsupported, and inconclusive trials, observed calls, latency, and Wilson 95% success intervals. The interval describes these trials, not general capability reliability; small calibration suites cannot establish generalization. Token usage is unmetered (`null`). Scripted adapters test mechanics and must be labeled as scripted; they are not live-model evidence. Failure records retain invocation traces and replay scenarios, not a claim to reproduce model reasoning.

An operator adapter executes with the operator's local authority. Select it when launching the CLI or console. Browser requests cannot choose module paths, commands, environment variables, or backend targets.

## Execution journals and reconciliation

Set `ANVIL_BUSINESS_JOURNAL_DIR` on a business runtime to record execution events. For console inspection, use the workspace's `.anvil/executions` directory. The runtime records the plan and request digests, attempted steps before dispatch, response digests, and final business status. Journal failures stop further dispatch. Credentials, raw inputs, and vendor response bodies are not written into journal events.

`FileBusinessJournal` writes private files, flushes records and directory entries, and verifies an integrity chain when reading. It supports a single host on a persistent volume. Ephemeral container disk does not provide durable retention; distributed hosts should supply a shared `BusinessJournal` implementation. The durable intent ledger remains the authority for duplicate-request exclusion. A journal is not a distributed transaction or an exactly-once guarantee.

```sh
anvil capability execution inspect .anvil/executions TRACE_ID
anvil capability execution reconcile .anvil/executions TRACE_ID \
  --expected LATEST_RECORD_DIGEST --reviewer operator --note 'Verified billing receipts' \
  --verifier ./operator/verify-receipts.mjs
```

The verifier default-exports an async function receiving the journal records. It must query authoritative backend evidence and return one observation per attempted mutation: `step`, `authority`, `observation` (`committed`, `not_committed`, or `unknown`), `receiptDigest`, and ISO `observedAt`. The library refuses stale journal revisions, missing or unrelated evidence, and executions without a recorded terminal outcome. A crashed worker must be fenced and investigated before recovery.

Reconciliation appends the reviewed findings. It does **not** clear ledger reservations, replay writes, rotate intent keys, or mark a business outcome completed merely because a reviewer recorded a note. Automatic continuation and compensation need backend-specific proofs and are intentionally not implemented by this journal API.
