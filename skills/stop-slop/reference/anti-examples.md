# Anti-examples

These examples prevent the anti-slop rules from becoming another style cult.

## Passive voice can be correct

Keep:

> The request is rejected before network access.

Why: the state transition matters more than the actor. Rewriting this as `Anvil rejects the request before network access` is also fine, but not automatically better.

Change:

> It was decided that mutation retries would be disabled.

To:

> The runtime team disabled mutation retries.

Why: ownership matters here.

## Adverbs can carry semantics

Keep:

- `retry automatically`
- `execute concurrently`
- `fail deterministically`
- `expire independently`

Remove:

- `incredibly powerful`
- `truly seamless`
- `fundamentally transformative`

Why: the first group changes behavior. The second adds impression.

## Repeated technical nouns are good

Keep:

> The operation enters AIR. The operation retains its approval state. Generated surfaces read that operation.

Do not rotate `operation` through `action`, `capability`, `tool`, and `function` merely for variety.

## Long sentences can be clearer

Keep a long sentence when it expresses one dependency or causal chain that becomes harder to follow when fragmented.

Bad mechanical rewrite:

> The runtime reads the manifest. It checks approval. It checks confirmation. It checks retry policy. It may reject the call.

Better when the checks are one gate:

> Before network access, the runtime reads the manifest and checks approval, required confirmation, and retry policy; any failed check rejects the call.

## Fragments can be useful

Keep fragments in UI labels, headings, terse notes, or deliberate dialogue.

Avoid stacked fragments used only for drama:

> No wrappers. No magic. No compromise.

## Em dashes are not forbidden

A dash is fine when it improves parsing. Repeated dash-heavy prose often signals generated rhythm.

Prefer one sentence with one clear relation over three dashes carrying parenthetical afterthoughts.

## Rhetorical questions can be legitimate

Keep a question when the reader must actually answer it.

Useful:

> Which service owns the idempotency key?

Slop:

> So what does this buy you?

The second question exists only to set up an answer the author already knows.

## `critical` can be factual

Keep:

> This is on the request's critical path.

Review:

> This is a critical capability for modern enterprises.

The first uses a technical term with a defined meaning. The second is praise unless supported by evidence.

## `leverage` can be a domain term

Keep it when the domain genuinely means financial or mechanical leverage.

Review it when it means `use`.

## Three-item lists are not suspicious by themselves

Do not force two items or four items to avoid a perceived AI rhythm. List the actual set.

## Headings can have personality

A memorable heading is fine when it still helps retrieval and matches the author's voice.

Weak:

> One contract. Every surface.

Useful:

> Retry policy for mutations

A project essay or personal post can tolerate more voice than API reference documentation.

## Reassurance can be useful in high-stakes UX

A product message may need reassurance after a destructive action fails or a user loses access. Do not copy that UX convention into ordinary technical prose.

## Repetition can be deliberate

Repeat a constraint when it appears at separate decision points and the reader may enter the document non-linearly. Avoid repetition when the second sentence merely rephrases the first.

## A sentence can be portable and still necessary

`The command exits non-zero on failure` is portable, but useful because it defines shell behavior.

The portability test is a filler detector, not a ban on common technical facts.
