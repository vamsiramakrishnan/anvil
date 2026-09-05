---
name: stop-slop-anvil
description: Edit Anvil documentation into short, direct technical prose. Remove predictable AI-writing patterns without flattening technical detail or the author's voice.
---

# Stop slop for Anvil

Write for the person using the library.

The reader should learn, in this order, what they can do, what to run, what appears, what can fail, and what remains their responsibility.

Keep the technical detail. Remove the performance around it.

## Editing contract

1. Preserve the claim. Do not invent facts, examples, benchmarks, opinions, or certainty.
2. Preserve useful voice. Keep bluntness, dry humor, domain vocabulary, and deliberate rough edges.
3. Make the minimum effective edit. Do not sand every paragraph into the same cadence.
4. Protect specific details. Never replace a command, field, limit, file, state, or failure mode with a vague benefit.
5. Lead with the reader's job when setup adds nothing.
6. Front-load conclusions only when it improves comprehension. Do not force every section into one template.
7. Use direct verbs. Prefer `reads`, `writes`, `rejects`, `returns`, `stores`, `compiles`, `calls`.
8. Name the actor. Avoid passive voice and anthropomorphic systems when a concrete actor exists.
9. Cut commentary that tells the reader what to think about the sentence they just read.
10. Stop editing when the prose is clear. A distinctive sentence does not need rewriting because another sentence uses a different rhythm.

## The portability test

A sentence is suspect if it could move unchanged into the README of another developer tool.

Bad:

`Anvil streamlines complex enterprise workflows while improving reliability.`

Useful:

`Anvil generates the CLI and MCP server from the same AIR operation record, so both expose the same approved operations.`

Generic benefit language usually hides the mechanism the reader needs.

## Patterns to remove

### 1. Binary contrast

Avoid:

- `It is not X. It is Y.`
- `The question is not X. It is Y.`
- `Not just X, but Y.`
- `It feels like X. It is actually Y.`
- `X stops being A and starts being B.`

State Y.

### 2. Negative listing

Avoid:

`Not a wrapper. Not a gateway. A compiler.`

State what the thing is.

### 3. Throat clearing

Cut:

- `Here is the thing.`
- `Here is what I mean.`
- `Let me be clear.`
- `The reality is.`
- `The truth is.`
- `It is worth noting.`
- `At its core.`
- `When it comes to...`
- `In today's...`
- `In a world where...`

Start with the claim.

### 4. Faux insight

Avoid:

- `What most people miss...`
- `The part everyone skips...`
- `Here is what nobody tells you...`
- `The uncomfortable truth is...`

Do not manufacture scarcity around an ordinary observation.

### 5. Colon reveal

Avoid dramatic `setup: reveal` constructions.

Bad:

`The important part: the runtime checks again.`

Better:

`The runtime checks again before network access.`

Use colons for lists, labels, code, and data.

### 6. Dramatic fragments

Avoid:

- `That is it.`
- `Full stop.`
- `One contract. Every surface.`
- `X. And Y. And Z.`
- `Not always. Not perfectly.`

Fragments are fine when they sound like the author. Stacked fragments used as applause are not.

### 7. Rhetorical setups

Avoid:

- `What if... ?`
- `Think about it.`
- `Why does this matter?`
- `What do you get?`
- `So what does this buy?`
- self-answered question pairs.

State the point.

### 8. Superficial analysis

Cut trailing clauses that pretend to interpret the sentence:

- `highlighting`
- `underscoring`
- `showcasing`
- `reflecting`
- `demonstrating`

Bad:

`The runtime rejects the call, underscoring the importance of policy consistency.`

Better:

`The runtime rejects the call before it reaches the upstream API.`

### 9. Interpretive metadiscourse

Cut prose that tells the reader how to read the prose:

- `This matters because...`
- `The key point is...`
- `That last part matters.`
- `As you can see...`
- `The consequence is concrete.`
- `This distinction matters.`
- `In other words...` when it repeats the prior sentence.

Replace it with the actual implication when one is needed.

### 10. Importance puffery

Avoid labels such as:

- `critical`
- `crucial`
- `significant`
- `powerful`
- `robust`
- `transformative`
- `world-class`
- `game-changing`
- `pivotal`
- `paramount`

Name the consequence instead.

### 11. Adjective-as-proof

Bad:

`Anvil has a robust safety model.`

Better:

`The CLI and MCP server read approval, confirmation, retry, and idempotency from the same AIR record.`

Adjectives do not prove architecture.

### 12. Assurance language without evidence

Treat these words as claims that need evidence:

- `real`
- `honest`
- `genuine`
- `concrete`
- `authoritative`
- `correct`
- `safe`
- `deterministic`
- `production-grade`

Bad:

`This is real compiled output.`

Better:

`The docs build compiles the payments fixture and imports the generated operation table.`

Bad:

`This is the only honest enforcement.`

Better:

`Codex has no interactive ask hook, so the shim denies the call and leaves approval to Codex's human approval flow.`

### 13. Fake-strong verbs

Do not replace simple verbs with inflated ones.

Avoid:

- `serves as`
- `acts as`
- `enables`
- `empowers`
- `facilitates`
- `drives`
- `unlocks`
- `elevates`

Prefer `is`, `has`, or the exact action.

Bad:

`AIR serves as the central source of truth for operation semantics.`

Better:

