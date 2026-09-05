# Claude-isms in technical writing

These patterns can survive a basic slop pass because they use restrained technical language. They still read generated.

## Slogan headings

Avoid headings built for cadence rather than retrieval.

Bad:

- `One contract. Every surface.`
- `One model. Many outputs.`
- `Rules that do not change.`
- `The path forward.`

Use the actual section object or task:

- `Generated surfaces`
- `Runtime policy`
- `Retry rules`
- `Release evidence`

## Benefit-restatement loops

Generated prose often follows this sequence:

1. explain the mechanism;
2. state the consequence;
3. ask why it matters;
4. restate the consequence as a benefit; and
5. end with a slogan.

Keep the mechanism and the consequence. Delete the rest unless it changes a decision.

Bad:

> The hook checks confirmation before the tool call. So what does this buy you? Fewer wasted turns. The model gets feedback earlier. That's the real advantage.

Better:

> The hook rejects missing confirmation inside the harness, before the runtime call.

## Proof laundering

Do not use a generator, test, or shared model to claim more than it proves.

Bad:

> The error list is generated from the runtime itself, so it can't go stale.

Better:

> `docs-data.test.ts` compares the generated error list with the runtime taxonomy in CI.

Watch for:

- covered by tests, therefore guaranteed;
- generated from runtime data, therefore authoritative;
- one shared model, therefore surfaces cannot disagree;
- same source, therefore always consistent.

Name the enforcement point and the failure mode instead.

## Fake exhaustiveness

Treat these words as claims that need scope:

- every
- all
- always
- never
- single
- only
- exact
- complete
- entire
- fixed
- guaranteed

Bad:

> Every failure from every generated tool always returns the same fixed envelope.

Better:

> Generated CLI and MCP runtime failures use the Anvil error envelope.

## Adjective-as-property

Bad:

> Anvil provides robust, production-grade retry safety.

Better:

> Anvil disables automatic retry for mutations until the manifest declares an idempotency strategy.

Replace praise with behavior that can be inspected or tested.

## Explanatory overhang

Do not repeat what a reader can already see in a command, table, or diagram.

Bad:

> `anvil status generated/payments`
>
> The command above runs the status command against the generated payments bundle. It shows the current status of that bundle.

Better:

> `anvil status generated/payments`
>
> If a gate failed, `status` reports the first action still required.

Explain only the non-obvious part.

## Architecture metaphors replacing invariants

Bad:

> The hook is the outer ring. The runtime is the inner ring. Together they form a layered trust boundary.

Better:

> The hook can refuse a call early. The runtime repeats the policy checks before network access.

Metaphors are acceptable when they help orientation. They should not replace the actual component, check, or boundary.

## Boundary lag

State limitations at first mention of a capability.

Bad:

> Anvil supports proto3, WSDL, GraphQL, and OpenAPI.
>
> Native gRPC execution has some limitations described later.

Better:

> Anvil parses proto3. Native gRPC execution requires a declared JSON transcoder.

Readers make architecture decisions on first mention. Do not make them discover the boundary later.

## Safety adjective substitution

Do not use `safe`, `secure`, `trusted`, `guarded`, or `protected` as conclusions without naming the control.

Prefer:

- confirmation is required;
- the host allowlist is checked;
- mutation retry is disabled;
- human approval is required;
- credential values are not written to the bundle;
- a bundle hash mismatch fails certification.

## Narrator certification

Avoid sentences that certify their own clarity or importance.

Flag:

- `The rule is direct.`
- `The consequence is concrete.`
- `The result is simple.`
- `The important part is...`
- `The interesting case is...`
- `The key point is...`

State the rule, consequence, case, or point.

## Mechanical anti-slop is also slop

Do not enforce style rules without semantics.

Bad rules:

- ban every adverb;
- ban every passive construction;
- force two-item lists;
- ban every sentence that starts with `How` or `Why`;
- ban every em dash regardless of context.

These heuristics are useful signals, not grammar laws.

Technical writing needs phrases such as `retry automatically`, `execute concurrently`, and sometimes `the request is rejected before network access`.

The test is information density and clarity, not compliance with a surface pattern.
