---
title: "Install Anvil"
description: "From a fresh clone to a working anvil command: three commands, a version check, and a first compile that proves the toolchain runs end to end."
sidebar:
  order: 1
---

**What you'll have at the end:** a working `anvil` command built from source, and
a real compiled bundle to prove it — no global install, no registry, no
network beyond the clone.

Anvil is a pnpm + Turbo monorepo that runs from source. There is no
`npm i -g anvil`; you build the workspace once and call the CLI from its build
output (or behind a shell alias). This page is the copy-paste path.

## Prerequisites

- **Node.js ≥ 22.17** — `node --version`
- **pnpm 10.x** — `corepack enable && corepack prepare pnpm@latest --activate`, or
  see [pnpm.io/installation](https://pnpm.io/installation)
- **git**

That's the whole list. No database, no Docker, no cloud account — the compiler
and its tests run entirely on your machine.

## 1. Clone, install, build

```bash
git clone https://github.com/vamsiramakrishnan/anvil.git
cd anvil
pnpm install
pnpm build
```

`pnpm build` compiles every workspace package, including the CLI entrypoint at
`packages/cli/dist/bin-anvil.js`. That file **is** the `anvil` command.

## 2. Make `anvil` a command

Call the built entrypoint directly, or alias it for the rest of your session:

```bash
alias anvil='node packages/cli/dist/bin-anvil.js'
anvil --help
```

Every command on this site is written as `anvil <command>`; with the alias in
place, they run verbatim.

## 3. Prove it runs

Don't take the build's word for it — compile the bundled `payments` example and
read it back. This is the whole toolchain end to end: parse a spec, classify
every operation, write an aligned bundle, and inspect it.

```bash
# [docs-tested]
WORK=$(mktemp -d)
# The built CLI answers:
node packages/cli/dist/bin-anvil.js --help >/dev/null
# Compile the bundled payments example into a full bundle:
node packages/cli/dist/bin-anvil.js compile examples/payments/openapi.yaml \
  --manifest examples/payments/anvil.yaml --service payments \
  --out "$WORK/payments" --root "$WORK"
# The bundle is real, and inspect reads every operation's effect and risk:
test -f "$WORK/payments/catalog.json"
node packages/cli/dist/bin-anvil.js inspect "$WORK/payments" >/dev/null
rm -rf "$WORK"
```

If those commands complete without error, Anvil is installed and working. You
just compiled a spec into an aligned CLI + MCP server + skill + hooks bundle and
inspected its safety contract.

## Sanity-check the whole workspace (optional)

```bash
pnpm test        # the full suite, including the tested snippets on this site
pnpm typecheck   # every package typechecks
```

## What next

- **[Quickstart](/anvil/start/quickstart/)** — the compile → inspect → approve →
  deploy loop on your own spec.
- **[Operating Anvil](/anvil/guides/operating-anvil/)** — the progressive-disclosure
  manual, and the safety rules that keep unapproved operations out of every
  tool an agent sees.
- **Behind a gateway instead of a spec file?**
  [Import the estate](/anvil/concepts/gateway-estates/) — the catalog of APIs
  behind Apigee, Kong, WSO2, MuleSoft, or IBM API Connect — with `anvil estate`.

## If something breaks

- **`anvil: command not found`** — the alias is per-shell; re-run the `alias`
  line, or call `node packages/cli/dist/bin-anvil.js` directly.
- **A command errors with "cannot find module" under `dist/`** — the build
  didn't finish. Re-run `pnpm build` and watch for the failing package.
- **pnpm version mismatch** — this repo pins pnpm via `packageManager`;
  `corepack enable` lets pnpm match it automatically.
