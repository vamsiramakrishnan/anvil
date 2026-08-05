---
title: Install Anvil
description: Build Anvil from source, verify the CLI, and compile a disposable example before using your own API contract.
sidebar:
  order: 1
---

Anvil currently runs from source; there is no published global package. This
page gets you to a verified local CLI without changing your global npm setup.

## Prerequisites

You need:

- Node.js 22.17 or later;
- Corepack, which is included with supported Node.js releases;
- Git; and
- a shell that can run the commands below.

Check the versions first:

```bash
node --version
corepack --version
git --version
```

You do not need Docker, a database, or cloud credentials to compile and test a
bundle locally.

## Clone and build

```bash
git clone https://github.com/vamsiramakrishnan/anvil.git
cd anvil
corepack enable
pnpm install
pnpm build
```

The repository pins pnpm in `package.json`. Let Corepack select that version;
do not substitute the latest pnpm release when reproducing a build failure.

Verify the CLI:

```bash
pnpm anvil --version
pnpm anvil --help
```

`pnpm anvil` runs the built entrypoint at
`packages/cli/dist/bin-anvil.js`. The documentation uses `anvil` for installed
or aliased environments and `pnpm anvil` when commands are intended to run from
this checkout.

## Verify the complete path

Compile the repository's payments fixture into a temporary directory, inspect
it, and remove it when finished:

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

If that block exits successfully, the compiler, generators, and CLI can work
together on your machine.

## Optional shell shortcut

If you prefer the shorter commands used in the reference docs, create an alias
for the current shell:

```bash
alias anvil='node packages/cli/dist/bin-anvil.js'
anvil --help
```

The alias is not persistent. Add it to your shell profile only if this checkout
has a stable location.

## Common installation failures

| Symptom | What to do |
| --- | --- |
| `pnpm: command not found` | Run `corepack enable`, then reopen the shell if necessary. |
| pnpm reports a version mismatch | Run `corepack pnpm --version`; the result should match `packageManager` in `package.json`. |
| A module under `dist/` is missing | Run `pnpm build` again and fix the first package that fails. |
| Native `sharp` or `esbuild` install fails | Confirm you are using a supported Node.js version and the repository's pinned pnpm version. Remove only `node_modules`, then rerun `pnpm install`. |
| The docs site fails while the CLI packages build | Run the docs build separately with `pnpm --filter @anvil/docs build` so the Astro error is isolated. |

For command and bundle problems after installation, use the
[troubleshooting guide](/anvil/guides/troubleshooting/).

## Next step

Continue to the [quickstart](/anvil/start/quickstart/) to compile, inspect, and
exercise a bundle without contacting a real API.
