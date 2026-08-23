---
title: Install Anvil
description: Build Anvil from source, verify the CLI, and run one offline compiler smoke test.
sidebar:
  order: 1
---

Anvil currently runs from source. It is not published as a global package.

This guide leaves global npm packages unchanged. It builds the repository and
verifies the complete local compiler path.

## Requirements

- Node.js 22.17 or later
- Corepack
- Git

```bash
node --version
corepack --version
git --version
```

You do not need Docker, a database, cloud credentials, or an upstream API.

## Clone and build

```bash
git clone https://github.com/vamsiramakrishnan/anvil.git
cd anvil
corepack enable
pnpm install
pnpm build
```

The repository pins pnpm in `package.json`. Let Corepack select that version.
Use the pinned version when reproducing a failure.

Verify the CLI:

```bash
pnpm anvil --version
pnpm anvil --help
```

`pnpm anvil` runs `packages/cli/dist/bin-anvil.js` from the current checkout.
The remaining documentation uses:

- `pnpm anvil` for commands run from this repository; and
- `anvil` when the executable is installed or aliased.

## Run the compiler smoke test

The following block compiles the checked-in payments fixture in a temporary
directory. It contacts no upstream service.

```bash
# [docs-tested]
WORK=$(mktemp -d)
node packages/cli/dist/bin-anvil.js compile examples/payments/openapi.yaml \
  --manifest examples/payments/anvil.yaml \
  --service payments \
  --out "$WORK/payments" \
  --root "$WORK"
node packages/cli/dist/bin-anvil.js status "$WORK/payments" --root "$WORK"
node packages/cli/dist/bin-anvil.js inspect "$WORK/payments" >/dev/null
test -f "$WORK/payments/air.yaml"
test -f "$WORK/payments/mcp/server.js"
test -f "$WORK/payments/skill/SKILL.md"
rm -rf "$WORK"
```

Success establishes three facts:

1. the workspace built;
2. the CLI can compile and inspect a bundle; and
3. the expected AIR, MCP, and skill artifacts exist.

It does not establish cloud deployment or access to a real API.

## Optional shell alias

```bash
alias anvil='node packages/cli/dist/bin-anvil.js'
anvil --help
```

The alias applies only to the current shell unless you add it to a shell
profile. Use it only when the checkout path is stable.

## Installation failures

| Symptom | Action |
| --- | --- |
| `pnpm: command not found` | Run `corepack enable`, then reopen the shell if required |
| pnpm version mismatch | Run `corepack pnpm --version` and compare it with `packageManager` in `package.json` |
| Missing module under `dist/` | Run `pnpm build` and fix the first package failure |
| `sharp` or `esbuild` install failure | Confirm the Node version, remove `node_modules`, and reinstall with the pinned pnpm version |
| Docs fail after packages build | Run `pnpm --filter @anvil/docs build` to isolate the Astro failure |

For compiler and bundle failures, use
[troubleshooting](/anvil/guides/troubleshooting/).

## Next

[Run the quickstart](/anvil/start/quickstart/) to inspect a mutation, observe a
policy refusal, and verify the generated MCP path.
