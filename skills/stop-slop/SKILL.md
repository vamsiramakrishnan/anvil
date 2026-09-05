---
name: stop-slop
description: Remove predictable AI writing patterns from prose, with extra rules for technical documentation.
metadata:
  sources:
    - hardikpandya/stop-slop
    - petergyang/no-ai-slop
---

# Stop Slop

Use this skill for README files, documentation, guides, release notes, comments, design docs, and other user-facing prose.

## Editing goal

Preserve the writer's point and voice. Remove generated patterns without sanding the prose into generic corporate English.

The reader should leave with a clearer decision, command, constraint, mechanism, or result.

## Core rules

1. **Lead with the point.** Cut throat-clearing, scene-setting, and announcements when they add no context.
2. **Preserve useful voice.** Keep bluntness, humor, edge, uncertainty, and unusual phrasing when they are doing real work.
3. **Use the portability test.** If a sentence could move unchanged to another product or company, it is probably filler. Replace it with a fact, mechanism, consequence, constraint, or judgment specific to this subject.
4. **Remove binary pivots.** Avoid `not X, but Y`, `the question isn't X`, and similar reveal structures. State Y directly.
5. **Remove faux-insight setups.** Cut `what most people miss`, `here's what nobody tells you`, `the interesting part is`, and similar writer-flattering scaffolding.
6. **Remove slogan headings.** Prefer `Runtime policy` over `One contract. Every surface.` Prefer retrieval over cadence.
7. **Remove benefit-restatement loops.** Do not explain a mechanism, restate its consequence, ask why it matters, then restate the consequence again.
8. **Replace praise with properties.** Prefer `hash-bound`, `idempotent`, `local-only`, `read-only`, `blocking`, `resumable`, or `deterministic` over `robust`, `powerful`, `enterprise-grade`, or `seamless`.
9. **Protect specific facts.** Do not smooth numbers, names, protocols, timings, failure modes, or concrete behavior into generic importance claims.
10. **Do not overclaim from implementation.** A generated file, shared model, or CI test does not prove something `cannot drift`, `always agrees`, or `can never go stale`. State what the test checks and when it runs.
11. **Scope absolutes.** Treat `every`, `all`, `always`, `never`, `single`, `only`, `complete`, `exact`, and `guaranteed` as claims that need a defined boundary.
12. **Put boundaries beside capabilities.** If parsing does not imply execution, say so at first mention. If `publish` does not deploy, say so at first mention.
13. **Explain only the non-obvious part.** Do not paraphrase a code block, table, diagram, or command. Explain the state change, failure mode, or constraint the reader cannot infer.
14. **Replace architecture metaphors with invariants.** Name the component, check, owner, and enforcement point. Metaphors may orient; they must not carry the specification.
15. **Use concrete verbs.** Prefer `rejects`, `compiles`, `records`, `retries`, `omits`, or plain `is` over decorative verbs such as `serves as`, `enables`, `empowers`, `unlocks`, or `showcases`.
16. **Avoid synonym cycling.** If `operation` is the correct word, keep using `operation`. Do not rotate through `action`, `capability`, `tool`, and `function` for style.
17. **Remove superficial analysis.** Trailing clauses with `highlighting`, `underscoring`, `reflecting`, `showcasing`, or `demonstrating` often pretend to add analysis. Replace them with the concrete consequence or delete them.
18. **Remove importance puffery.** Cut `pivotal`, `critical`, `vital`, `transformative`, `significant`, and similar labels unless the sentence proves the importance with evidence.
19. **Name sources.** Replace `experts agree`, `studies show`, `industry reports suggest`, or `widely regarded` with a named source or remove the claim.
20. **Avoid colon reveals.** Use colons for lists, labels, definitions, and quotations. Do not use `The secret: ...`, `The best part: ...`, or similar staged reveals.
21. **Use active voice when ownership matters.** Do not hide the actor behind `was decided`, `was approved`, or `was generated` when responsibility matters. Keep a passive construction when the actor is irrelevant and the technical state is clearer.
22. **Remove empty adverbs.** Keep adverbs that carry semantics, such as `retry automatically`, `execute concurrently`, or `fail deterministically`.
23. **Do not manufacture reassurance or intimacy.** Cut `rest assured`, `and that's okay`, `the good news is`, `I promise`, and similar hand-holding.
24. **Do not manufacture profundity.** Cut mic-drop fragments, aphoristic kickers, and fake-deep closing lines. End on the last concrete point or next action.
25. **Avoid summary-recap endings.** If the reader just read the section, do not close with `In conclusion`, `Ultimately`, or a paragraph that repeats it.
26. **Use formatting for structure, not decoration.** Avoid emoji headings, random bold emphasis, two-line sections with headers, and bullet lists that would read better as prose.
27. **Treat rhythm rules as heuristics, not laws.** Avoid repeated em-dash chains, identical sentence shapes, and stacked punchy fragments. Do not ban every long sentence, fragment, passive, adverb, or dash when it is the clearest form.

## Phrases to flag

These are signals, not regex-level bans. Inspect the sentence before deleting.

- Here's the thing
- Here's why
- Here's what I mean
- Let me be clear
- The uncomfortable truth is
- What most people miss
- Here's what nobody tells you
- The part everyone misses
- The real X is
- The truth is
- The rule is direct
- The consequence is concrete
- The result is simple
- The key point is
- The takeaway is
- This distinction matters
- This matters because
- Here's why that matters
- So what does this buy?
- What does this buy you?
- The payoff is
- In practice, this means
- Put differently
- In other words
- As you can see
- real compiled output
- the real thing
- the only honest enforcement
- with confidence
- cannot disagree
- can't drift
- can't go stale
- always agrees
- single source of truth
- robust
- seamless
- comprehensive
- powerful
- sophisticated
- intuitive
- effortless
- enterprise-grade
- production-ready
- battle-tested
- cutting-edge
- paradigm shift
- game changer
- transformative
- elevate
- empower
- streamline
- facilitate
- utilize
- leverage
- unlock
- harness
- at its core
- it's worth noting
- it's important to note
- the reality is
- in today's world
- in the age of
- in the world of
- when it comes to
- going forward
- let me walk you through
- in this section, we'll
- by the end of this guide
- and that's okay
- rest assured
- the good news is
- that's it
- it's that simple
- stands as a testament
- marks a pivotal moment
- plays a vital role
- underscores its significance
- solidifies its position

See `reference/claude-isms.md` for technical patterns and examples.

## Technical documentation test

Before merging prose, ask:

- What should the reader do, decide, expect, or avoid after this paragraph?
- Can this sentence move unchanged to another product? If yes, why is it here?
- Does an adjective stand in for an observable property?
- Did a concrete fact become a generic benefit claim?
- Does a test or generator justify less than the prose claims?
- Is an absolute scoped to the component and code path that enforce it?
- Does the reader see the limitation at the first capability claim?
- Does a paragraph restate a table, diagram, or command?
- Does a metaphor hide the actual component or check?
- Did the prose rotate terminology without changing meaning?
- Does a trailing `-ing` clause add evidence, or just commentary?
- Does the section end by repeating itself or reaching for a quotable line?

Clear is the goal. Short sentences help expose unclear thinking, but sentence length is not a quality metric by itself.
