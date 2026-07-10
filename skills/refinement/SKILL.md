---
name: refinement
description: Use this skill to run Anvil's refinement loop — detect what an AIR model is missing or weak, gather evidence, propose evidence-backed semantic patches with a narrow skill, validate and measure them, and apply only demonstrated, safe improvements. Use when improving a generated tool's documentation, agent-facing naming, safety semantics, or mock/eval coverage.
---

# Refining an Anvil model

Anvil compiles a spec into aligned CLI + MCP + skill artifacts from one model
(AIR). Refinement makes that model *better for agents* without making it worse:
every change is grounded in evidence and shown to improve a measured behaviour,
and safety can only tighten.

You (the harness — Claude Code, Codex, Antigravity) are the **executor**. You do
NOT edit AIR. You gather evidence and emit a proposal; Anvil's deterministic core
validates, measures, reconciles, and applies.

## The loop (five stages)
1. **Detect** — `anvil refine plan <dir>` lists typed deficiencies. Deterministic, no LLM.
2. **Gather** — for a deficiency, collect claim-scoped evidence from the sources its
   skill admits (source code, tests, docs, Postman, recorded traffic).
3. **Propose** — run the deficiency's skill: emit claims + a semantic patch. If you
   cannot ground it, propose **nothing**. Never invent business meaning.
4. **Validate + measure** — `anvil refine run <dir>` validates the proposal and scores
   only the eval families it affects; a safety guard must never regress.
5. **Reconcile** — grounded, improved, safe proposals are auto-approved; the rest
   wait for a human. `anvil refine apply <dir>` applies only the approved ones, and
   `anvil compile` re-projects them across CLI + MCP + skill at once.

## The one invariant
**No executor edits canonical AIR.** You produce a proposal (claims + patch); the
core decides. A proposal outside its skill's boundary, ungrounded by evidence, or
that regresses any measured family is rejected — however confident you are.

## Two ways to execute a skill
- **Inline** — gather evidence and emit a proposal directly (cheap, deterministic-friendly).
- **As a case** — for anything needing real repository investigation, open a *case*: an
  isolated directory Anvil materializes for one deficiency, with a brief, the target's
  facts, an evidence policy, an allowed-tools contract, and an `output/` to deposit
  machine-readable results into. You own investigation and synthesis; Anvil owns
  admissibility, safety, validation, and application. See `reference/investigation.md`.

## Where to look (progressive disclosure)
- **L1** `reference/loop.md` — the `anvil refine` commands, the deficiency catalog, the pack layout.
- **L1** `reference/investigation.md` — the case framework: `anvil case` helpers, the phases, honest declines.
- **L2** `reference/skills/*.md` — one contract per skill, plus its investigation method (how to actually find the truth).
- **L3** `reference/proposal-contract.md` — the exact proposal JSON you emit, with an example.
- **L4** `reference/reconciliation.md` — the validators, the eval families, and the approval policy.
- `evals/refine.yaml` — behaviour checks for operating the loop.

Run `anvil refine plan <dir>` before guessing.
