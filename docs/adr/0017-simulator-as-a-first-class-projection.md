# ADR-0017 — The simulator is a first-class projection

**Status:** Accepted

## Context
A downstream agent needs to be developed and certified against something before it
touches production. If the simulator is a hand-written mock, it drifts from the
real surface and the agent's guarantees are fiction. The only way a
simulator-tested agent can be trusted against production is if the simulator and
production expose the **same surface** — the same tools, schemas, effects, and
auth — so switching bindings changes nothing the agent depends on.

## Decision
Add `@anvil/simulator`: a contract-faithful, deterministic simulator that is a
*projection* of the same capability contract the MCP server is.

- **`SimulatorDefinition`** is derived from a capability's AIR
  (`simulatorDefinitionFor`) and stamps the capability's surface-signature digest.
  The simulator serves exactly the **approved** operations the generated MCP
  serves.

- **Hard invariant (test-enforced):** `simulator.signature()` equals
  `surfaceSignatureFor(air)` — the generated MCP's signature. It holds *by
  construction* because both derive from the same AIR through the same
  `surfaceSignatureFor` (ADR-0015). `surfaceParity(sim, production)` is the
  one-line check.

- **Contract-faithful runtime.** `invoke(toolName, input, ctx)` honours each
  operation's AIR contract: auth-scope gating by simulated principal, confirmation
  refusal, required-idempotency enforcement and idempotent replay (no second
  effect), stateful create/update/cancel with a domain state machine, pagination
  with a stable cursor, and seeded fault injection (rate-limit / transient /
  conflict / latency) by named scenario. Errors use the AIR `ErrorCode` taxonomy,
  so a simulated failure looks like a real normalized one.

- **Determinism.** Everything is a pure function of `(seed, call sequence)` via a
  small seeded PRNG (`Rng`, mulberry32) — no clock, no `Math.random`. `reset(seed)`
  restores the exact starting state, so a run is reproducible and a certification
  can replay it.

No heavy dependencies were added: routing is by operation (tool) name, not HTTP
path, so OpenAPI Backend is unnecessary; the state machine and seeded fixtures are
small and explicit, so XState and Faker are not pulled in for this increment. If a
future need (rich JSON Schema execution, complex flows) justifies Ajv/XState, they
are added behind this package's interfaces.

## Consequences
- A downstream agent can swap the simulator and production bindings without
  changing its business contract — the signature is identical.
- The simulator is the substrate the executable certification (Increment 8) boots
  and exercises.
- **Deferred:** richer schema-level input validation (Ajv), authored
  domain-specific state machines and fixtures per capability, and the
  `bindings: { simulator, staging, production }` wiring on the pack (the model
  exists on `AgentSystemPack`; populating it is the CLI/build step).
