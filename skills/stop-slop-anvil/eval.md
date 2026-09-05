# Anvil prose eval

Run this after editing user-facing prose. If a check fails, fix the draft before merging.

## Meaning

- No new claims, numbers, guarantees, examples, or opinions were added.
- Commands, flags, files, states, limits, and failure modes remain intact.
- Technical terms did not change names merely for stylistic variety.
- The edit did not make a conditional behavior sound unconditional.

## Reader value

- The first useful paragraph tells the reader what they can do or what problem the page solves.
- A task page reaches the first command or concrete decision quickly.
- The reader can identify the expected output or state change.
- The reader can identify the important refusal, failure mode, or boundary.
- The reader can identify what Anvil does not own.

## Voice

- The prose still sounds like the author.
- Bluntness, dry humor, useful fragments, and domain vocabulary were preserved when they helped.
- Strong sentences were left alone.
- The edit did not compress every paragraph to the same length or rhythm.

## Specificity

- Generic benefit claims were replaced by mechanisms or deleted.
- Specific facts were not generalized away.
- Architectural claims point to a field, command, state, test, invariant, or runtime behavior.
- Every sentence passes the portability test or contains a reason to stay.

## Slop patterns

- No binary contrasts used as rhetorical pivots.
- No negative-listing buildup.
- No throat-clearing opener.
- No faux-insight setup.
- No colon reveal.
- No superficial `highlighting` / `underscoring` clause.
- No importance puffery.
- No interpretive metadiscourse.
- No fake-strong verbs where `is`, `has`, or a precise verb is clearer.
- No synonym cycling for the same technical entity.
- No weasel attribution.
- No rhetorical utility question.
- No fake-profound kicker.
- No summary-recap ending.
- No decorative em-dash rhythm.
- No repeated punchline fragments.
- No robotic symmetry across adjacent paragraphs.

## Anvil-specific failure cases

Reject the edit if it contains language like:

- `real compiled output` without saying how it is produced;
- `single source of truth` without naming the shared record and consumers;
- `keeps surfaces aligned` without naming the invariant;
- `safe` without saying which check fails closed;
- `deterministic` without saying what input produces what stable output;
- `production-grade` without naming the operational property;
- `the policy decides`, `AIR knows`, or similar anthropomorphism;
- several paragraphs of philosophy before the first command or boundary.

## Final read

Read the page once as a user trying to complete the task.

Ask only:

1. What do I run?
2. What happens?
3. What can stop me?
4. What do I need to decide or own next?

If the page cannot answer those questions, it needs another pass.
