# Anvil — agent operating guide (Codex / AGENTS.md)

Anvil is an agent toolchain compiler: it turns API specifications into aligned
CLI + MCP + skill artifacts from one model (AIR). This file is the runtime-native
entry point for coding agents operating this repository.

## Operate Anvil through its own skill
The canonical operating manual is a progressive-disclosure skill:
**`skills/anvil/SKILL.md`** (with `reference/` and `evals/`). Read it before
driving Anvil. It is generated from Anvil's own command registry, so it never
drifts from the CLI. Regenerate it with `anvil skill skills/anvil`.

## The loop (harness)
1. `pnpm build` then `node packages/cli/dist/bin-anvil.js --help`.
2. `anvil compile <spec> --manifest <manifest> --out <dir>`.
3. `anvil inspect <dir>` and `anvil lint <dir>` — read the safety posture.
4. Enrich unsafe operations via a manifest (see `skills/anvil/reference/workflow.md`).
5. `anvil approve <dir> <operation-id...>` — only after inspecting risk.
6. `anvil package skill <dir>` / `anvil deploy cloud-run <dir> --env prod`.

## Rules
- Only approved operations are ever exposed. Never approve what you have not inspected.
- Do not assert idempotency you cannot prove. Leave unproven mutations `review_required`.
- Prefer `anvil run ... --dry-run` before real invocations.

## Repo layout
- `packages/air` — AIR (the IR). `packages/compiler` — parse/normalize/classify/validate.
- `packages/runtime` — the safety runtime (errors, retry, idempotency, executor).
- `packages/mcp-runtime` — the thin MCP serving path (the deployed unit).
- `packages/generators` — CLI/MCP/skill/docs/deploy/mocks/evals/conformance.
- `packages/cli` — the `anvil` command + the shared tool-CLI engine.
- `examples/payments` — the reference spec + manifest.

Run the tests with `pnpm test`.
