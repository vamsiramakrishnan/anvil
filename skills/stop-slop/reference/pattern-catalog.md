# Pattern catalog

This catalog separates high-confidence generated-writing patterns from softer style heuristics.

## High confidence

### Throat clearing

Signals:

- `Here's the thing`
- `Let me be clear`
- `It's important to note`
- `Before we dive in`
- `In today's world`

Problem: delays the point without adding context.

Fix: delete the setup and start with the claim.

### Faux insight

Signals:

- `What most people miss`
- `Here's what nobody tells you`
- `The subtle point is`
- `The uncomfortable truth is`

Problem: frames ordinary information as privileged insight.

Fix: state the insight and let its specificity earn attention.

### Binary reveal

Signals:

- `It's not X. It's Y.`
- `The question isn't X. It's Y.`
- `This isn't about X. It's about Y.`

Problem: manufactures contrast when Y can usually stand alone.

Fix: state Y directly unless the rejected X is a real misconception the reader must correct.

### Colon reveal

Signals:

- `The best part: ...`
- `The reason: ...`
- `The secret: ...`

Problem: stages a reveal instead of making a sentence.

Fix: use a normal declarative sentence. Keep colons for lists, labels, definitions, and quotations.

### Narrator certification

Signals:

- `The rule is simple`
- `The result is clear`
- `The key point is`
- `This distinction matters`
- `As you can see`

Problem: the narrator certifies the sentence instead of improving it.

Fix: remove the certification and state the rule, result, or distinction.

### Importance puffery

Signals:

- `critical`
- `vital`
- `pivotal`
- `paramount`
- `transformative`
- `significant`

Problem: labels importance without evidence.

Fix: name the consequence, number, dependency, or failure mode that makes it important.

### Fake-strong verbs

Signals:

- `empower`
- `unlock`
- `leverage`
- `harness`
- `elevate`
- `showcase`
- `streamline`

Problem: replaces an exact verb with promotional motion.

Fix: use `read`, `write`, `compile`, `reject`, `record`, `generate`, `route`, `retry`, `store`, or another concrete verb.

### Superficial analysis

Signals:

- `highlighting ... commitment`
- `underscoring ... importance`
- `demonstrating ... dedication`
- `reflecting ... focus`

Problem: trailing commentary adds a virtue claim rather than information.

Fix: keep the event or behavior. Delete the commentary unless it changes interpretation.

### Proof laundering

Signals:

- `generated from source, so it cannot drift`
- `typed, so misuse is impossible`
- `covered by tests, so it is guaranteed`
- `single source of truth`

Problem: a mechanism is used to imply a stronger guarantee than it proves.

Fix: state the enforcement point, execution time, scope, and residual failure mode.

### Unscoped absolutes

Signals:

- `always`
- `never`
- `every`
- `all`
- `only`
- `complete`
- `exact`
- `guaranteed`

Problem: absolute language often outruns the code path or dataset being described.

Fix: define the boundary. Example: `Generated CLI runtime failures use the Anvil error envelope.`

### Summary recap

Signals:

- `In conclusion`
- `Ultimately`
- `To summarize`
- a final paragraph that repeats the previous section

Problem: consumes attention without changing the reader's state.

Fix: end on the last useful fact, unresolved question, or next action.

### Fake-profound ending

Signals:

- paired fragments with rhetorical symmetry;
- a slogan after a technical explanation;
- `The future isn't coming. It's already here.`-style closers.

Problem: optimizes for quotability rather than information.

Fix: end with the concrete result.

## Medium confidence

### Portability filler

Test: could this sentence be moved unchanged to another product, team, or company?

Examples:

- `This helps teams move faster with confidence.`
- `The platform provides a seamless developer experience.`

A portable sentence is not automatically bad. It needs a subject-specific reason to exist.

### Benefit-restatement loop

Typical sequence:

1. mechanism;
2. consequence;
3. rhetorical question;
4. same consequence restated as a benefit;
5. slogan.

Keep steps 1 and 2 unless later steps add a new decision or constraint.

### Explanatory overhang

Problem: prose narrates a code block, table, or command.

Fix: explain only what the artifact does not show: state change, precondition, failure behavior, ownership, or boundary.

### Synonym cycling

Problem: technical nouns rotate for style and create false distinctions.

Fix: if `operation` is the correct term, keep using `operation`.

### Safety adjective substitution

Signals:

- `safe`
- `secure`
- `trusted`
- `guarded`
- `protected`

Fix: name the control: confirmation required, allowlist checked, retry disabled, approval required, credential omitted, signature verified.

### Weasel attribution

Signals:

- `experts agree`
- `industry best practices`
- `studies show`
- `widely regarded`

Fix: cite a named source or remove the appeal to authority.

## Heuristics, not bans

These can be useful signals but should not fail CI alone:

- passive voice;
- adverbs;
- sentence fragments;
- long sentences;
- em dashes;
- three-item lists;
- repeated sentence lengths;
- rhetorical questions.

Judge whether the form obscures ownership, weakens precision, or creates repetitive generated rhythm.
