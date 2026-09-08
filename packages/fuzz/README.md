# @anvil/fuzz

A stateful property-testing kernel in the Anvil workspace. It depends on
`fast-check` and Zod; it has no dependency on AIR, the Anvil compiler, or an
agent provider. Node.js 22 or later is required.

The caller supplies three things:

- A `fast-check` arbitrary of `Scenario` values, including its shrinking strategy.
- `Driver` adapters that open fresh equivalent fixtures, invoke operations,
  observe results, and close their resources.
- `Property` functions that judge those observations against explicit laws.

```ts
import { fc, runCampaign, Step } from "@anvil/fuzz";
import { paymentDriver, refundAtMostOnce } from "./your-fixture.js";

const arbitrary = fc.integer({ min: 1, max: 1000 }).map((amount) => ({
  id: "repeat-refund",
  steps: [
    Step.parse({ id: "first", operation: "refund", input: { amount, key: "k1" } }),
    Step.parse({ id: "repeat", operation: "refund", input: { amount, key: "k1" }, requires: ["first"] }),
  ],
}));
const report = await runCampaign({
  arbitrary, drivers: [paymentDriver], properties: [refundAtMostOnce],
  seed: 39, runs: 100, budgetMs: 30000,
  identity: { fixture: "payments/v1", oracle: "refund-at-most-once/v1" },
});
```

`Step.bindings` can resolve an input field from a previous successful result
using a JSON pointer. `retainDependencies` removes orphaned steps from custom
sequence shrinkers. Every generated case and every shrink opens new fixtures.
The kernel preserves the first failing check's identity while shrinking, so an
unrelated timeout cannot become its minimized counterexample.

`replayCampaign` executes the exact recorded calls and checks source identities.
Explicitly allowed identity changes are recorded alongside the original replay.
Unsupported drivers, infrastructure failures, missing assertions, and exhausted
budgets cannot produce a passing campaign.

`runSkillTask` accepts an agent adapter, the skill and task, a tool catalog, one
driver, and explicit properties. `processAgent` implements a bounded NDJSON
bridge for an external harness. The host records actual invocations and effects;
the agent's completion message does not assert success. Captured failures can be
replayed without invoking a model. Agent trajectories are not automatically
shrunk; seeded campaign shrinking is a separate mode.

Adapters must honor `AbortSignal`, terminate subprocesses, bound captured output,
and sanitize their structured observations. A JavaScript timeout cannot preempt
arbitrary synchronous code; this library is not an operating-system sandbox.
The supplied `runProcess` helper uses argv arrays, kills process groups on POSIX,
limits combined output, and inherits only basic process environment variables.

The Anvil-specific MCP, CLI, CLI→MCP, and TypeScript/Python/Go/Java SDK drivers live in
`packages/harness/src/fuzz`. See the [workflow and protocol reference](../../docs/fuzzing.md).
