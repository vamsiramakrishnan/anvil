# Simulation & backtesting

"It compiled" is not evidence. Anvil has three distinct proof mechanisms, and
they compose: a **simulator** that is provably the same surface as production,
an **executable certification** that boots that simulator and tries to break
the safety contract, and a **backtesting program** that runs the whole
toolchain against real vendors' real specs and scores the output against
mature reference MCP servers.

## The simulator: parity by construction

`@anvil/simulator` (ADR-0017) derives a deterministic, in-process simulator
from the same AIR the MCP server is generated from. It serves exactly the
approved operations and stamps the **same surface-signature digest** as the
generated MCP — `surfaceParity(simulator, production)` compares the two
digests, so "the simulator matches production" is a checked equality, not a
promise. A downstream agent can be developed and exercised against the
simulator and swapped to the production binding without its business contract
changing.

Determinism is built in: a seeded RNG, generated fixtures per entity, and
authorable state machines and fault profiles — the same seed replays the same
world, which is what makes simulator runs usable as evidence.

## Executable certification: the simulator as a proving ground

`anvil certify` (ADR-0018, `@anvil/certification`) grades a bundle
`failed | static_passed | certified | expired` — and **static success is never
"certified."** The executable phase boots the simulator and exercises the
surface for real:

- live tools checked against the surface signature;
- representative reads executed;
- **confirmation refusal** exercised (the gated mutation must refuse without
  `confirm`);
- **idempotent replay** exercised (same key, no double effect);
- faults injected, and every returned error checked against the AIR
  `ErrorCode` taxonomy.

Then the part that makes it a backtest rather than a smoke test: the
**mutation battery**. Each standard mutant deliberately weakens a control —
remove a confirmation, enable unsafe retry, drop an OAuth scope, weaken a
mutation to a read, corrupt an output schema — and certification requires
every applicable mutant to be **killed** (detected, safety mutants detected
*as* safety-sensitive). A bundle whose controls can be silently weakened does
not certify. The attestation binds the pack, contract, capability, and
surface-signature digests, so a certification cannot be replayed against
drifted artifacts.

## Backtesting against the real world

The [backtesting program](https://github.com/vamsiramakrishnan/anvil/tree/main/docs/backtesting)
runs the entire loop against **real, published vendor specs** (never
hand-written): fetch verbatim → trim to the operations a mature reference MCP
server also exposes → `source add` → `compile` → `inspect` → enrich → `lint` →
approve → `package skill` → compare the generated surface against the
reference server's real tool list and safety behavior. Every deficiency is
logged as a concrete failure scenario, and systemic ones are fixed in the
compiler/generators with tests before moving on. Jira, Confluence, GitHub,
Stripe, Slack, Workday, Twilio, Google Workspace, and a SOAP core-banking
system have been through it; `reproduce/reproduce.sh <system>` regenerates any
bundle from scratch.

## Backtesting a gateway estate

The [gateway adapters](/anvil/concepts/gateway-estates/) emit into the same pipeline, so a gateway
estate inherits the whole proof chain:

1. **Decode safely** — the vendor export goes through the hardened archive
   harness (zip-slip, symlink, and bomb defenses; every rejection reported).
2. **Import** — the adapter emits `GatewayApiImport { source, overlay }`;
   `compileContract` resolves it like any spec + overlays. Policies the
   adapter can't prove it understands land as **opaque** findings that block
   automatic certification.
3. **Simulate** — `defineSimulator` derives the simulator from the compiled
   AIR; parity with the would-be production MCP surface holds by construction.
4. **Certify** — the executable phase exercises confirmation refusal,
   idempotent replay, and fault handling against that simulator, and the
   mutation battery proves the estate's controls can't be silently weakened.

Cross-vendor honesty is itself tested: the same logical API expressed in Kong,
Apigee, WSO2, MuleSoft, and API Connect formats must produce the **same
effective contract** — a differential test, not a design intention.

## What this is not (yet)

- **No recorded-traffic replay.** The simulator is contract-faithful
  (fixtures, state machines, fault profiles), not a replay of your gateway's
  production traffic. Backtesting proves the *contract and controls*, not
  vendor-runtime byte behavior.
- **No real-export corpus lane yet.** `anvil estate import` drives the
  adapters end to end, but the nightly corpus still exercises only spec-based
  systems — pointing it at a corpus of real public vendor exports (with
  policy-accounting oracles) is the next hardening step.

Related ADRs: 0017 (simulator as a projection), 0018 (static vs executable
certification), 0020 (archive harness), 0021 (vendor adapters).