`AIR stores the operation schema, approval state, retry policy, confirmation rule, and auth contract.`

### 14. Synonym cycling

Repeat the correct noun.

Do not rotate `agent`, `assistant`, `tool`, `system`, and `runtime` to avoid repetition when they refer to the same thing.

Terminology consistency matters more than stylistic variety in technical docs.

### 15. Weasel attribution

Avoid:

- `experts agree`
- `industry reports suggest`
- `many teams find`
- `widely regarded as`
- `studies show`

Name the source or cut the claim.

### 16. Repeated conclusion

Do not explain the same invariant in the opening, after the example, and again in the closing paragraph.

One statement is enough unless a later section introduces a new consequence.

### 17. Restating the example

Do not narrate obvious code line by line after a code block.

After code, prefer only what the reader cannot infer:

- expected output;
- changed state;
- refusal;
- side effect;
- next command.

### 18. Fake contrast between layers

Avoid metaphorical architecture such as:

`The hook is the outer ring. The runtime is the inner ring.`

Name responsibility:

`The hook can reject the call before tool execution. The runtime repeats the check before network access.`

### 19. Anthropomorphic architecture

Avoid:

- `AIR knows...`
- `the bundle remembers...`
- `the compiler understands...`
- `the policy decides...`
- `the data tells us...`

Prefer:

- `AIR stores...`
- `the bundle contains...`
- `the compiler parses...`
- `the runtime evaluates...`
- `the test reports...`

### 20. Narrator from a distance

Avoid generic observations:

- `Teams often struggle with...`
- `Organizations tend to...`
- `People usually...`
- `This happens because...`

For library docs, address the user or name the actor.

### 21. Vague system virtue

Avoid:

- `keeps everything aligned`
- `provides a single source of truth`
- `improves reliability`
- `reduces complexity`
- `makes the system safer`
- `creates consistency`

Name the invariant, test, or measurable outcome.

### 22. Feature inventory before user value

Do not open with every artifact Anvil can generate.

Open with what the reader can accomplish. Then name the artifacts that make it possible.

### 23. Philosophy before operation

Task pages should usually follow this order:

1. outcome;
2. prerequisite;
3. command;
4. expected state;
5. failure or boundary;
6. detail.

Do not spend several paragraphs on philosophy before the first useful action.

### 24. Fake-profound ending

Delete the mic-drop line.

Avoid endings built from:

- aphorisms;
- metaphors;
- predictions;
- reversals;
- `The future is...`;
- `That is the whole thing.`

End with the last useful fact, next command, or next decision.

### 25. Summary-recap ending

Avoid:

- `In conclusion`
- `Overall`
- `Ultimately`
- a final paragraph that simply repeats the page.

The reader was already there.

### 26. Formatting slop

Avoid:

- decorative emoji;
- bold sprinkled through prose for emphasis;
- headings over tiny sections;
- bullets that should be two sentences;
- repeated callout boxes that restate nearby text.

Format should expose structure, not decorate it.

### 27. Em-dash rhythm

Do not use em dashes as the default sentence glue.

Use a period, comma, parenthesis, or two sentences.

### 28. Robotic symmetry

Watch for:

- three paragraphs with the same shape;
- three consecutive sentences with similar length;
- repeated `X does A. Y does B. Z does C.` structures;
- every section ending in a punchy line;
- repeated three-item lists created only for rhythm.

Variation should follow the content, not a template.

### 29. Over-editing human voice

Do not delete every fragment, hedge, aside, or first-person phrase mechanically.

Keep them when they carry real uncertainty, humor, emphasis, or voice.

The goal is not sterile prose. The goal is prose that does not sound generated.

## Words that deserve suspicion

These are not forbidden in code, quoted API terms, or product names. In prose, replace them unless they add specific meaning:

`delve`, `foster`, `leverage`, `utilize`, `facilitate`, `empower`, `streamline`, `robust`, `cutting-edge`, `paradigm`, `game-changer`, `tapestry`, `realm`, `beacon`, `multifaceted`, `meticulous`, `intricate`, `paramount`, `transformative`, `elevate`, `embark`, `supercharge`, `ever-evolving`.

Inspect these intensifiers and softeners:

`really`, `just`, `literally`, `genuinely`, `honestly`, `simply`, `actually`, `deeply`, `truly`, `fundamentally`, `inherently`, `inevitably`, `importantly`, `crucially`.

Do not ban them blindly. Keep one when it carries actual contrast, uncertainty, or voice.

## Anvil documentation checks

Before merging user-facing prose, verify:

- Can the user tell what command to run?
- Can the user tell what file or artifact appears?
- Can the user tell what state changes?
- Can the user tell what Anvil will refuse?
- Can the user tell what remains their responsibility?
- Does every architectural claim point to a command, field, test, invariant, state, or boundary?
- Did we say the same thing twice?
- Did we preserve a useful specific detail instead of replacing it with a benefit claim?
- Is terminology stable across the page?
- Could a paragraph move to another developer tool unchanged? If yes, rewrite or delete it.
- Would this sound natural if read to a sharp engineer at a desk, not presented on a conference stage?

## Sources

This skill combines the useful parts of `hardikpandya/stop-slop` and `petergyang/no-ai-slop`, then adds patterns observed directly in Anvil's documentation: assurance language without evidence, repeated invariants, philosophy before operation, vague system virtues, architectural anthropomorphism, and rhetorical utility questions.
