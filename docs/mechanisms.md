# Mechanisms — how 22 hand-found bugs became standing machinery

Backtesting real vendor specs against mature reference MCP servers found 22
systemic compiler bugs (`backtesting/deficiencies.md`; the count is 27 now —
#23–#24 were found by the harness below on its first run, #25–#27 by external
review). Their distribution was
the design signal: 9 were schema-graph explosions, 9 were naming heuristics —
two families, each fixed one instance at a time. This round converted the
families into mechanisms that make the *class* impossible (or self-detecting),
built by a team of parallel implementation agents and integrated with the
corpus harness as the gate.

## 1. Corpus-differential CI harness — `tools/corpus/`

The feedback loop. Converts "an agent hand-drives real specs and eyeballs the
output" into a nightly machine with oracles:

- **Quick mode** — the 18 known systems from `backtesting/reproduce/`
  (fetch → trim → compile), gated against `baseline.json` (compile time ≤2×,
  air.json size ≤1.5×, op-count decreases fail).
- **Invariant oracles** — compile completes; determinism (same source twice →
  byte-identical air.json); round-trip law (`airFromYaml(airToYaml(x))`
  preserves the contract hash); lint exits 0.
- **Differential naming oracles** — `expected/<system>.json` fixtures assert
  operationId → generated tool name and effect kind/risk for five systems
  whose surfaces were validated against real reference MCPs (Slack, Twilio,
  Jira, GitHub GraphQL, Temporal).
- **Sweep mode** — a seeded, deterministic sample of apis.guru (~2.5k live
  specs), invariant oracles only, with an outcome taxonomy (`ok`,
  `source-invalid`, `compile-error`, `invariant-violation`, `timeout`,
  `size-blowup`, `crash`). Only `crash` is fatal — a broken vendor spec is
  data, not a harness failure.
- **Nightly** via `.github/workflows/corpus.yml`, report artifact uploaded.

Scoreboard from its first hours: **finding #23** (Linear's same-named
Query+Mutation fields → invisible tool-name collision → whole spec
uncompilable), **finding #24** (YAML round-trip corruption on whitespace-only
lines, lgtm.com), and one **unshipped integration regression** in the
structural-identity work that 262 unit tests missed — caught by quick mode
before push. The harness paid for itself before its first nightly.

## 2. Structural schema identity — `packages/compiler/src/decycle.ts`

Deletes the root fragility behind the 9-bug explosion family: schema identity
used to depend on vendor-supplied `title`s to re-collapse dereference-inlined
copies back to `$ref`s. Untitled or duplicate-titled components silently
failed to collapse — GitHub's real 1,752-type GraphQL schema hung the compile
until a title-stamping band-aid was added.

Identity is now **structural canonical hashing** by bisimulation-style hash
refinement: every distinct node gets a round-0 hash of its local shape, then
rounds mix each node's own previous hash with its children's until the
partition stops splitting (strict refinement ⇒ the distinct-hash count is a
true fixpoint test; cycles need no special casing; cost is O(distinct nodes ×
rounds), rounds ≈ graph diameter). Named component bodies index by canonical
hash; any structurally identical occurrence collapses to a deterministic
canonical name (title-matching alias preferred, else lexicographic). Object
identity remains as an exact fast path. Titles are now cosmetic metadata.

The first integration attempt regressed adapter-lowered formats (GraphQL,
Discovery) — caught by the corpus harness, root-caused with probes, and fixed
with two additions that are now part of the mechanism:

- **Annotation-agnostic match hashing.** `dereference()` merges each reference
  *site's* sibling `description` onto the resolved clone, so 2,660 of GitHub's
  3,868 inlined component copies differed from their component body by exactly
  one top-level `description` — and exact hashing refused to collapse them.
  Refinement still hashes every field; the *match* hash forgives only the
  node's own top-level `description` (the one field dereference rewrites),
  keeping description-only-distinguished schemas distinct at any depth.
- **Bounded hoisting.** Any already-emitted expansion of ≥64 output nodes that
  would be emitted at a second tree position is hoisted into a synthesized,
  deterministically named `components.schemas` entry and `$ref`'d everywhere —
  so output tree size is O(distinct nodes), never O(tree positions). GitHub's
  bundled doc went from >10.5M tree positions (`JSON.stringify` overflow) to
  17,925. This is the hard law; the match-hash fix just makes hoists rare.

## 3. Whole-spec naming dialect + multi-surface collision repair —
`packages/compiler/src/dialect.ts`, `naming.ts`

Generalizes the 9-bug naming family from per-operation regex heuristics to
corpus-level decisions:

- **Dialect inference** — one classification over ALL of a spec's
  operationIds/paths (`verb_first` / `namespace_method` / `path_derived` /
  `resource_only` / `mixed`, plus casing), majority vote with specificity
  precedence, emitted as a `naming_dialect` diagnostic. `path_derived`
  (autogenerated ids — Stripe's `PostChargesChargeCapture`, HubSpot's
  path-embedded ids) lowers every name-quality confidence corpus-wide;
  coherent human dialects get a small boost. Names are never changed by
  dialect — deliberately conservative, since the derived names are validated
  against 17 real reference MCP surfaces. Small samples (<5 ops) abstain.
  The verb vocabulary is the classifier's own exported word lists
  (`ACTION_VERB_WORDS`) — one table, no drift.
- **Collision repair** — now provably minimal and order-independent: shortest
  distinguishing cleaned token (ties lexicographic) → shortest pair → method →
  stable index, never a silent `_2`; shuffling input operations yields
  byte-identical assignments (property-tested). And it enforces uniqueness
  across **both projected surfaces** (`cli.command` AND `mcp.toolName`) to a
  fixpoint — fixing finding #23, where a toolName collision was invisible to
  a command-keyed resolver.

## 4. Round-trip law hardening — `packages/air/src/serialize.ts`

`airToYaml` now verifies its own output re-parses to deep equality whenever
the document contains YAML-hostile whitespace, falling back to fully-quoted
lossless emission, and refusing loudly rather than emit a canonical artifact
that drifts (finding #24). Ordinary documents pay nothing and keep readable
block scalars.

## Division of labor (who builds what)

These were built by three parallel implementation agents in isolated
worktrees (harness / algorithms / naming), integrated by a fourth acting as
reviewer-integrator, with the harness itself as the integration gate. Two
process lessons worth keeping: agent worktrees must be verified against the
intended base commit before merging (one agent built against a stale base and
was re-run; another self-corrected), and unit-green ≠ integration-green — the
only regression of the round was caught by the corpus harness, not the test
suite.
