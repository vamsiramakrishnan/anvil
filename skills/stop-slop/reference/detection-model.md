# Detection model

The scanner separates deterministic findings from editorial heuristics.

## Rule classes

### High

High-confidence patterns are suitable for CI failure when they match literally or through narrow regexes.

Examples:

- throat-clearing phrases;
- faux-insight setups;
- narrator certification;
- fake-profound stock endings;
- explicit marketing filler such as `paradigm shift`;
- unqualified `cannot drift`, `always agrees`, or `single source of truth` claims.

### Medium

Medium-confidence patterns need review.

Examples:

- importance adjectives;
- fake-strong verbs;
- superficial `-ing` analysis;
- excessive absolutes;
- portability filler.

### Advisory

Advisory rules describe rhythm and structure. They should not fail CI on their own.

Examples:

- repeated em dashes;
- stacked fragments;
- repeated sentence shapes;
- passive voice;
- adverbs;
- rhetorical questions.

## Scoring

The SDK uses weighted findings rather than a claim that prose can be objectively scored.

Default weights:

- high: 5
- medium: 2
- advisory: 1

`score = sum(weights)`

The score is useful for ordering work and comparing the same document over time. It is not an AI detector and should not be presented as one.

## Why not use an AI detector?

The skill checks named, explainable patterns. It does not infer authorship.

A human can write slop. A model can write clean prose. The useful question is whether the sentence wastes attention, hides a boundary, launders proof, or substitutes rhetoric for evidence.

## Line-level findings

Each finding should include:

- rule id;
- severity;
- line number;
- matched text;
- short explanation;
- suggested action.

This makes CI output actionable and lets reviewers suppress a rule for a legitimate case.

## Safe autofix boundary

Autofix only transformations that are close to semantics-preserving:

- delete stock throat-clearing prefixes;
- collapse `in order to` to `to`;
- collapse `due to the fact that` to `because`;
- collapse `has the ability to` to `can`.

Do not automatically:

- remove every adverb;
- convert every passive sentence;
- replace every flagged adjective;
- rewrite technical claims;
- split long sentences;
- change absolutes without knowing the correct scope.

Those require judgment.

## Suppression

When integrating the SDK into a repository, allow explicit suppression by rule id rather than disabling an entire class.

Example policy:

```text
stop-slop: ignore=absolute-claim reason="protocol guarantee quoted from RFC"
```

A suppression should carry a reason so the exception is reviewable.

## CI policy

Recommended default:

- fail on new high-severity findings;
- report medium findings without failing;
- keep advisory findings local or opt-in;
- compare changed lines where possible;
- never reject content based on a single aggregate score.
