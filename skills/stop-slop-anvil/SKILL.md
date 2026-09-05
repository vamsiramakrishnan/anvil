---
name: stop-slop-anvil
description: Edit Anvil documentation into short, direct technical prose. Remove predictable AI-writing patterns without flattening technical detail.
---

# Stop slop for Anvil

Write for the person using the library.

Lead with the task, output, constraint, or failure mode. Explain the mechanism after the reader knows why it matters.

Keep technical detail. Remove performance.

## Editing order

1. Find the reader's job.
2. Put the useful fact first.
3. Cut setup that only announces the fact.
4. Replace abstractions with commands, files, states, limits, or consequences.
5. Remove repeated conclusions.
6. Check the draft against the patterns below.

## Patterns to remove

### Binary contrast

Avoid:

- `It is not X. It is Y.`
- `The question is not X. It is Y.`
- `Not just X, but Y.`

State Y.

### Throat clearing

Avoid:

- `Here is the thing.`
- `Let me be clear.`
- `The reality is.`
- `It is worth noting.`
- `At its core.`

Start with the claim.

### Faux insight

Avoid:

- `What most people miss...`
- `The part everyone skips...`
- `Here is what nobody tells you...`

Do not manufacture scarcity around an ordinary observation.

### Colon reveal

Avoid dramatic `label: reveal` constructions.

Bad:

`The important part: the runtime checks again.`

Better:

`The runtime checks again before network access.`

Use colons for lists, labels, data, and code.

### Dramatic fragments

Avoid:

- `That is it.`
- `Full stop.`
- `One contract. Every surface.`
- `X. And Y. And Z.`

Short sentences are useful. Stacked fragments used as applause are not.

### Superficial analysis

Cut trailing clauses built from words such as:

- `highlighting`
- `underscoring`
- `showcasing`
- `reflecting`
- `demonstrating`

Replace them with the actual consequence.

Bad:

`The runtime rejects the call, underscoring the importance of policy consistency.`

Better:

`The runtime rejects the call before it reaches the upstream API.`

### Fake-profound ending

Do not end with an aphorism, metaphor, prediction, or mic-drop sentence.

End with the last useful fact, next action, command, or boundary.

### Interpretive metadiscourse

Avoid telling the reader how to interpret the sentence they just read.

Cut:

- `This matters because...`
- `The key point is...`
- `The consequence is concrete.`
- `That last part matters.`
- `As you can see...`
- `In other words...` when it only repeats the prior sentence.

If the implication is not obvious, state the implication directly.

### Importance puffery

Avoid:

- `critical`
- `crucial`
- `significant`
- `powerful`
- `robust`
- `transformative`
- `world-class`
- `game-changing`
- `pivotal`

A technical fact should carry its own weight.

### Adjective-as-proof

Do not use adjectives to certify a claim.

Bad:

`This gives Anvil a robust safety model.`

Better:

`The CLI and MCP server read the same approval, confirmation, retry, and idempotency fields from AIR.`

### Assurance language without evidence

Avoid self-certifying words such as:

- `real`
- `honest`
- `genuine`
- `concrete`
- `authoritative`
- `correct`
- `safe`

Use them only when the sentence names the evidence or invariant that makes the claim true.

Bad:

`This is real compiled output.`

Better:

`The docs build runs the payments fixture and imports the generated operation table.`

Bad:

`This is the only honest enforcement.`

Better:

`Codex has no interactive ask hook, so the shim denies the call and leaves approval to Codex's human approval flow.`

### Rhetorical utility question

Avoid:

- `So what does this buy?`
- `Why does this matter?`
- `What do you get?`

State the benefit.

Bad:

`So what does the hook buy? Fewer wasted turns.`

Better:

`The hook rejects missing confirmation before the runtime round trip.`

### Repeated conclusion

Do not explain the same invariant in the introduction, after the example, and again in the closing paragraph.

One strong statement is enough. Refer back to it only when the reader needs a new consequence.

### Restating the example

Do not narrate code immediately after the code line by line unless the reader needs help interpreting a non-obvious result.

Prefer:

- expected output;
- failure state;
- next command;
- boundary or side effect.

### Fake contrast between layers

Avoid prose such as:

`The hook is the outer ring. The runtime is the inner ring.`

Name the actual responsibility:

`The hook can reject a call before tool execution. The runtime repeats the policy check before network access.`

### Anthropomorphic architecture

Avoid making artifacts sound like people.

Bad:

- `AIR knows...`
- `the bundle remembers...`
- `the compiler understands...`
- `the policy decides...`

Prefer the concrete operation:

- `AIR stores...`
- `the bundle contains...`
- `the compiler parses...`
- `the runtime evaluates...`

### Narrator from a distance

Avoid generic observations such as:

- `Teams often struggle with...`
- `Organizations tend to...`
- `This happens because...`

For library documentation, address the user or name the actor.

### Vague system virtue

Avoid claims such as:

- `keeps everything aligned`
- `provides a single source of truth`
- `improves reliability`
- `reduces complexity`
- `makes the system safer`

Name the invariant or measurable effect.

### Feature inventory before user value

Do not open a page with a list of generated artifacts.

Start with what the reader can accomplish, then show the artifacts that make it possible.

### Philosophy before operation

Do not spend several paragraphs explaining a design philosophy before the first command, file, or decision boundary.

For task pages, preferred order is:

1. outcome;
2. prerequisites;
3. command;
4. expected state;
5. failure or boundary;
6. detail.

### Summary-recap ending

Avoid `In conclusion`, `Overall`, `Ultimately`, or a final paragraph that repeats the page.

End with the next command or the next document the reader needs.

### Formatting slop

Avoid:

- decorative emoji;
- bold mid-sentence emphasis;
- headings for two-sentence sections;
- bullet lists that would read better as two sentences;
- repeated callout boxes that say the same thing as the surrounding prose.

### Em dashes

Do not use em dashes as a rhythm crutch. Prefer a period, comma, parenthesis, or two sentences.

## Words that deserve suspicion

These are not forbidden in code, quoted API terms, or factual names. In prose, replace them unless they add specific meaning:

`delve`, `foster`, `leverage`, `utilize`, `facilitate`, `empower`, `streamline`, `robust`, `cutting-edge`, `paradigm`, `game-changer`, `tapestry`, `realm`, `beacon`, `multifaceted`, `meticulous`, `intricate`, `paramount`, `transformative`, `elevate`, `embark`, `supercharge`, `harness`, `ever-evolving`.

Also inspect empty intensifiers:

`really`, `just`, `literally`, `genuinely`, `honestly`, `simply`, `actually`, `deeply`, `truly`, `fundamentally`, `inherently`, `inevitably`, `importantly`, `crucially`.

## Anvil-specific test

Before merging user-facing prose, ask:

- Can a user tell what command to run?
- Can a user tell what file or artifact appears?
- Can a user tell what Anvil will refuse?
- Can a user tell what remains their responsibility?
- Is a claim backed by a command, field, test, state, or boundary?
- Did we say the same thing twice?
- Could a paragraph be moved to another developer tool without changing a noun? If yes, it is probably filler.

## Sources

This skill extends ideas from `hardikpandya/stop-slop` and `petergyang/no-ai-slop`, then adds patterns observed in Anvil's own documentation. The repository rules above are written for Anvil's technical documentation rather than as a generic prose guide.
