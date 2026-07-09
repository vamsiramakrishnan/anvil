# Anvil — agent operating guide (Claude Code / CLAUDE.md)

Anvil is an **agent toolchain compiler**: it compiles API specifications into
aligned CLI + MCP server + skill artifacts from one canonical model (AIR), with
structured errors, retry/idempotency safety, and an approval workflow.

## Operate Anvil through its own skill
Read **`skills/anvil/SKILL.md`** first — it is the progressive-disclosure
operating manual, generated from Anvil's command registry (`anvil skill`). It
tells you the compile → inspect → enrich → approve → deploy loop and the safety
rules. Its `reference/` explains each command and the manifest shape; `evals/`
holds behavior checks.

## Build & test
- Install: `pnpm install`
- Build: `pnpm build`  ·  Test: `pnpm test`  ·  Typecheck: `pnpm typecheck`
- Run the CLI: `node packages/cli/dist/bin-anvil.js <command>`

## Safety contract (do not violate)
- Only **approved** operations are exposed by generated artifacts.
- Non-idempotent mutations are **never** auto-retried and require `--confirm`.
- Enrich unsafe operations with an Anvil manifest rather than approving blindly.
- Never log or echo secrets; the runtime redacts auth material from records.

## Packages
`@anvil/air` (IR) · `@anvil/compiler` (parse/normalize/classify/validate) ·
`@anvil/runtime` (safety hot path) · `@anvil/mcp-runtime` (thin MCP serving path,
the deployed unit) · `@anvil/generators` (build-time artifact foundry) ·
`@anvil/cli` (`anvil` command + shared tool-CLI engine).

The magic is not that Anvil generates code. It is that the CLI, MCP server, and
skill all agree on what an operation means. The highest compliment: "the agent
stopped guessing."
