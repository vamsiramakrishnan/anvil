---
name: stop-slop
description: Detect and remove predictable AI writing patterns without flattening the writer's voice. Use for technical docs, READMEs, design docs, release notes, comments, prompts, product copy, code review prose, or any draft that feels generic, over-explained, self-important, or "Claude-ish".
version: 2.1.0
license: Apache-2.0
metadata:
  intent: writing-quality
  default_mode: review
  languages:
    - en
  sources:
    - hardikpandya/stop-slop
    - petergyang/no-ai-slop
    - rand/cc-polymath/skills/anti-slop
    - Wikipedia:Signs_of_AI_writing
  progressive_disclosure:
    level_0:
      read: SKILL.md
      purpose: fast review and rewrite
    level_1:
      read:
        - reference/pattern-catalog.md
        - reference/examples.md
      purpose: pattern-level diagnosis and examples
    level_2:
      read:
        - reference/anti-examples.md
        - reference/detection-model.md
        - reference/claude-isms.md
        - reference/wikipedia-signals.md
      purpose: edge cases, false positives, source-derived signals, and technical-writing rules
    level_3:
      read:
        - cli.md
        - sdk.md
      purpose: automation and CI integration
    level_4:
      run:
        - python skills/stop-slop/scripts/slop.py check <path>
        - python skills/stop-slop/scripts/slop.py explain <path>
      purpose: deterministic scanning
---

# Stop Slop

Remove generated writing patterns while preserving the writer's point, facts, tone, and useful weirdness.

Do not use this skill to guess authorship. A pattern is evidence about the prose, not proof about who or what wrote it.

## Fast path

1. Find the sentence that contains the actual point.
2. Move it to the front when that helps comprehension.
3. Delete setup that adds no context.
4. Restore specific facts when prose has smoothed them into generic praise or significance.
5. Replace praise with behavior, evidence, numbers, constraints, or failure modes.
6. Remove repeated conclusions and self-certifying commentary.
7. Put capability limits beside the capability claim.
8. Keep one technical term for one concept. Do not rotate synonyms for style.
9. Remove chatbot residue, placeholders, and leaked internal citation markup.
10. End on the last useful fact or next action.

## What to inspect first

High-confidence defects:

- chatbot residue such as `I hope this helps` or `Would you like me to...`;
- faux insight such as `What most people miss`;
- narrator certification such as `The rule is simple`;
- vague attribution such as `industry reports suggest`;
- proof laundering such as `cannot drift` when the implementation proves less;
- knowledge-cutoff or source-search disclaimers pasted into final prose;
- placeholder citation text;
- internal model markup such as `oai_citation`, `turn0search0`, or `:::writing`;
- fake-profound endings.

Medium-confidence review signals:

- significance and legacy inflation;
- promotional language;
- `not just X, but Y`;
- `serves as`, `stands as`, `features`, or `offers` where `is` or `has` is clearer;
- superficial `-ing` analysis;
- stock `challenges -> future prospects` arcs;
- marketing adjectives and fake-strong verbs;
- colon reveals and empty transitions.

Advisory signals:

- absolutes that may need scope;
- repeated triads;
- suspicious `from X to Y` ranges;
- em-dash density;
- template-like formatting.

Advisory means inspect, not rewrite automatically.

## Core editing rules

1. Preserve the claim. Do not invent facts, examples, benchmarks, opinions, or certainty.
2. Preserve useful voice. Keep bluntness, humor, uncertainty, and unusual phrasing when they do real work.
3. Protect specifics. Names, numbers, protocols, timings, commands, states, and failure modes outrank generic benefit language.
4. Use the portability test. If a sentence could move unchanged to another product or company, replace it with a fact, mechanism, constraint, consequence, or judgment specific to this subject.
5. Remove fake contrast. State the positive claim directly unless the rejected alternative matters to the reader.
6. Prefer plain verbs. `is`, `has`, `stores`, `checks`, `rejects`, and `returns` often beat decorative verbs.
7. Do not confuse tests with guarantees. Name the enforcement point, scope, timing, and failure mode.
8. Keep boundaries next to capabilities. Do not force the reader to discover limitations later.
9. Explain only the non-obvious part of code, tables, commands, or diagrams.
10. Do not replace architecture with metaphor. Name the component, actor, check, and state transition.
11. Repeat the correct technical noun. Synonym cycling can invent distinctions that do not exist.
12. Cut superficial analysis. `highlighting`, `underscoring`, `reflecting`, and similar clauses need a real consequence to survive.
13. Name sources. Do not replace evidence with `experts agree`, `studies show`, or coverage labels.
14. Avoid summary-recap endings and mic-drop closers.
15. Formatting should expose structure, not manufacture importance.
16. Treat punctuation and rhythm rules as heuristics. Do not ban every dash, adverb, fragment, passive sentence, or list of three.
17. Stop editing when the prose is clear. Anti-slop should not create another synthetic house style.

## Wikipedia-derived principle

The most useful lesson from Wikipedia's field guide is not a phrase blacklist. It is regression toward the generic: specific facts get smoothed into broader, more positive, more important-sounding prose.

Repair that at the information level. Restore the fact, source, mechanism, limitation, or consequence that the generic sentence displaced.

Read `reference/wikipedia-signals.md` when reviewing encyclopedia-style prose, source-heavy writing, formatting residue, citation artifacts, or broader AI-writing signals.

## Automation

Use the CLI for deterministic candidates:

```bash
python skills/stop-slop/scripts/slop.py check README.md --profile technical
python skills/stop-slop/scripts/slop.py explain docs --profile strict --include-advisory
python skills/stop-slop/scripts/slop.py rules --profile technical
```

Use `--format json` for programmatic consumers and `--format sarif` for code-scanning integration.

The scanner supports local suppression with `<!-- slop: ignore-line -->` and project-level rule suppression with repeated `--disable-rule` flags.

Autofix is intentionally narrow. It may simplify wording such as `in order to` -> `to`. It must not automatically rewrite claims, evidence, technical guarantees, punctuation, or author voice.

## Final check

Before returning or merging prose, ask:

- What should the reader know, decide, run, expect, or avoid after this paragraph?
- Did a specific fact become a generic importance claim?
- Does an adjective stand in for an observable property?
- Does a test or generator justify less than the prose claims?
- Is an absolute scoped to the component and code path that enforce it?
- Does the limitation appear at the first capability claim?
- Did the prose rename the same technical concept for variety?
- Does a trailing analysis clause add evidence or only commentary?
- Did assistant-facing text, placeholders, or internal citation artifacts leak into the result?
- Would this sound natural if read to the intended reader rather than performed at them?

Clear is the goal. Short sentences often expose unclear thinking, but sentence length is not a quality metric by itself.
