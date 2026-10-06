# ADR-0031: One composite SDK and flows across connectors

**Status:** Accepted

## Context

A Branchyard harness home holds one package per granted connector
(ADR-0029): a skill, a CLI, and a Python and a TypeScript SDK, each talking to
the gateway under its own connector id. A task that spans connectors, such as
reading tickets in one system and filing comments in another, had no shared
surface. The harness glued two SDKs together by hand. Nothing stated the
dependency between the calls, nothing could check the plan before it ran,
and when a later call failed nothing said what the earlier writes had done or
how to take them back.

Two neighbours want the same thing as data:

- Worldloom grades an agent's plan as a DAG of connector calls
  (`expected_dag`, `worldloom.evalrun-plan/v1`).
- Branchyard's effect ledger already reads the undo AIR declares
  (ADR-0030).

## Decision

**1. `anvil connectors compose <bundle...> --out <dir>` writes a composite.**
The composite is one directory beside the connector packages (`_compose/` in
a harness home):

| Path | What it is |
| --- | --- |
| `compose.json` | The catalog (`anvil.compose-catalog/v1`). For each connector, every callable operation with its SDK method names, inputs (key and wire name), effect class, confirmation gate, and declared undo with its argument mapping. |
| `python/anvil_compose/` | `Composite`, `Flow`, `ref`, `item`, and `python -m anvil_compose`. Standard library only. |
| `typescript/src/` | The same API. It imports each connector's own TypeScript SDK. |
| `SKILL.md` | When to use a flow and the rules for running one. |

With `--layout harness`, the default, the connector SDKs are the packages
`anvil package harness` wrote under `--skills-root`. With `--layout bundle`
they are each bundle's own `sdk/`. Connector ids follow the fleet's rule
(`--workspace`). The id `_compose` is reserved. `anvil connectors index` adds
a "Spanning connectors" entry when it indexes more than one granted connector
and a composite sits under the skills root.

**2. The composite wraps; it never re-implements.** Every call is the
connector SDK's own method. Approval, confirmation, idempotency, retries,
dry run, gateway mode, and the branch's grant therefore apply unchanged. A
connector that two connector ids share, such as two accounts of one API, is
loaded under a module name unique to each id.

**3. A flow is a DAG of operation calls, built with meta methods.**

| Meta method | Meaning |
| --- | --- |
| `step(id, operation, args)` | One call. An input that is `ref(step, path)` depends on that step. `after=` adds an ordering-only edge. |
| `map(id, operation, over, args)` | One call per element of a list; `item(path)` reads the element. The result is the list of results. |
| `when=ref(...).equals(v)` / `.exists()` / `.truthy()` | Run the step only if the condition holds; otherwise it is `skipped`. |
| `plan()` | `anvil.compose-plan/v1`: nodes (connector, operation, effect class, undo kind), edges, topological waves, and a summary of reads, writes, and irreversible steps. |
| `validate()` | Findings: unknown or ambiguous operations, unknown inputs, missing required inputs, unknown steps, cycles, `item()` outside a map, a missing confirmation or idempotency key (errors), and irreversible writes (warning). |
| `dry_run()` | Each step through its SDK with `dry_run`. References to results that do not exist yet become placeholders. |
| `run()` | Validate, then call the steps in dependency order, stopping at the first failure. |
| `compensate(run, confirm=)` | Run the undo calls a failed run lists. |

Paths use ADR-0030's grammar: dotted names and `[n]` indices. A flow
serializes as `anvil.compose-flow/v1`, so another tool or language can
write it, and `Composite.load` reads it back. A step names an operation by
its id. When two connectors share that id, the step adds `connector` or
uses `connector:operation`.

**4. Confirmation is stated per step and checked before anything is sent.** A
step whose operation needs confirmation must say `confirm: true`. Otherwise
`validate()` reports an error and `run()` refuses the whole flow before its
first call. This is the same gate the SDK applies, moved earlier so that a
flow cannot do half its work and then stop at a missing confirmation.

**5. Undo is reported, never performed on the composite's own initiative.**
A failed run carries `compensation`: for every completed write call, newest
first, the declared inverse or compensation with its arguments resolved from
what was sent and what came back. A write with no declared undo is listed
with the reason. A mapping that names nothing in the call is listed as
unavailable, never called with a gap. ADR-0030's split holds: Anvil says what
undoes an effect, and the caller decides whether to undo it.
`compensate()` makes ordinary calls under the same grant, so an undo that
needs confirmation is refused unless the caller passes `confirm`.

## Consequences

- A harness can state a cross-connector task as data, check it, and preview
  it before sending anything. Worldloom can grade that same document as a
  plan, and it can turn a gold DAG into a flow (its `evalrun flow` command).
- Branchyard runs `anvil connectors compose` when a branch is granted two or
  more connectors. Grants still bound every call. The composite adds no
  authority.
- Execution is sequential in dependency order. `waves` names the steps that
  could run together. Running them concurrently would change failure
  semantics: several writes could be in flight at the first failure. That is
  left for later, behind an explicit option.
- `examples/github-mini/e2e.mjs` runs a flow through the gateway: comment on
  every issue, fail on a missing one, then compensate. Both suites drive that
  script. `packages/cli/src/commands/connectors-compose.test.ts` covers two
  connectors built from one service, validation, the TypeScript typecheck,
  and a run against the mock upstream.
