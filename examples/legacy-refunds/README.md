# Legacy refunds inventory fixture

This synthetic WebLogic export demonstrates the legacy inventory boundary. The
standard descriptor declares one remote EJB. Two vendor binding files disagree
about its JNDI target, so Anvil retains an explicit `binding_target` conflict.

Build the repository, then run:

```bash
node packages/cli/dist/bin-anvil.js legacy inventory \
  examples/legacy-refunds/export \
  --estate payments-example \
  --environment prod \
  --application refund-service \
  --source-kind deployed_configuration \
  --source-id weblogic-example \
  --revision fixture-v1 \
  --out generated/legacy-refunds.inventory.json
```

Inspect the candidate and its retained assertions:

```bash
jq '.candidates[] | {
  candidateId,
  invocation,
  claims,
  conflicts
}' generated/legacy-refunds.inventory.json
```

Create a task for the exact candidate:

```bash
ANVIL_LEGACY_CANDIDATE_ID=$(
  jq -r '.candidates[0].candidateId' generated/legacy-refunds.inventory.json
)

node packages/cli/dist/bin-anvil.js legacy refine task \
  generated/legacy-refunds.inventory.json \
  "$ANVIL_LEGACY_CANDIDATE_ID" \
  --out generated/legacy-refunds.task.json
```

The example intentionally stops at the harness boundary. A proposal must cite
evidence for choosing `ejb/refunds-v1` or `ejb/refunds-v2` and define the
business operation, schemas, errors, completion, authorization, idempotency,
and retry semantics. Inventory alone cannot make that choice.

Even after a valid proposal receives human approval, the resulting binding has
`runtime.status = not_implemented`. This fixture does not include or simulate a
WebLogic client.
