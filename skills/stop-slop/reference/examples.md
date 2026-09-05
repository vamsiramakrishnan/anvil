# Examples

Each example preserves the claim while removing generated scaffolding.

## Lead with the mechanism

Bad:

> Here's the thing: Anvil isn't just another API wrapper. It's a powerful system that gives teams a consistent way to work with tools.

Better:

> Anvil compiles a reviewed API manifest into CLI, MCP, SDK, skill, and hook surfaces.

Why: the second version names the operation and outputs. The first spends most of its words announcing importance.

## Scope the guarantee

Bad:

> Every generated surface always stays in sync because they share a single source of truth.

Better:

> CLI, MCP, and SDK generation read the same AIR operation model. CI tests compare generated artifacts against that model.

Why: shared input and tests reduce disagreement. They do not make drift impossible under every failure mode.

## Put the boundary next to the capability

Bad:

> Anvil supports proto3 and can work with gRPC services.
>
> Later: native gRPC execution requires a JSON transcoder.

Better:

> Anvil parses proto3. Runtime execution requires a declared JSON transcoder.

Why: a reader deciding whether a service is executable sees the constraint immediately.

## Remove faux insight

Bad:

> What most teams miss is that approval is the real security boundary.

Better:

> Operations remain unavailable until the reviewed manifest marks them approved.

Why: the mechanism is more useful than the claim that others overlook it.

## Remove superficial analysis

Bad:

> The runtime checks the host allowlist, underscoring Anvil's commitment to secure execution.

Better:

> The runtime rejects hosts outside the reviewed allowlist.

Why: the control is inspectable. `commitment` is not.

## Remove explanatory overhang

Bad:

```bash
anvil status generated/payments
```

> The command above runs the status command against the generated payments bundle and shows its current status.

Better:

```bash
anvil status generated/payments
```

> If a gate failed, `status` reports the first required action.

Why: explain the behavior the command name does not reveal.

## Keep precise repetition

Bad:

> The operation enters AIR. The action is projected into a tool. The capability then inherits policy from the function definition.

Better:

> The operation enters AIR. Anvil generates each surface from that operation and keeps its policy attached.

Why: noun variation created four apparent concepts where there was one.

## Replace adjective with property

Bad:

> Anvil provides robust, enterprise-grade retry safety.

Better:

> Anvil disables automatic retry for mutations until the manifest declares an idempotency strategy.

Why: the second sentence can be tested.

## Preserve voice

Original:

> If the API lies about idempotency, no amount of tasteful YAML will save the retry loop.

Do not rewrite as:

> Accurate idempotency metadata is important for ensuring reliable retry behavior.

Why: the original is specific, memorable, and technically clear. Anti-slop is not a corporate-tone normalizer.

## Keep uncertainty

Bad:

> This architecture guarantees consistent behavior across all environments.

Better:

> The same generated policy is used in local and hosted runtimes. Environment-specific auth and network controls can still change execution behavior.

Why: the second version preserves what is known and names what can differ.

## End on the result

Bad:

> The agent stops guessing. The contract starts governing. That's the power of Anvil.

Better:

> Unapproved operations remain absent from callable surfaces.

Why: the last sentence states the outcome without a slogan.
