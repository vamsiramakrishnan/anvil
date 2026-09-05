---
name: stop-slop
description: Detect and remove predictable AI writing patterns without flattening the writer's voice. Use for technical docs, READMEs, design docs, release notes, comments, prompts, product copy, code review prose, or any draft that feels generic, over-explained, self-important, or "Claude-ish".
version: 2.0.0
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
      purpose: edge cases, false positives, and technical-writing rules
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

The goal is not to make prose sound less like AI by making it bland. The goal is to increase information density and make claims easier to inspect.

## Fast path

Use this sequence unless the task needs deeper analysis.

1. Find the sentence that contains the actual point.
2. Move it to the front.
3. Delete setup that adds no context.
4. Replace praise with behavior, evidence, numbers, constraints, or failure modes.
5. Remove repeated conclusions.
6. Put capability limits beside the capability claim.
7. Keep the writer's vocabulary when it is precise.
8. End on the last useful fact or next action.

## High-confidence patterns

These deserve immediate inspection:

- throat clearing: `Here's the thing`, `Let me be clear`, `It's worth noting`;
- faux insight: `What most people miss`, `Here's what nobody tells you`;
- binary reveal: `It's not X. It's Y.`;
- colon reveal: `The best part: ...`;
- narrator certification: `The rule is simple`, `The key point is`;
- importance puffery: `pivotal`, `transformative`, `vital`, `paramount`;
- fake-strong verbs: `empower`, `unlock`, `leverage`, `showcase`;
- superficial analysis: `highlighting`, `underscoring`, `demonstrating` followed by a generic virtue;
- proof laundering: `generated from the source, so it cannot drift`;
- unscoped absolutes: `always`, `never`, `every`, `complete`, `guaranteed`;
- summary endings that repeat the section;
- mic-drop fragments and fake-profound closing lines.

Do not treat these as grammar bans. A flagged phrase can be correct. Inspect the function it serves.

## Rewrite tests

For each paragraph, ask:

- What should the reader know, do, decide, expect, or avoid?
- Could this sentence move unchanged to another company or product?
- Does an adjective stand in for an observable property?
- Does the prose claim more than the implementation, test, or source proves?
- Is an absolute scoped to the component or code path that enforces it?
- Is the limitation stated at first mention?
- Does the paragraph narrate a command, table, or diagram the reader can already see?
- Did terminology change only for variety?
- Does the final sentence add information?

If a sentence fails all of these tests, delete it.

## Technical writing rules

Prefer:

- `rejects`, `compiles`, `records`, `retries`, `omits`, `requires`, `is`;
- exact nouns repeated consistently;
- named owners and enforcement points;
- concrete failure behavior;
- measured claims;
- scoped guarantees.

Avoid using `robust`, `secure`, `enterprise-grade`, `production-ready`, `seamless`, `intuitive`, or `powerful` as substitutes for technical properties.

A generated file does not prove it cannot go stale. A shared type does not prove two systems cannot disagree. A passing test proves the test passed under its stated conditions.

## Preserve voice

Do not normalize all prose into corporate English.

Keep:

- dry humor;
- short blunt sentences;
- unusual but precise wording;
- domain vocabulary;
- uncertainty when the facts are uncertain;
- long sentences when they carry one coherent idea better than several fragments.

Do not mechanically ban passive voice, adverbs, fragments, or em dashes. Treat repeated patterns as signals, not laws.

## Editing modes

### Review

Return findings with pattern name, severity, evidence, and a suggested change. Do not rewrite everything.

### Rewrite

Preserve facts and intent. Make the minimum set of edits needed to remove slop.

### Enforce

Use the CLI or SDK for deterministic checks in CI. Fail only on high-confidence rules. Keep heuristic rules advisory.

### Teach

Explain the pattern and show one bad example, one better example, and why the change is better.

## Progressive disclosure

For a normal edit, stop here.

Read `reference/pattern-catalog.md` when you need the full taxonomy.

Read `reference/examples.md` for paired rewrites.

Read `reference/anti-examples.md` before enforcing rules mechanically. It covers valid uses of passive voice, adverbs, repeated terminology, long sentences, and other common false positives.

Read `reference/detection-model.md` before changing scores or CI thresholds.

Read `reference/claude-isms.md` for technical-documentation patterns observed in practice.

Read `cli.md` and `sdk.md` to automate checks.

## Deterministic scan

Run:

```bash
python skills/stop-slop/scripts/slop.py check README.md
python skills/stop-slop/scripts/slop.py explain apps/docs/src/content/docs
python skills/stop-slop/scripts/slop.py check . --format json --fail-on high
```

The scanner is intentionally conservative. It finds candidates. It does not decide whether prose is good.

## Output contract

When reviewing prose, report findings in this shape:

```text
[path:line] severity / pattern
Evidence: <short excerpt>
Why: <what information problem this creates>
Change: <delete, rewrite, scope, source, or keep>
```

When rewriting, return the rewritten text first. Add notes only where a material claim, ambiguity, or trade-off needs explanation.
