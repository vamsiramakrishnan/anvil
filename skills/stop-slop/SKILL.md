---
name: stop-slop
description: Remove predictable AI writing patterns from prose, including technical documentation slop.
metadata:
  source: Extended from hardikpandya/stop-slop
---

# Stop Slop

Use this skill for documentation, README files, guides, release notes, comments, and other user-facing prose.

## Rules

1. Cut throat-clearing. Start with the task, claim, command, constraint, or result.
2. Remove formulaic contrasts. Prefer the positive claim over `not X, but Y`.
3. Remove slogan headings such as `One contract. Every surface.` Name the section instead.
4. Remove benefit-restatement loops. Delete `So what does this buy you?`, `Why does this matter?`, and recap paragraphs that repeat the mechanism.
5. Replace adjectives with properties. Prefer `hash-bound`, `idempotent`, `local-only`, `read-only`, `blocking`, or `resumable` over `robust`, `safe`, `enterprise-grade`, or `powerful`.
6. Do not turn implementation detail into a stronger claim than it proves. A generated file or CI test does not mean something `cannot drift` or `cannot go stale`.
7. Narrow `every`, `always`, `never`, `single`, `only`, `complete`, and `guaranteed` to the scope the code enforces.
8. Keep capability boundaries beside the capability. If parsing does not imply execution, say so at first mention. If `publish` does not deploy, say so at first mention.
9. Explain non-obvious state changes, constraints, and failure modes. Do not paraphrase a table, code block, or command the reader can already read.
10. Replace architecture metaphors with invariants. Name the component, check, owner, and enforcement point.
11. Use active voice when responsibility matters. Do not force active voice when a technical passive is clearer.
12. Remove empty adverbs. Keep adverbs that carry semantics such as `retry automatically` or `execute concurrently`.
13. Do not manufacture reassurance, excitement, intimacy, or profundity.
14. Avoid repeated em-dash clauses and metronomic short sentences.
15. Do not end sections with pull-quote lines or restated conclusions.

## Phrases to flag

- Here's the thing
- Here's why
- The real X is
- The truth is
- The rule is direct
- The consequence is concrete
- The result is simple
- The key point is
- The takeaway is
- This matters because
- Here's why that matters
- So what does this buy?
- What does this buy you?
- The payoff is
- In practice, this means
- Put differently
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
- unlock
- leverage
- at its core
- it's worth noting
- the reality is
- let me walk you through
- in this section, we'll
- by the end of this guide
- and that's okay
- rest assured
- the good news is
- that's it
- it's that simple

See `reference/claude-isms.md` for structural patterns and examples.

## Review test

Before merging prose, ask:

- Can this sentence be deleted without losing information?
- Does an adjective stand in for an observable property?
- Does a test or generator justify less than the prose claims?
- Does the reader see the boundary at the first capability claim?
- Does a paragraph merely restate a diagram, table, or command?
- Does a metaphor hide the component or enforcement point?
- Does the section end by repeating itself?
- Does the reader know what to run, expect, or avoid?

Clear is the goal. Short sentences help expose unclear thinking, but sentence length is not a metric by itself.
