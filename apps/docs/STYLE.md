# Anvil documentation style

Write for the person trying to use Anvil.

The reader should learn three things quickly:

1. what to run;
2. what Anvil will do; and
3. what can stop the operation.

## Rules

### Start with the user's task

Bad:

> Anvil provides a comprehensive framework for safely transforming enterprise APIs into agent-ready capabilities.

Better:

> Give Anvil an API contract and reviewed policy. It generates a CLI, MCP server, SDKs, a skill, hooks, tests, and deployment inputs.

Name the input. Name the output. Name the boundary.

### One idea per sentence

Prefer short declarative sentences.

Split sentences that contain several claims joined by `and`, `while`, `allowing`, or `enabling`.

### Use concrete nouns and verbs

Say `Anvil rejects the call before network access`.

Do not say `Anvil provides robust safety enforcement to help ensure secure execution`.

### Put constraints near the claim

If a format parses but does not have native wire support, say so immediately.

If `publish` does not deploy, say so the first time `publish` appears.

If a legacy binding is not executable, do not make the reader discover that three sections later.

### Explain why the user should care

Do not add a generic benefits paragraph.

Tie the reason to a failure the user wants to avoid:

- surfaces disagree;
- a mutation retries twice;
- an unapproved operation becomes callable;
- assurance evidence no longer matches the bundle;
- an inventory is mistaken for execution authority.

### Delete throat-clearing

Avoid openings such as:

- `In this guide...`
- `This section will...`
- `Whether you are...`
- `It is important to note...`
- `Anvil is designed to...`
- `Anvil makes it easy to...`

Start with the task or the rule instead.

### Avoid empty adjectives

Do not use these unless the sentence proves the claim:

- powerful
- robust
- seamless
- comprehensive
- flexible
- sophisticated
- intuitive
- effortless
- enterprise-grade

Prefer the property that matters: deterministic, idempotent, hash-bound, local-only, read-only, non-executable, approved, or refused.

### Do not narrate obvious code

If the command is self-explanatory, show it.

Explain only the state change, output, failure mode, or non-obvious constraint.

### Do not repeat conclusions

A section should earn its final sentence. Do not summarize the same point again under `Conclusion`, `Key takeaway`, or `In summary`.

### Treat safety language as engineering language

Avoid vague claims such as `safe`, `secure`, or `trusted` without naming the control.

Prefer:

- `automatic retry is disabled`;
- `confirmation is required`;
- `the host is outside the allowlist`;
- `the bundle hash changed`;
- `the operation remains review_required`.

### Respect the reader

Do not use `simply`, `just`, `easily`, or `obviously`.

Do not congratulate the reader for completing a command.

Do not manufacture excitement.

Give the reader the shortest path to a correct decision.

## Page shape

Most task pages should follow this order:

1. Outcome.
2. Preconditions.
3. Command or API call.
4. Expected result.
5. Failure or refusal conditions.
6. Next task.

Concept pages should follow this order:

1. Problem.
2. Model.
3. Concrete example.
4. Invariant or boundary.
5. Where to go next.

## Review test

Before merging prose, ask:

- Can a sentence be deleted without losing information? Delete it.
- Is an adjective standing in for a measurable property? Replace it.
- Does the reader know why this matters before the implementation detail starts?
- Are commands and product boundaries stated before architecture prose?
- Did we preserve API names, behavior, and caveats while shortening the copy?

Short is not the goal. Clear is the goal. Short sentences make unclear thinking harder to hide.
