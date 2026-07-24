# Simulation & backtesting

"It compiled" is not proof that a bundle is safe. Anvil has three ways to prove
it, and they build on each other:

| Mechanism | What it proves |
| --- | --- |
| **Simulator** | A fake version of your API that is provably the same shape as production. |
| **Certification** | Boots that simulator and actively tries to break the safety rules. A signed check that the bundle is safe to ship. |
| **Backtesting** | Runs the whole toolchain against real vendors' real specs and scores the output against mature reference MCP servers. |

## The simulator: a stand-in that matches production

`@anvil/simulator` (ADR-0017) builds a deterministic, in-process simulator from
the same model the MCP server is generated from. It serves exactly the approved
operations and stamps the **same surface-signature digest** as the generated MCP
server — think of the digest as a fingerprint of the tools an agent sees.
`surfaceParity(simulator, production)` compares the two fingerprints, so "the
simulator matches production" is a checked fact, not a promise.

That means you can build and test a downstream agent against the simulator, then
point it at the real API, and its contract doesn't change underneath it.

Everything about the simulator is repeatable: a seeded RNG, generated fixtures
per entity, and state machines and fault profiles you can author. The same seed
replays the same world — which is what makes a simulator run usable as evidence.

## Certification: use the simulator to attack the bundle

`anvil certify` (ADR-0018, `@anvil/certification`) grades a bundle
`failed | static_passed | certified | expired`. **Passing the static checks is
never "certified."** To certify, the executable phase boots the simulator and
exercises the tools for real:

- live tools checked against the surface signature;
- representative reads executed;
- **confirmation refusal** exercised — a gated mutation must refuse to run
  without `confirm`;
- **idempotent replay** exercised — same key, no double effect;
- faults injected, and every returned error checked against the model's
  `ErrorCode` taxonomy.

Then the part that makes it a real test rather than a smoke test: the **mutation
battery**. Each standard mutant deliberately weakens one control — removes a
confirmation, enables an unsafe retry, drops an OAuth scope, downgrades a mutation
to a read, corrupts an output schema. Certification requires every applicable
mutant to be **killed** (detected — and safety mutants detected *as*
safety-sensitive). A bundle whose controls can be silently weakened does not
certify.

The attestation binds the pack, contract, capability, and surface-signature
digests together, so a certification can't be replayed against artifacts that have
since drifted (changed underneath it).

## Backtesting against the real world

The [backtesting program](https://github.com/vamsiramakrishnan/anvil/tree/main/docs/backtesting)
runs the entire loop against **real, published vendor specs** — never
hand-written ones:

```
fetch verbatim → trim to what a reference MCP also exposes → source add
  → compile → inspect → enrich → lint → approve → package skill
  → compare against the reference server's real tools and safety behavior
```

Every deficiency is logged as a concrete failure scenario, and the ones that
affect a whole class of specs are fixed in the compiler or generators — with tests
— before moving on. Jira, Confluence, GitHub, Stripe, Slack, Workday, Twilio,
Google Workspace, and a SOAP core-banking system have all been through it;
`reproduce/reproduce.sh <system>` regenerates any bundle from scratch.

## Backtesting a gateway estate

The [gateway adapters](/anvil/concepts/gateway-estates/) emit into the same
pipeline, so a gateway estate (a gateway's catalog of APIs) inherits the whole
proof chain:

1. **Decode safely** — the vendor export goes through the hardened archive
   harness (zip-slip, symlink, and decompression-bomb defenses; every rejection
   reported).
2. **Import** — the adapter emits `GatewayApiImport { source, overlay }`, and
   `compileContract` resolves it like any spec plus extra facts. Policies the
   adapter can't prove it understands land as **opaque** findings — flagged for a
   human — that block automatic certification.
3. **Simulate** — `defineSimulator` derives the simulator from the compiled
   model; it matches the would-be production MCP surface by construction.
4. **Certify** — the executable phase exercises confirmation refusal, idempotent
   replay, and fault handling against that simulator, and the mutation battery
   proves the estate's controls can't be silently weakened.

Cross-vendor honesty is itself tested: the same logical API expressed in Kong,
WSO2, and Anvil's normalized Apigee, MuleSoft, and API Connect adapter inputs
must produce the **same effective contract** — a differential test, not a design
intention. That test does not imply native Apigee proxy XML, Mule application
JARs, or IBM assembly packages are decoded.

## What this is not (yet)

- **No recorded-traffic replay.** The simulator is faithful to the *contract*
  (fixtures, state machines, fault profiles), not a replay of your gateway's
  production traffic. Backtesting proves the contract and its controls, not the
  vendor runtime's byte-for-byte behavior.
- **No customer-derived multi-vendor export corpus yet.** The gateway suite
  exercises native WSO2 apictl project/ZIP/directory structure, isolated bad
  siblings, and a generated 1,000-per-API-ZIP collection with realistic
  multi-member project layouts, plus differential normalized fixtures for all
  five adapters. That proves parser and scaling behavior over realistic
  structure; it is not the same as replaying a sanitized production estate from
  each vendor with policy-accounting oracles.

Related ADRs: 0017 (simulator as a projection), 0018 (static vs executable
certification), 0020 (archive harness), 0021 (vendor adapters).
