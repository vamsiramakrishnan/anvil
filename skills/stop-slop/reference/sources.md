# Source synthesis

This skill combines three anti-slop approaches and adds technical-documentation rules observed in Anvil.

## hardikpandya/stop-slop

Useful ideas carried forward:

- explicit phrase and structure catalogs;
- binary contrast detection;
- throat-clearing removal;
- faux-insight and rhetorical-setup detection;
- attention to robotic rhythm;
- examples that show before and after.

Rules not carried forward as hard bans:

- ban all adverbs;
- ban all passive voice;
- ban all em dashes;
- force list lengths;
- ban entire classes of sentence starters.

Those are useful signals. They are too coarse for technical prose.

## petergyang/no-ai-slop

Useful ideas carried forward:

- preserve the writer's voice;
- make the minimum effective edit;
- use the portability test;
- protect specific facts;
- detect colon reveals;
- detect superficial analysis and importance puffery;
- reject synonym cycling in technical prose;
- remove fake-profound and summary-recap endings;
- treat AI detectors as guesses rather than evidence.

This source is the strongest basis for the skill's editorial philosophy: named patterns are inspectable; authorship inference is not.

## rand/cc-polymath anti-slop

Useful ideas carried forward:

- separate text, code, and design slop conceptually;
- pair detection with cleanup guidance;
- expose CLI automation;
- expose scoring only as an operational heuristic;
- keep scripts subordinate to human judgment;
- document acceptable contexts and false positives;
- use iterative detect -> analyze -> clean -> review loops.

Changes made here:

- scoring is weighted findings, not a 0-100 quality claim;
- high, medium, and advisory severities are separated;
- the fixer only performs narrow, semantics-preserving rewrites;
- line-level findings retain rule ids and source locations;
- CI guidance defaults to high-confidence findings only.

## Anvil additions

The following patterns came from reviewing Anvil's own docs rather than the source repositories:

- proof laundering from generated artifacts or CI tests;
- capability boundaries stated too late;
- assurance adjectives replacing controls;
- architecture metaphors replacing invariants;
- narrator certification such as `The rule is direct`;
- repeated invariant explanations;
- explanatory overhang after commands and tables;
- philosophy before operation on task pages;
- technical noun synonym cycling;
- fake certainty such as `cannot drift`, `always agrees`, and `the only honest enforcement`.

These are especially common in polished AI-generated technical writing because the prose sounds restrained while still overclaiming or wasting attention.
