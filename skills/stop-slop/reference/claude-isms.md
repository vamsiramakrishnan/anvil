# Claude-isms in technical writing

These patterns survive basic slop filters because the prose sounds restrained. They are still generated tells.

## Portability filler

If a sentence can move unchanged to another product, company, or project, it probably says too little.

Bad:

> Anvil helps teams move faster while maintaining confidence and consistency.

Better:

> Anvil generates CLI, MCP, SDK, skill, and hook surfaces from the same AIR operation model.

Replace portable claims with a mechanism, boundary, number, failure mode, or decision.

## Slogan headings

Avoid headings built for cadence rather than retrieval.

Bad:

- `One contract. Every surface.`
- `One model. Many outputs.`
- `Rules that do not change.`
- `The path forward.`

Better:

- `Generated surfaces`
- `Runtime policy`
- `Retry rules`
- `Release evidence`

## Faux-insight setups

Cut phrases that present an ordinary claim as hidden knowledge.

Bad:

> What most teams miss is that approval is the real boundary.

Better:

> Only approved operations enter callable surfaces.

Flag:

- what most people miss;
- the part everyone skips;
- here's what nobody tells you;
- the interesting case is;
- the subtle point is.

## Colon reveals

Use colons for lists, labels, definitions, and quotations. Do not use them to stage a reveal.

Bad:

> The reason this works: every surface reads AIR.

Better:

> Every generated surface reads AIR.

## Benefit-restatement loops

Generated prose often does this:

1. explains the mechanism;
2. states the consequence;
3. asks why it matters;
4. restates the consequence as a benefit; and
5. ends with a slogan.

Keep the mechanism and the consequence. Delete the rest unless it changes a decision.

Bad:

> The hook checks confirmation before the tool call. So what does this buy you? Fewer wasted turns. The model gets feedback earlier. That's the real advantage.

Better:

> The hook rejects missing confirmation inside the harness, before the runtime call.

## Proof laundering

Do not use a generator, test, shared model, type system, or CI check to claim more than it proves.

Bad:

> The error list is generated from the runtime itself, so it can't go stale.

Better:

> `docs-data.test.ts` compares the generated error list with the runtime taxonomy in CI.

Watch for:

- covered by tests, therefore guaranteed;
- generated from runtime data, therefore authoritative;
- one shared model, therefore surfaces cannot disagree;
- typed, therefore impossible to misuse;
- same source, therefore always consistent.

Name the enforcement point, scope, and failure mode.

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

## Importance puffery

Flag language that tells the reader how important a fact is instead of proving it.

Bad:

> This is a critical distinction that plays a vital role in safe execution.

Better:

> Parser support does not imply native execution support.

Common tells:

- pivotal;
- vital;
- significant;
- transformative;
- paramount;
- stands as a testament;
- underscores its significance;
- solidifies its position.

## Superficial analysis

Trailing `-ing` clauses often add commentary without information.

Bad:

> The runtime checks the host allowlist, underscoring Anvil's commitment to secure execution.

Better:

> The runtime rejects hosts outside the reviewed allowlist.

Flag `highlighting`, `underscoring`, `reflecting`, `showcasing`, and `demonstrating` when the clause adds no mechanism or consequence.

## Fake-strong verbs

Do not replace plain verbs with promotional ones.

Bad:

> AIR serves as the centralized foundation that enables aligned surfaces.

Better:

> AIR stores the operation model used to generate each surface.

Prefer `is`, `has`, `stores`, `checks`, `rejects`, `generates`, and `records` when they are exact.

## Synonym cycling

Repeat the correct technical term.

Bad:

> The operation enters AIR. The action is then projected into a tool. The capability inherits its policy.

Better:

> The operation enters AIR. Anvil generates the tool from that operation and keeps its policy attached.

Changing nouns for variety can imply distinctions that do not exist.

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

Metaphors may orient the reader. They must not replace the component, check, owner, or enforcement point.

## Boundary lag

State limitations at first mention of a capability.

Bad:

> Anvil supports proto3, WSDL, GraphQL, and OpenAPI.
>
> Native gRPC execution has some limitations described later.

Better:

> Anvil parses proto3. Native gRPC execution requires a declared JSON transcoder.

Readers make architecture decisions on first mention. Do not hide the boundary three sections later.

## Safety adjective substitution

Do not use `safe`, `secure`, `trusted`, `guarded`, or `protected` as conclusions without naming the control.

Prefer:

- confirmation is required;
- the host allowlist is checked;
- mutation retry is disabled;
- human approval is required;
- credential values are not written to the bundle;
- a bundle hash mismatch fails certification.

## Weasel attribution

Bad:

> Industry best practices recommend explicit approval for high-risk operations.

Better:

> Anvil keeps high-risk mutations `review_required` until the manifest records approval.

If an external authority matters, name and cite it. Otherwise remove the appeal to authority.

## Narrator certification

Avoid sentences that certify their own clarity or importance.

Flag:

- `The rule is direct.`
- `The consequence is concrete.`
- `The result is simple.`
- `The important part is...`
- `The interesting case is...`
- `The key point is...`
- `This distinction matters.`
- `As you can see...`

State the rule, consequence, case, or point.

## Fake-profound endings

Do not close a technical section with a slogan, aphorism, or mic-drop line.

Bad:

> The agent stops guessing. The contract starts governing.

Better:

> Unapproved operations remain absent from callable surfaces.

End on the last concrete result or the next action.

## Formatting slop

Watch for:

- emoji headings;
- bold words sprinkled through sentences for emphasis;
- headings over two-sentence sections;
- bullet lists that would read better as two sentences;
- repeated `Note`, `Important`, and `Key takeaway` callouts that restate nearby text.

Formatting should expose structure, not manufacture importance.

## Mechanical anti-slop is also slop

Do not enforce style rules without semantics.

Bad rules:

- ban every adverb;
- ban every passive construction;
- force two-item lists;
- ban every sentence that starts with `How` or `Why`;
- ban every em dash regardless of context.

These are useful signals, not grammar laws.

Technical writing needs phrases such as `retry automatically`, `execute concurrently`, and sometimes `the request is rejected before network access`.

The test is information density and clarity, not compliance with a surface pattern.
