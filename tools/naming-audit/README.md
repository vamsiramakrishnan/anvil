# Naming audit

Read-only measurement harness for `effect.resource` derivation and MCP tool-name
quality. It compiles a spec through `@anvil/compiler`'s own `compile()` — the
same pipeline `anvil compile` runs — and reports what came back. It changes
nothing and writes nothing.

It exists so the numbers in
[`docs/design/resource-derivation-and-tool-name-stutter.md`](../../docs/design/resource-derivation-and-tool-name-stutter.md)
and in the principal-architect findings log can be **re-run**, not just cited.
This repo's naming claims have gone stale before; a claim that ships with its
own command does not.

```bash
pnpm install && pnpm build

# audit an untrimmed vendor spec named in docs/backtesting/reproduce/systems.tsv
node tools/naming-audit/run.mjs --fetch zendesk --service zendeskfull
node tools/naming-audit/run.mjs --fetch plaid   --service plaid

# audit a local spec, with per-defect examples
node tools/naming-audit/run.mjs path/to/spec.yaml --service acme --detail

# price only the recommended rule pair (A+C) instead of all three
NAMING_AUDIT_RULES=AC node tools/naming-audit/run.mjs --fetch github --service github
```

`--fetch` deliberately does **not** call
`docs/backtesting/reproduce/reproduce.sh <system>`. That script applies the
curated operation list, which is right for safety backtesting and wrong here: it
cuts Zendesk from 640 operations to 9, which cannot measure a defect *rate*.

## What it reports

- **defect1** — resources that are not resources: contradicted by the
  operation's own `canonicalName`/`displayName`, or derived from a bulk-RPC
  segment (`count_many`) or a bare CRUD-verb segment (`/transactions/get`).
- **defect2** — MCP tool names with an immediately repeated word, split by
  cause: `spec_authored` (the vendor's own operationId already repeats — not
  Anvil's to fix), `service_prefix_join` (the operator's `--service` duplicates
  the operationId's leading token), and `disambiguation_suffix` (the collision
  resolver appended a token the name already ended with).
- **defect3** — `candidateResources` for over-stripped singularization. This is
  a **candidate list, not a count**: it over-reports legitimate singulars a spec
  only ever writes in the plural. Verify by eye before quoting it.
- **rules** — a simulation of three candidate repairs, anchored to real output
  (the baseline segment index is the segment that actually produced today's
  `effect.resource`), so each is a measured delta on real behaviour rather than
  an independent re-derivation. `corroborationGained` measures agreement with
  the operation's own name text — **agreement is not truth**; the design doc's
  GitHub hand audit is the cautionary case.
- **headroom** — read-variant collapse headroom, reported naively and gated on
  same-OpenAPI-tag coherence, so a cluster keyed on a non-resource
  (Zendesk's `count`, 21 operations across 13 tags) cannot inflate the number.
