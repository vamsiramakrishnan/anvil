---
name: getting-started
description: Install and set up Anvil from a fresh clone, then verify the toolchain runs. Use this when setting up Anvil for the first time, standing up a new workspace, or confirming that the `anvil` CLI builds and compiles before doing any real work. For the day-to-day compile → approve → deploy loop, use the `anvil` skill instead.
---

# Getting started with Anvil

Anvil runs **from source** — a pnpm + Turbo monorepo, no global install and no
registry. Setup is: build the workspace once, then call the CLI from its build
output. This skill gets you from a clean clone to a working `anvil` command and
proves it with a real compile. It does not teach the operating loop — hand off
to the `anvil` skill for that.

## Prerequisites
- **Node.js ≥ 22.17** (`node --version`)
- **pnpm 10.x** — `corepack enable` lets pnpm match the version this repo pins.
- **git**. Nothing else: no database, no Docker, no cloud account.

## Install
```bash
git clone https://github.com/vamsiramakrishnan/anvil.git
cd anvil
pnpm install
pnpm build
```
`pnpm build` compiles every package, including the CLI entrypoint
`packages/cli/dist/bin-anvil.js` — that file **is** the `anvil` command.

## Make `anvil` a command
Call the entrypoint directly, or alias it for the session:
```bash
alias anvil='node packages/cli/dist/bin-anvil.js'
anvil --help
```

## Prove it runs
Don't trust the build — compile the bundled example and read it back. This
exercises the whole toolchain: parse a spec, classify every operation, write an
aligned bundle, inspect its safety contract.
```bash
node packages/cli/dist/bin-anvil.js compile examples/payments/openapi.yaml \
  --manifest examples/payments/anvil.yaml --service payments --out /tmp/anvil-payments
node packages/cli/dist/bin-anvil.js inspect /tmp/anvil-payments
```
Clean output means Anvil is installed and working.

## Setup rules (do not skip)
- **Build before you invoke.** A "cannot find module under `dist/`" error means
  `pnpm build` didn't finish — re-run it and watch for the failing package.
- **Never approve or deploy from this skill.** Setup only proves the toolchain;
  exposing operations is the `anvil` skill's job, behind its safety gate.
- **The alias is per-shell.** A new terminal needs the `alias` line again, or
  call `node packages/cli/dist/bin-anvil.js` directly.

## Where to look
- `skills/anvil/SKILL.md` — the operating manual: the compile → inspect →
  enrich → approve → deploy loop and the safety rules. Read it next.
- `apps/docs/src/content/docs/cookbooks/install-anvil.md` — the same install
  path as a docs page, with a machine-tested proof snippet and troubleshooting.
- `README.md` — the full lifecycle (agentify → assess → approve → build →
  certify → publish) and package map.
- Behind a gateway, not a spec file? `anvil estate --help` imports an Apigee,
  Kong, WSO2, MuleSoft, or IBM API Connect estate; see `docs/gateways.md`.

Run `anvil --help` before guessing.
