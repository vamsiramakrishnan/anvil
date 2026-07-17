# Mechanisms — turning recurring compiler bugs into automatic checks

**What this page is.** A technical account of how a batch of bugs found by
backtesting got fixed not one at a time, but at the level of the *whole class* —
plus the machinery that now catches the class automatically. It's aimed at
engineers working on the compiler. If you just want to know what Anvil does,
start with the [architecture overview](/anvil/concepts/architecture/); this is
the deep dive under it.

**The short version.** Running Anvil against real vendor specs and comparing the
output to mature reference MCP servers surfaced 22 systemic compiler bugs
(`backtesting/deficiencies.md`; the count is 27 now — #23–#24 were found by the
harness below on its first run, #25–#27 by external review). The bugs clustered
into two families: 9 were schema-graph explosions, 9 were naming-heuristic
mistakes. Rather than keep fixing instances, this work converted each family into
a mechanism that makes the whole class either impossible or self-detecting. The
work was built by parallel implementation agents, with a shared corpus harness as
the gate that every change had to pass.

The pieces:

| # | Mechanism | Where |
| --- | --- | --- |
| 1 | Corpus-differential CI harness | `tools/corpus/` |
| 2 | Structural schema identity | `packages/compiler/src/decycle.ts` |
| 3 | Whole-spec naming dialect + collision repair | `packages/compiler/src/dialect.ts`, `naming.ts` |
| 4 | Round-trip law hardening | `packages/air/src/serialize.ts` |
| 5 | Loopback self-test + model review | `anvil selftest`, `anvil review` |

## 1. Corpus-differential CI harness — `tools/corpus/`

This is the feedback loop. It replaces "an engineer hand-drives real specs and
eyeballs the output" with a nightly machine that checks the output against
*oracles* — fixed expectations that pass or fail automatically.

- **Quick mode** — the 18 known systems from `backtesting/reproduce/`
  (fetch → trim → compile), checked against `baseline.json`: compile time ≤2×,
  air.json size ≤1.5×, and any drop in operation count fails.
- **Invariant oracles** — properties that must always hold: compile completes;
  determinism (same source twice → byte-identical air.json); the round-trip law
  (`airFromYaml(airToYaml(x))` preserves the contract hash); and lint exits 0.
- **Differential naming oracles** — `expected/<system>.json` fixtures pin down
  operationId → generated tool name, plus effect kind and risk, for five systems
  whose surfaces were validated against real reference MCPs (Slack, Twilio, Jira,
  GitHub GraphQL, Temporal).
- **Sweep mode** — a seeded, deterministic sample of apis.guru (~2.5k live
  specs), invariant oracles only, sorted into an outcome taxonomy (`ok`,
  `source-invalid`, `compile-error`, `invariant-violation`, `timeout`,
  `size-blowup`, `crash`). Only `crash` is fatal — a broken vendor spec is data,
  not a harness failure.
- **Nightly** run via `.github/workflows/corpus.yml`, with the report uploaded
  as an artifact.

In its first days the harness caught three real problems: **finding #23**
(Linear's same-named Query and Mutation fields collided into one invisible tool
name and made the whole spec uncompilable), **finding #24** (YAML round-trip
corruption on whitespace-only lines, lgtm.com), and an unshipped integration
regression in the structural-identity work (mechanism #2) that 262 unit tests
missed — caught by quick mode before it was pushed.

## 2. Structural schema identity — `packages/compiler/src/decycle.ts`

This removes the root cause behind the 9-bug explosion family.

**The old fragility.** After dereferencing inlines copies of a schema, the
compiler has to re-collapse those copies back to `$ref`s. Identity used to depend
on vendor-supplied `title`s to do that. Untitled or duplicate-titled components
silently failed to collapse — GitHub's real 1,752-type GraphQL schema hung the
compile until a title-stamping band-aid was added.

**The fix: structural canonical hashing.** Identity now comes from the shape of
the schema itself, computed by bisimulation-style hash refinement — an iterative
method that gives structurally identical nodes the same hash:

1. Every distinct node gets a round-0 hash of its own local shape.
2. Each later round mixes a node's previous hash with its children's hashes.
3. Rounds continue until the partition of nodes stops splitting.

Because the refinement is strict, the distinct-hash count is a true fixpoint test;
cycles need no special casing; and the cost is O(distinct nodes × rounds), where
rounds is roughly the graph diameter. Named component bodies index by canonical
hash, and any structurally identical occurrence collapses to a deterministic
canonical name (a title-matching alias if there is one, else lexicographic).
Object identity stays as an exact fast path. Titles are now cosmetic metadata.

**Two additions the corpus harness forced.** The first integration attempt broke
adapter-lowered formats (GraphQL, Discovery). The harness caught it, probes
root-caused it, and two fixes are now part of the mechanism:

- **Annotation-agnostic match hashing.** `dereference()` merges each reference
  *site's* sibling `description` onto the resolved clone. So 2,660 of GitHub's
  3,868 inlined component copies differed from their component body by exactly one
  top-level `description` — and exact hashing refused to collapse them. Refinement
  still hashes every field, but the *match* hash forgives only the node's own
  top-level `description` (the one field dereference rewrites), keeping
  description-only-distinguished schemas distinct at any depth.
- **Bounded hoisting.** Any already-emitted expansion of ≥64 output nodes that
  would appear at a second position in the tree is hoisted into a synthesized,
  deterministically named `components.schemas` entry and `$ref`'d everywhere. So
  output tree size is O(distinct nodes), never O(tree positions). GitHub's bundled
  doc went from >10.5M tree positions (`JSON.stringify` overflow) to 17,925. This
  is the hard limit; the match-hash fix just makes hoists rare.

## 3. Whole-spec naming dialect + multi-surface collision repair — `packages/compiler/src/dialect.ts`, `naming.ts`

This generalizes the 9-bug naming family from per-operation regex heuristics to
decisions made over the whole spec at once.

- **Dialect inference.** One classification over *all* of a spec's operationIds
  and paths — `verb_first` / `namespace_method` / `path_derived` / `resource_only`
  / `mixed`, plus casing — decided by majority vote with specificity precedence,
  and emitted as a `naming_dialect` diagnostic. `path_derived` (autogenerated ids
  like Stripe's `PostChargesChargeCapture` or HubSpot's path-embedded ids) lowers
  every name-quality confidence across the spec; coherent human dialects get a
  small boost. Names are never changed by dialect — deliberately conservative,
  since the derived names are validated against 17 real reference MCP surfaces.
  Small samples (<5 ops) abstain. The verb vocabulary is the classifier's own
  exported word list (`ACTION_VERB_WORDS`) — one table, no drift.
- **Collision repair.** Now provably minimal and order-independent: shortest
  distinguishing cleaned token (ties broken lexicographically) → shortest pair →
  method → stable index, never a silent `_2`. Shuffling the input operations
  yields byte-identical assignments (property-tested). And it enforces uniqueness
  across **both generated surfaces** — `cli.command` *and* `mcp.toolName` — to a
  fixpoint. That fixes finding #23, where a toolName collision was invisible to a
  resolver keyed only on the command.

## 4. Round-trip law hardening — `packages/air/src/serialize.ts`

`airToYaml` now verifies its own output re-parses to deep equality whenever the
document contains YAML-hostile whitespace. If it doesn't, it falls back to
fully-quoted lossless emission and refuses to emit a canonical artifact that would
drift, rather than emitting a corrupt one (finding #24). Ordinary documents pay
nothing and keep their readable block scalars.

## Division of labor (who built what)

These mechanisms were built by three parallel implementation agents in isolated
worktrees (harness / algorithms / naming), integrated by a fourth acting as
reviewer-integrator, with the harness itself as the integration gate. Two process
lessons worth keeping:

- Agent worktrees must be verified against the intended base commit before
  merging. One agent built against a stale base and was re-run; another
  self-corrected.
- Unit-green is not integration-green. The only regression of the round was caught
  by the corpus harness, not the unit suite.

## 5. Loopback self-test + model review — `anvil selftest`, `anvil review`

Some sources have no reference MCP server to backtest against — Travelport, Sabre,
most enterprise SOAP. For those, the bundle proves itself.

**`anvil selftest <bundle>`** boots two things and drives one against the other:
the bundle's own generated mock (real routing from the model, input-contract
validation, auth-redacted wire capture, and scenario/fault injection under
`/__anvil/*`), and the bundle's generated MCP server pointed at that mock
(`ANVIL_BASE_URL`). It then drives every approved tool over the real MCP
transport, checking five families:

1. **Exact approved-surface exposure** — the tools exposed match the approved set.
2. **No-loss wire fidelity** — every sent argument is diffed against what
   arrived; divergences are reported as losses with JSON paths.
3. **Confirmation-before-wire** — the gate must fire with *zero* wire requests.
4. **Structured upstream-error mapping** — upstream failures map to the error
   taxonomy.
5. **Never auto-retry on non-idempotent mutations** — one injected 503 must yield
   exactly one attempt.

It runs as a corpus quick-mode oracle on every system's bundle.

**`anvil review <bundle>`** drives a Haiku-class reviewer through a generated,
versioned SOP: per-surface rubrics for MCP tool descriptions, CLI help, skill
docs, and cross-surface agreement; a severity rubric; and a hard "no evidence, no
finding" rule. Findings are strict JSON, zod-validated, and mechanically grounded
— an evidence excerpt that doesn't appear verbatim in the cited file is discarded
and counted. Findings map into the existing deficiency catalog, so the refinement
loop consumes them like any other detector. If the model driver is unavailable it
returns a structured `driver_unavailable` error — never a fake pass. The
deterministic loopback gates CI; the model review is opt-in.

In its first runs the self-test surfaced **finding #30** — every adapter-lowered
read (WSDL, GraphQL, gRPC) was un-executable on the wire (a GET with a required
body), invisible to 827 unit tests because nothing had ever executed the generated
MCP path — plus #31 (hollow example synthesis for materialized schemas) and a
five-cluster long tail across 8 REST systems: path-param drops, spec-mandated
Accept/Content-Type parameter handling, sub-segment route params, synthesis vs.
zod-shape disagreement, and non-object bodies. The mechanism turns "does the
generated toolchain actually work" from an assumption into a nightly-checked
property.
