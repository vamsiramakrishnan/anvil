# Deficiency log — real-API backtesting

Running log, most recent last within each product section. Each entry: what
broke, the real input that broke it, the fix (or why it was left as a
documented finding instead of a code change), and the test that pins it.

## Jira Cloud (26 curated real operations)

### 1. Compiler crash on a self-referential schema — FIXED
- **Symptom**: `anvil compile` on the real Jira spec threw
  `TypeError: Converting circular structure to JSON` from `JSON.stringify`
  inside `airToJson`, with zero bundle written.
- **Root cause**: Jira's real `LinkGroup` schema nests `groups: LinkGroup[]`.
  Full `$ref` dereferencing (`@scalar/openapi-parser`) turns that into an
  actual circular JS object graph, which the AIR serializer cannot JSON-encode.
  This is not Jira-specific — any spec with a genuinely self-referential type
  (comment threads, org charts, category trees, ADF-style recursive document
  nodes) hits the same crash.
- **Fix**: `packages/compiler/src/decycle.ts` — a general ancestor-tracking
  graph walk that truncates a true cycle (a node that is its own ancestor) into
  a shallow, JSON-safe stub, while leaving a *diamond* (the same object reached
  twice from unrelated branches — not a cycle) untouched. Wired into all three
  `parseSource` dereference paths in `parse.ts`. Every truncation raises a
  `schema_cycle_truncated` diagnostic (never silent) so a human can check
  whether the recursive shape mattered.
- **Test**: `packages/compiler/src/compiler.test.ts` → "self-referential
  schemas" → "compiles a recursive schema instead of crashing on a circular
  object graph".

### 2. `POST /search/jql` misclassified as a mutation — FIXED
- **Symptom**: Jira's `POST /search/jql` (JQL search — request body too large
  for a query string, a common REST convention: Elasticsearch `_search`,
  GitHub, this Jira endpoint) compiled as `mutation/medium`, landed in
  `review_required`, and would have demanded `--confirm` from an agent to run
  a pure read. mcp-atlassian's own `jira_search` tool treats this as
  unambiguously read-only (not gated by its `@check_write_access` decorator).
- **Root cause**: `classifyEffectKind` mapped effect kind from HTTP method
  alone — every POST was "mutation", full stop.
- **Fix**: `classify.ts` — `classifyEffectKind` now also accepts the naming
  signal and, for POST/PUT, recognizes `readIntent` verbs (search/export/poll —
  the same verbs the codebase already treated as "read family" for the
  descriptive action). This never *loosens* an actually-unsafe operation: the
  reclassification is verb-anchored on the *operationId*, not a loose
  heuristic. Idempotency for a reclassified read now reports `natural`
  (previously it would have kept `none` despite `effect.kind === "read"`, which
  is internally inconsistent since `retryBasisFor` already treats every read as
  retry-safe regardless of idempotency mode).
- **Test**: `compiler.test.ts` → "classifier" → "classifies a POST search
  endpoint as a read, not a mutation".

### 3. CLI command and MCP tool name disagreed about the same operation — FIXED
- **Symptom**: `GET /field/search` (operationId `getFieldsPaginated`) compiled
  to `cli.command: "jira search list field"` (backwards — reads as if "field"
  is a modifier of "search") while `mcp.toolName: "jira_get_fields_paginated"`.
  An agent routing on the CLI help text and one routing on the MCP tool list
  would reach different conclusions about what the operation does. This is
  precisely the gap CLAUDE.md calls out as the point of the whole project:
  *"the CLI, MCP server, and skill all agree on what an operation means."*
- **Root cause**: `deriveNames` took the *last path segment* as the resource
  unconditionally. For `/field/search`, that segment is the verb "search", not
  a resource — the real resource ("field") is one segment earlier.
- **Fix**: naming.ts recognizes a trailing path segment that matches the
  shared action-verb vocabulary (see #4) as a verb, not a resource, and falls
  back to the preceding segment. `getFieldsPaginated` now compiles to
  `jira field search` / `jira_get_fields_paginated` — same operation, same
  story, on both surfaces.
- **Test**: `compiler.test.ts` → "naming pass" → "treats a verb-shaped
  trailing path segment as an action, not the resource".

### 4. Two independent, drifting keyword lists for "what is a verb" — FIXED (mechanism, not patch)
- Fixes #2 and #3 were each first written as their own narrow regex
  (`SEARCH_VIA_WRITE_METHOD` in classify.ts, `VERB_LIKE_TRAILING_SEGMENTS` in
  naming.ts). On review this was flagged as exactly the failure mode of #3
  happening again one level up: two call sites independently deciding what
  counts as an action verb, free to drift apart the next time either one is
  edited.
- **Fix**: consolidated into one `ACTION_VERBS` table in `classify.ts`
  (`{action, pattern, readIntent}`), consumed by `classifyAction` (the
  descriptive verb), `classifyEffectKind`/`isReadIntentWriteMethod` (the
  safety-relevant write-method-is-really-a-read exception), and
  `naming.ts`'s trailing-segment detection via one exported `actionVerbFor`.
  `readIntent` is scoped to the three verbs the codebase already treated as
  read-family (export/search/poll) — `simulate`/`validate`/`approve`/etc. stay
  mutation-family exactly as before, since real implementations of those often
  do have a side effect (quota, temporary hold, audit trail) even when the
  name reads like an inspection. One table means the CLI and MCP surface for a
  given operation can never disagree about what its verb means again.
- **Regression caught by this refactor's own test**: the first version of the
  table used the *pre-existing* unanchored substring patterns (`/(search|...)/`
  with no word boundary), which was safe when only used to label an
  already-known-read operation's descriptive verb, but became a real safety
  bug once the same pattern also decided *effect kind*: `createResearchNote`
  contains the substring "search" ("re" + "search") and was reclassified from
  mutation to read. Fixed by anchoring every vocabulary pattern to snake_case
  word boundaries (`(^|_)(word)(_|$)`).
- **Tests**: `compiler.test.ts` → "classifier" → "does not reclassify a POST
  that merely mentions an unrelated verb substring" and "keeps a POST
  validate/simulate endpoint conservatively a mutation".

### 5. `doTransition` scored as a confident name despite an agent-hostile verb — FIXED
- **Symptom**: Jira's real operationId `doTransition` (for
  `POST /issue/{id}/transitions`) compiled to `jira_do_transition` /
  `jira transitions create` with naming confidence 0.7 — above the 0.5
  `weak_operation_name` review threshold, so it was never flagged for review.
  mcp-atlassian's own author independently renamed the same operation to
  `jira_transition_issue` — "do" tells an agent nothing about what happens.
- **Root cause**: `deriveNames`'s vague-verb penalty (`-0.2`) was too small to
  pull a strong operationId-derived base confidence (`0.9`) below the review
  threshold — a bad verb from a well-declared operationId was effectively
  unflaggable.
- **Fix**: raised the vague-verb penalty to `-0.45`, enough that any of
  `do/run/exec/execute/process/handle/call/post` pulls even a `0.9`-confidence
  operationId-derived name into `weak_operation_name` review territory.
- **Test**: `compiler.test.ts` → "naming pass" → "flags a vague verb even from
  a well-declared operationId".

### Findings logged, not (yet) fixed in code
- **`anvil approve` doesn't regenerate the bundle.** `anvil approve <dir>
  <op-ids...>` rewrites `air.yaml` but the CLI/MCP/skill files on disk were
  already written by the preceding `compile`. The only regenerate path,
  `anvil build <dir> <capability-id>`, is scoped to *one capability at a time*
  (Jira's 26 curated operations split into 12 capabilities) — there is no
  single command to regenerate a whole multi-capability bundle after a batch
  of approvals. `SKILL.md`'s stated loop (`approve` → done) undersells this:
  following it literally for a new service leaves a stale bundle on disk with
  no error or warning. Worked around here by declaring `state: approved`
  directly in the manifest (the same pattern `examples/payments/anvil.yaml`
  already uses) instead of the CLI `approve` step. Candidate fix: either
  `anvil approve` should also regenerate whichever capabilities it touched, or
  the CLI should offer a whole-bundle "regenerate every capability" command.
- **No per-operation OAuth scopes declared.** Jira's real OpenAPI spec has
  precise per-operation scopes (`write:issue:jira`, `delete:comment:jira`,
  etc. — captured verbatim in the real jira spec (fetched by `reproduce.sh jira`)'s trimmed security
  scheme). The manifest here only declares broad service-level scopes, so
  `anvil lint` correctly emits `no_declared_scopes` info diagnostics for every
  mutation. Left as a documented gap (not a compiler bug — the manifest simply
  wasn't authored with per-operation scopes) rather than fixed, to keep this
  pass focused; a real enrichment pass should pull these from the spec's
  `security` blocks per operation. See `packages/compiler/src/classify.ts`
  `classifyAuth` — it never reads `security` scopes today, only the top-level
  auth *type*.
- **Latent word-boundary risk in `FINANCIAL`/`DESTRUCTIVE`/`COMMS`.** The same
  substring-vs-word-boundary bug fixed in `ACTION_VERBS` (#4) still exists,
  unfixed, in `classify.ts`'s risk regexes (e.g. `DESTRUCTIVE` matches "drop"
  as a bare substring — a hypothetical operationId like `getDropdownOptions`
  would false-positive `risk: destructive`). No real Jira/Confluence operation
  in the curated set triggered this, so it's logged as a finding for the next
  product's backtest to either trip or clear, rather than spot-fixed without a
  real repro.

## GitHub REST API (25 curated real operations)

Same compiler, no crashes, no new circular-schema cases. Confirms the Jira
fixes generalize to a structurally different naming convention
(`namespace/kebab-action` operationIds like `issues/create-label`, vs Jira's
bare camelCase) without further changes.

- **Collision-disambiguation token can duplicate a word already in the base
  name — logged, not fixed.** `issues/create-comment` (on an issue) and
  `pulls/create-review-comment`'s comment-creation collided on CLI command
  "github comments create" and were disambiguated with path-derived tokens
  "issues"/"pulls" — but the *tool names* ended up
  `github_issues_create_comment_issues` and
  `github_pulls_create_review_comment_pulls`: the disambiguating token
  duplicates a word the base canonical name already contains ("issues"
  appears twice, "pulls" appears twice). Still correct and disambiguated,
  just visibly redundant. `resolveNameCollisions`'s `distinguishingToken`
  picks the first path segment that's unique to one operation in the
  collision group without checking whether that token already appears in the
  operation's own canonical name. A real fix would skip a candidate token
  already present in the base name and fall back to the next distinguishing
  segment (or the HTTP method) instead. Not fixed here — no evidence yet that
  this actually confuses an agent (the names are still unambiguous, just
  wordier), so it's logged for the next product's backtest to weigh in on
  before spending a code change on a cosmetic-only fix.
- **Real, evidence-grounded idempotency beyond Atlassian's "no key ⇒ never
  safe" pattern.** Unlike Jira/Confluence, several GitHub mutations are
  naturally idempotent *not* via a client-supplied key but via a
  server-enforced uniqueness constraint: creating a duplicate-name label
  (422, no duplicate), opening a second PR for the same head→base branch pair
  ("A pull request already exists…"), and PATCH updates that set absolute
  field values rather than deltas. `docs/backtesting/reproduce/manifests/github.anvil.yaml` declares
  these as `strategy: natural` with the concrete GitHub behavior cited as the
  evidence — a genuinely different (and more favorable) idempotency story
  than Atlassian's, decided per-operation on real API semantics rather than a
  blanket policy per vendor.

## Stripe API (22 curated real operations)

Stripe is structurally the most demanding backtest so far: ~860 component
schemas that are *extensively* mutually cross-referential (Charge↔Customer↔
Subscription↔Invoice↔PaymentMethod…), and this is where `anvil compile`
actually broke — repeatedly, six times over, each a real generalizable bug
rather than a Stripe-only workaround. The honest arc: #6–#9 is a
depth-bounded patch that worked and shipped; #10–#12 is what replaced it
after being asked *why truncate real structure at all when Stripe's own spec
has no such problem* — the correct fix (bundle named schemas once, `$ref`
everywhere else, matching how the source spec and every real SDK generator
already represent this) plus two real bugs found getting there. Both stages
are kept below because the *questions that surfaced the second one* are as
much the record as the code.

### 6. Un-memoized diamond re-walk — compiler hung indefinitely — FIXED
- **Symptom**: `anvil compile` on the real Stripe spec never returned (killed
  after 60s+, no output). No crash, no error — just gone.
- **Root cause**: `decycle.ts`'s cycle-breaking walk (fix #1) tracked
  ancestors to catch true cycles, but did not cache the *result* of walking a
  node once it was safely resolved. A "diamond" — the same shared schema
  (`Address`, `Customer`, …) reached from many unrelated branches, not a
  cycle — was re-walked and re-cloned once per path that reached it. With
  Stripe's graph, that multiplies: a shared node whose own subtree contains
  further shared nodes multiplies the re-walk count further still.
- **Fix**: memoize by node identity — `resolved.set(node, ...)` once a node
  is fully resolved (no longer anyone's open ancestor), `resolved.get(node)`
  before re-deriving. This cannot mask a real cycle (cycle detection still
  runs off the live ancestor chain, checked first); it only skips
  *re-deriving the same answer*.
- **Test**: `decycle.test.ts` → "stays fast on a heavily cross-referential
  (diamond-rich) graph — the real Stripe case" (40 mutually-referencing
  synthetic types, asserts < 2s).

### 7. Fixing the walk's speed didn't fix the *output* — it was still too big — FIXED
- **Symptom**: after #6, `parseSource`/`compileSource` became fast (~100ms),
  but `generateBundle` still hung — traced to `JSON.stringify` on a single
  Stripe `charge` schema. A hand-rolled probe (cycle detection only, no
  memoization — deliberately matching what `JSON.stringify` itself does,
  since JSON has no way to represent a shared reference) found **no cycle**
  and **over two million nodes** before an artificial budget cut it off.
- **Root cause**: full `$ref` dereferencing is *correct* but not free —
  inlining every reference means a diamond's whole subtree is duplicated in
  the *output text* at every occurrence. In a graph where core types
  extensively cross-reference each other, that duplication compounds
  multiplicatively with depth. This is not a hypothetical: it is what a
  real, current, widely-used API's real spec does.
- **Fix**: bound expansion depth the same way cycles are bounded — truncate
  to a stub past a configured depth, report a diagnostic
  (`schema_depth_truncated`, aggregated into one diagnostic with a sample of
  paths rather than one per occurrence, since a real spec can trigger this
  thousands of times). Depth is counted **from each schema's own root**, not
  the document root (see #9) — otherwise a shallow, ordinary spec's schema
  gets penalized for the OpenAPI document's own wrapper nesting
  (`paths.<p>.<method>.requestBody.content.<type>.schema...`).
- **Test**: `decycle.test.ts` → "bounds a very deep but finite, non-cyclic
  chain instead of expanding it fully".

### 8. The real root cause: Stripe's own spec already tells you the compact shape — FIXED (better than the depth bound alone)
- **Finding**: probing *why* Stripe specifically blows up found one dominant
  pattern. Every "expandable" field (`charge.customer`, `charge.invoice`, …)
  is declared as:
  ```json
  "customer": {
    "anyOf": [{"type": "string", "maxLength": 5000}, {"$ref": ".../customer"}, {"$ref": ".../deleted_customer"}],
    "x-expansionResources": {"oneOf": [{"$ref": ".../customer"}, {"$ref": ".../deleted_customer"}]}
  }
  ```
  `x-expansionResources` is Stripe's **own spec** marking: this field is a
  plain string ID by default at runtime, and only becomes the nested object
  if the caller opts in via the API's `expand[]` parameter (312 occurrences
  in the raw, pre-dereference spec). The depth bound (#7) truncates this
  correctly but for the wrong reason — it doesn't know these are optional
  expansions, it just runs out of budget.
- **Fix**: detect `x-expansionResources` and collapse the field to its
  non-expansion alternative(s) *before* recursing — conservatively: only
  when at least one `anyOf`/`oneOf` alternative is clearly not a declared
  expansion variant and at least one is, so this can never touch an ordinary
  `anyOf`/`oneOf` that isn't this exact pattern. This is not a fallback for
  #7, it's the *correct* fix for the common case: it reflects the API's real
  default response shape (more accurate, not just smaller), and the depth
  bound stays as a backstop for whatever this doesn't catch.
- **Test**: `decycle.test.ts` → "collapseExpandable" describe block (collapses
  the Stripe-shaped pattern; leaves an ordinary `anyOf` alone; leaves an
  `anyOf` alone when `x-expansionResources` doesn't match any alternative —
  never guesses).

### 9. `truncate()` turned array-typed fields into objects — FIXED (found via a real downstream Zod failure, not by inspection)
- **Symptom**: after #7/#8 landed, re-compiling **Jira** (not Stripe!) started
  failing Zod validation: `service.auth.scopes: expected array, received
  object`. Jira's own spec has no combinatorial blowup — this was a
  regression in the general-purpose `truncate()` stub, not a Stripe-specific
  issue.
- **Root cause**: `decycle.ts` walks the **whole** OpenAPI document (paths,
  security requirements, everything), not just JSON Schema — and
  `truncate()` always returned `{type, description}`, unconditionally. When
  a depth-limited or cycle-truncated node happened to be an *array* (an
  OAuth `security: [{OAuth2: [...]}]` scope list, reached deep enough via the
  document-root depth counting that #7 first used), the array silently
  became an object, and every downstream consumer that expected an array
  broke.
- **Fix**: `truncate()` is now type-preserving — an array truncates to `[]`,
  an object truncates to the `{type, description}` stub as before.
- **Compounding cause, also fixed**: this was made *worse* by depth being
  counted from the document root instead of each schema's own root (the fix
  in #7's second pass) — wrapper nesting (`paths.<p>.<method>.security[0]...`)
  was consuming real schema-content depth budget for structures that were
  never combinatorial to begin with. Depth now resets to 0 at each schema
  boundary (`schema` key, or an entry directly under a `schemas` map), so an
  ordinary spec's real content depth is what's measured, not how many
  OpenAPI wrapper layers it happens to sit under. This *also* dropped Jira's
  compiled bundle from 13MB to 2.2MB and GitHub's from 17MB to 4.2MB — the
  original (document-root-counted) depth-8 default had been silently
  over-truncating both without anyone noticing, since neither happened to
  trip a Zod type error.
- **Tests**: `decycle.test.ts` covers array truncation implicitly via the
  "deep chain" and cross-referential tests (`JSON.stringify` must not throw
  and produces valid structures); re-verified by recompiling Jira/Confluence/
  GitHub end-to-end after the fix and confirming `anvil lint` exits 0 on all
  four products with no Zod errors.

### 10. The depth bound was a patch, not the fix — user pushback led to the real one: bundle, don't inline
- After #6–#9 shipped, working, tested, and shrinking every product's output
  (Jira 13MB→2.2MB, GitHub 17MB→4.2MB, Stripe from "hangs forever" to a
  bounded size) — the real question got asked directly: *why truncate at
  all? Stripe itself publishes this spec with no combinatorial issue.* That's
  correct, and it pinpointed the actual defect: the blowup was entirely
  self-inflicted by fully **dereferencing** every `$ref` (inlining the
  target's whole body at every use site) instead of **bundling** (keeping a
  `$ref` pointer to one canonical definition — what `json-schema-ref-parser`'s
  `bundle()` mode, OpenAPI Generator, and every real SDK generator actually
  do, and exactly how Stripe's own spec represents cross-referential types in
  the first place). A depth cap bounds a wrong architecture; it doesn't fix
  it — it still throws away real structure a caller might need, for no reason
  other than "the naive representation got too big."
- **Redesign**: `decycle.ts` became a two-phase pass:
  - `bundleDocument` — every **named** component schema
    (`components.schemas.<Name>`) is processed exactly once; every *use* of
    it elsewhere (including inside another named schema, including itself)
    becomes `{"$ref": "#/components/schemas/<Name>"}` instead of being
    inlined. Cost is O(unique named schemas), not O(paths that reach one) —
    structural, not a size optimization layered on top. A self-referential or
    cross-referential cycle among named types needs no special handling at
    all: it's just an ordinary `$ref`, the same way the source spec already
    represents it. Only genuinely deep *anonymous* (unnamed) structure can
    still hit a depth bound, which stays as a rare backstop.
  - `materializeSchema` — for one operation's own request/response schema,
    resolves its `$ref`s back into a small, self-contained, `$ref`-free
    schema (bounded by named-schema *hops*, not total node count), so every
    existing consumer (`normalize.ts`, `exampleFromSchema`, doc/skill
    generators) keeps working against a plain, fully-resolved object exactly
    as before — no downstream rewrite needed.
- **Test**: `decycle.test.ts` → "named component schemas — the real Stripe
  fix" (collapses every use to a `$ref`, keeps one definition; a
  self-referential named schema becomes an ordinary `$ref`, no truncation; a
  cross-referential A↔B cycle resolves as clean `$ref`s; 200 densely
  cross-referencing synthetic schemas stay fast) and the `materializeSchema`
  describe block.

### 11. The redesign's first version didn't work at all — dereference() doesn't share references — FIXED
- **Symptom**: after implementing #10, every one of Stripe's 859 named
  schemas still came out fully inlined — zero `$ref`s produced anywhere,
  confirmed by walking a bundled `charge` schema and counting: 710 nodes, 0
  refs.
- **Root cause**: the first version detected "is this node a named schema"
  by **object identity** — build a `Map<object, name>` from
  `components.schemas`, and check every visited node against it. That
  assumes a dereferencer gives you the *same* object reference every time a
  `$ref` resolves to the same target. `@scalar/openapi-parser`'s
  `dereference()` does not: verified directly against the real spec,
  `schema.components.schemas.charge.properties.balance_transaction.anyOf[1]
  === schema.components.schemas.balance_transaction` is `false` — every
  occurrence of a `$ref`, even the simplest, most direct one, is an
  independently cloned copy. The whole bundling mechanism silently did
  nothing.
- **Fix**: match named schemas **structurally**, via each schema's own
  `title` field, which OpenAPI tooling (and Stripe's spec, verified) sets to
  the type's PascalCase name wherever it's used — `Customer`,
  `BalanceTransaction` — regardless of which cloned copy is being looked at.
  Object identity is kept as a harmless fast-path fallback (correct on any
  source where it does happen to hold); title matching is the real signal.
  Titles are checked for collisions across schemas (two different named
  schemas sharing a title) and excluded from matching if ambiguous, rather
  than guessing.
- **Test**: `decycle.test.ts`'s named-component-schema tests exercise this
  directly (they'd all still pass with a no-op bundler if this weren't
  checked against real dereferenced Stripe data — the manual verification
  above, not the unit tests alone, is what actually caught this, since a
  hand-built test fixture can accidentally preserve object identity where the
  real library doesn't).

### 12. `materializeSchema`'s first version reintroduced the same blowup, one level down — FIXED
- **Symptom**: after #11's fix, `bundleDocument` correctly shrank
  `components.schemas` from 214MB to ~1MB — but a *single* Stripe
  operation's materialized response schema (`capture a charge`, whose
  response is the `charge` schema, expanded 3 named-schema hops deep) came
  out to **50MB**, and the full compile crashed with `Invalid string length`
  (V8's hard ceiling on `JSON.stringify`).
- **Root cause**: `resolveRefs` (the per-operation re-inliner) memoized
  within one call, so a given named type was only ever resolved once *per
  call* — correct as far as it went. But Stripe's core types are so densely
  mutually cross-referential that the breadth-first *frontier* of newly
  reached distinct schemas grows roughly two orders of magnitude with each
  additional hop: hop 1 from `charge` reaches ~20 types, hop 2 reaches ~100
  more, hop 3 ~300 more. Perfect memoization prevents *re*-visiting a name,
  but does nothing about a frontier that is legitimately that wide.
- **Fix**: measured the actual cost per depth on a real operation (`charge`'s
  own response) — depth 1 ≈ 15KB, depth 2 ≈ 950KB, depth 3 ≈ 50MB — and set
  `DEFAULT_MAX_REF_DEPTH = 1`. One hop is enough for `normalize.ts` to see an
  operation's own real field names and types (what it actually inspects); a
  field that is itself another named type gets a small, honest, non-recursive
  stub — *"A 'customer' object; nested one level deep… see the 'customer'
  schema for its full fields"* — instead of either a further unbounded
  expansion or a dangling `$ref` a downstream consumer can't resolve.
- **Test**: `decycle.test.ts` → "materializeSchema" → the depth-1-default
  test (asserts the stub shape and that exactly one hop was cut) and the
  explicit-depth-2 transitivity test (proves multi-hop resolution still works
  correctly when a caller asks for more room).

### 13. Auto-generated operationIds correctly scored as low-confidence — validates fix #5, not a new bug
- Stripe's real operationIds are literally `Method + PathConcatenation`
  (`PostChargesChargeCapture`, `PostPaymentIntentsIntentConfirm`) — they
  carry no more semantic information than the method+path fallback would.
  Every one of the 22 curated operations is flagged `weak_operation_name`
  (confidence 0.45) by the *same* vague-verb penalty raised in fix #5 (Jira's
  `doTransition`) — `snakeCase("PostChargesChargeCapture")`'s leading token is
  literally `post`, which is in `VAGUE_ACTIONS`. This is exactly the
  generalization that fix intended: not "penalize Jira's `do`," but
  "penalize any operationId whose only semantic content is a restated HTTP
  verb," and it now does, unprompted, on an entirely different vendor's spec.
  Left as a manifest-authoring finding (each operation would want a real
  `display_name`), not a further code change — the diagnostic is doing
  exactly its job.

## Confluence Cloud v2 (18 curated real operations)

Same compiler, same fixes — verified clean run, no new findings. Notably:
`GET /pages`, `/spaces`, etc. have no verb-like trailing segments in the
curated set, so finding #3 didn't recur here, but the fix is general (any
future Confluence endpoint shaped like `/space/search` would already be
covered). All four write operations (`createPage`, `createSpace`,
`createFooterComment`, `createInlineComment`) are honestly non-idempotent —
confirmed against mcp-atlassian, which carries no dry-run/dedupe parameter on
any of its `confluence_create_*` tools either.

- **API-generation gap, not an Anvil gap**: Confluence's v2 REST API (the one
  Atlassian publishes a spec for) has **no CQL/free-text search endpoint at
  all** — `confluence_search` in mcp-atlassian must fall back to the older v1
  content API, which Atlassian does not publish a current OpenAPI spec for.
  Anvil can only compile what the vendor documents; this is a real capability
  gap in Confluence's own API evolution, not something the compiler can paper
  over.

## Google Workspace / Twilio / Slack (format + scale + RPC batch)

Second batch, chosen because each stresses a code path the first four never
touched: Google Discovery is a non-OpenAPI *format*, Twilio is a *scale* test
(~1,800 endpoints), and Slack is *RPC-over-HTTP* naming on an archived Swagger
2.0 spec. Per-product write-ups: `gws.md`, `twilio.md`, `slack.md`.

### 14. `.json` REST format suffix leaked into the resource/CLI name — FIXED
- **Symptom**: Twilio's real Api2010 spec produced `twilio Messages.json list`
  / `twilio Messages.json create` for the list/create endpoints, but `twilio
  Messages get` / `twilio Messages delete` for fetch/delete — the *same*
  resource rendered two ways, with a wire-format detail (`.json`) leaking into
  the agent-facing CLI command and MCP tool name.
- **Root cause**: Twilio's collection paths end `/Messages.json` while
  item paths end `/Messages/{Sid}.json` (suffix on the id segment). The naming
  pass took the last concrete segment verbatim as the resource, so `.json` came
  along only for the former.
- **Fix**: `packages/compiler/src/naming.ts` — `decomposeSegment` strips a REST
  format suffix (`\.(json|xml|csv|…)$`) from the segment before it becomes a
  resource token; the wire path (`sourceRef.path`) is untouched, so the runtime
  still calls `/Messages.json`. `distinguishingToken`/`cleanPathTokens` strip
  it too, so a legitimate collision suffix is never `messages_json`.
- **Test**: `compiler.test.ts` → "strips a REST format suffix from the resource
  name (Twilio's .json)".

### 15. POST reused for update collided create+update onto one name — FIXED
- **Symptom**: Twilio's `CreateMessage` and `UpdateMessage` (both `POST`, on
  `/Messages.json` and `/Messages/{Sid}.json`) both derived the action "create"
  → CLI `twilio Messages create` for both → a forced `_post` disambiguation
  suffix (`twilio_create_message_post`) and the update mislabeled as a create.
- **Root cause**: `actionFor(POST)` always returns "create"; Twilio (like many
  REST APIs) reuses POST for update, carrying the real verb only in the
  operationId.
- **Fix**: `naming.ts` — `postVerbFromOperationId` honors the operationId's
  leading verb for the one case the HTTP method genuinely can't express: a POST
  named `Update*`/`Delete*`. Deliberately scoped to POST + update/delete only —
  it does NOT trust a leading verb in general, because Stripe's `GetCustomers`
  is really a *list* (finding #13's territory), so a blanket "trust the verb"
  would regress that. Now `twilio Messages create` vs `twilio Messages update`,
  aligned with the operationId-derived tool names, no collision.
- **Test**: `compiler.test.ts` → "uses the operationId verb for a POST reused
  as update/delete (Twilio POST-for-update)".

### 16. RPC-over-HTTP dotted paths broke the CLI command — FIXED
- **Symptom**: Slack's `/chat.postMessage` produced CLI `slack chat.postMessage
  send` — a literal dot in the command, a redundant appended verb, and drift
  from the clean MCP tool name `slack_chat_post_message`. Naively splitting the
  namespace then *collided* `conversations.archive` with
  `admin.conversations.archive` (Slack ships both).
- **Root cause**: Slack's Web API is RPC-over-HTTP — `/chat.postMessage` is a
  single path segment `namespace.method`, not a REST resource path. The naming
  pass treated the whole dotted string as the resource.
- **Fix**: `naming.ts` — `decomposeSegment` splits an RPC dotted segment into
  resource + action, keeping the *full* namespace as the resource
  (`admin_conversations` vs `conversations`, so no spurious collision) and
  snake-casing the trailing method as the action. CLI `slack chat post_message`
  now matches the tool `slack_chat_post_message`; this is exactly the `.`→`_`
  transform korotovsky/slack-mcp-server does by hand.
- **Tests**: `compiler.test.ts` → "decomposes an RPC-style dotted path…" and
  "keeps namespaced RPC methods distinct instead of colliding (Slack admin.*
  vs bare)".

### 17. Google Discovery format was unsupported — FIXED (new protocol adapter)
- **Symptom**: feeding Anvil the real Gmail Discovery document produced a clean
  `source/no_declared_format` diagnostic and an `unclassified` snapshot (no
  crash — good defensive behavior), but the API could not be compiled at all.
- **Root cause**: Google publishes every Workspace/Cloud API as a **Discovery
  Document** (`discovery#restDescription`), not OpenAPI: a nested
  `resources.<r>.methods.<m>` tree with bare `$ref: "TypeName"` references.
  Anvil supported OpenAPI/Swagger/GraphQL/proto/WSDL, but not this.
- **Fix**: `packages/compiler/src/protocols/discovery.ts` — a new protocol
  adapter (the architecture already lowers non-REST formats to OpenAPI 3.0).
  It walks the resource tree into flat paths, maps Discovery parameters
  (`location` → `in`, `repeated` → array), lowers `request`/`response` refs to
  a JSON body/response, moves `schemas` to `components.schemas`, and rewrites
  every bare `$ref: "Name"` to `#/components/schemas/Name`. Detected by the
  `kind` discriminator. Unlocks *all* Google APIs at once, not just Gmail.
- **Tests**: `protocols/protocols.test.ts` → "Google Discovery adapter" (4
  cases) + "compiles Google Discovery: send is a comms mutation, list is a
  safe read".

### Scale (Twilio, no code change needed)
The **full** Twilio Api2010 spec (121 paths → 197 operations, 148 schemas)
compiles in ~1.7s, and the full Slack spec (174 operations) in ~1.9s — the
bundle/materialize schema design from findings #10–#12 is what makes an
unfiltered large spec tractable. Twilio's own MCP collapses its ~1,800
endpoints to a two-tool `search`/`retrieve` façade precisely because
per-endpoint tooling "is unusable unloaded" at that scale; Anvil's answer is
capability grouping over the same surface. Logged as validation, not a defect.

## Notion / Asana / PagerDuty / Zendesk / Intercom / Zoom / HubSpot / DocuSign (batch 2)

Eight more real systems (`batch2.md`). Six compiled clean on the first try —
strong evidence the compiler is now solid across OpenAPI 3.x and Swagger 2.0 at
scale (Zendesk 617 ops, PagerDuty 465, DocuSign 414). Two systemic bugs, each
only reachable by a spec of that specific shape or scale:

### 18. Per-operation schema materialization had no *size* bound — 56s / 400MB compile — FIXED
- **Symptom**: `anvil compile` on the real DocuSign eSignature spec (Swagger
  2.0, 213 paths, 619 definitions) took **56 seconds** and built a **400MB**
  in-memory AIR; `airToYaml` alone was 30s+ on the result.
- **Root cause**: `materializeSchema` (decycle.ts) bounds a materialized
  per-operation schema by ref-*depth* (`DEFAULT_MAX_REF_DEPTH = 1`) — enough to
  cap a *deep* named-schema chain (the Stripe case, #10–#12). But DocuSign's
  request bodies (`tabs`, `accountSettingsInformation`) are pathologically
  *broad*: hundreds of properties, each itself a large object. A single depth-1
  hop over that breadth still materialized ~2.5MB per operation, times 414
  operations. Depth alone cannot catch breadth.
- **Fix**: `DEFAULT_MAX_SCHEMA_NODES` (4000) — a total node budget threaded
  through the materialize walk. Once spent, further structure truncates to a
  typed stub (the field name is kept, its deep body dropped), so no single
  operation's schema can blow up the AIR regardless of the source spec's shape.
  The budget sits 4× above the largest real operation schema seen across all
  backtested specs (PagerDuty ~1032 nodes, Zendesk ~838), so every
  non-pathological spec is byte-identical — verified against the other seven
  batch-2 specs and every committed example. DocuSign: 56s → 19s.
- **Test**: `decycle.test.ts` → "bounds a very BROAD schema by node budget, not
  just ref depth (DocuSign's real shape)" and "leaves a normal-sized schema
  untouched by the node budget".

### 19. Anvil could not re-parse its own generated `air.yaml` — lint/certify failed — FIXED
- **Symptom**: `anvil lint generated/pagerduty` exited non-zero with
  *"Excessive alias count indicates a resource exhaustion attack"* — from the
  `yaml` parser, on Anvil's OWN generated `air.yaml`.
- **Root cause**: `lint`/`certify` re-read `air.yaml` via `airFromYaml`.
  PagerDuty's real 465-operation bundle repeats identical substructures (the
  shared retry-condition list, error shapes) on every operation, so the `yaml`
  serializer emitted a YAML anchor/alias per repeat — 110 of them. The parser's
  default anti-"billion laughs" cap is 100 aliases, so it refused to load a
  perfectly valid, self-generated document. Any bundle past ~100 repeated
  substructures (i.e. any large real API) would hit this.
- **Fix**: `packages/air/src/serialize.ts`. Two parts: (a) `airToYaml` sets
  `aliasDuplicateObjects: false` so the canonical form emits **no** aliases —
  self-contained and human-diffable (an `*alias` pointing elsewhere in a
  20k-line file is unreadable anyway); (b) `airFromYaml` raises `maxAliasCount`
  for the trusted AIR re-parse so already-written/older bundles still load.
  Untrusted specs and manifests are parsed elsewhere (parse.ts, manifest.ts)
  and keep the default billion-laughs protection.
- **Test**: `air.test.ts` → "round-trips a bundle with many repeated
  substructures without emitting aliases".

### HubSpot's opaque operationIds — faithful rendering, not a bug (validates #13)
HubSpot's Deals path is `/crm/v3/objects/0-3` (`0-3` is HubSpot's real internal
object-type id) and its operationId embeds the whole path
(`get-/crm/v3/objects/0-3_getPage`). Anvil renders
`hubspot_get_crm_v3_objects_0_3_get_page` — verbose but a true reflection of a
genuinely opaque vendor spec, the same category as Stripe's
`PostChargesChargeCapture` (#13). The official HubSpot MCP avoids it with
object-agnostic meta-tools — a design choice a faithful per-endpoint compiler
should not invent. Left as a documented finding.

## Real GraphQL & gRPC (GitHub, Linear, Temporal, etcd)

The non-REST adapters had only been exercised on small synthetic fixtures.
Running them against real published schemas (GitHub's 1,752-type GraphQL, a
121-rpc Temporal proto) surfaced three systemic bugs — see `protocols-real.md`.

### 20. Real GraphQL schemas hung the compile — gigabytes on serialize — FIXED
- **Symptom**: `anvil compile` on GitHub's real 1.5MB / 1,752-type GraphQL SDL
  timed out at 3 minutes. `adaptGraphql`, `parseSource`, and `compileSource`
  were each fast (<2s); `airToJson`/`airToYaml` hung.
- **Root cause**: `parseSource` fully `dereference()`s the adapter output.
  GraphQL is deeply recursive (`User → Repository → … → User`), so dereference
  produced a massively-shared object graph — compact in memory but exploding to
  gigabytes when `JSON.stringify` expands the sharing. `bundleDocument` should
  re-collapse each named type to a `$ref`, but it re-identifies inlined copies
  **by `title`** (dereference clones fresh objects, so identity can't be used —
  the Stripe finding, #11). The protocol adapters (GraphQL/gRPC/WSDL/Discovery)
  emitted named schemas with no `title`, so bundleDocument couldn't collapse
  them and the depth bound alone left millions of nodes.
- **Fix**: `stampSchemaTitles` in parse.ts — stamp `title: <componentKey>` on
  every adapter-produced named schema (where absent) before dereference, at the
  one seam all four lowered formats share. `airToJson` went from *hung* to
  54ms / 4.2MB. Real OpenAPI specs already set `title`, so the REST path is
  unchanged.
- **Test**: `compiler.test.ts` → "compiles a large recursive schema without
  exploding (adapter title stamping)".

### 21. Synthetic-namespace paths doubled the tool names — FIXED
- **Symptom**: GitHub GraphQL produced tool names like
  `github_gql_accept_enterprise_administrator_invitation_accept_enterprise_administrator_invitation`
  (field name repeated) and CLI `github_gql Mutation approve <field>`.
- **Root cause**: GraphQL/gRPC lower every operation under a synthetic namespace
  (`/graphql/Mutation/<field>`, `/<pkg.Service>/<Method>`). The naming pass
  treated the wrapper (`Mutation`) as the resource and a field that merely
  *contains* a vocab verb (`acceptEnterpriseAdministratorInvitation` → "accept",
  `issueFigmaFileKeySearch` → "search") as a trailing verb. Every field then
  collapsed onto the wrapper, collided, and disambiguation re-appended the
  already-unique field name — doubling the tool name.
- **Fix**: `naming.ts` — the trailing-verb rule fires only on a **bare** verb
  segment (a single-word segment that IS the verb, `/field/search`), not a
  multi-word operation name. The field name then stays the resource (unique →
  no collision). Tool names became `github_gql_create_issue`,
  `github_gql_merge_pull_request` — matching github-mcp-server exactly.
- **Test**: `compiler.test.ts` → "keeps a synthetic-namespace operation name
  from doubling (GraphQL Query/Mutation wrapper)".

### 22. gRPC message types imported from another file didn't resolve — FIXED
- **Symptom**: Temporal's `StartWorkflowExecution` compiled with an opaque
  `body: string` stub instead of the request's real fields.
- **Root cause**: real gRPC services split a method's request/response messages
  into sibling protos (`import "…/request_response.proto"`). The adapter parsed
  only the entrypoint file via `protobuf.parse(source)`, so imported message
  types stayed unresolved and the body degraded to a stub.
- **Fix**: `adaptProto` gained an optional `resolveImport` callback;
  `parse.ts`'s `protoImportResolver` resolves an `import "path"` from the
  snapshot's other files (verbatim path, then basename), loading them into the
  same protobuf root transitively — the exact multi-file contract Anvil already
  honours for OpenAPI `$ref`s (same-snapshot bytes only, never the network). An
  unresolvable import still degrades gracefully. Proven on etcd's real 4-file
  proto: `Put` resolves `key,value,lease,prev_kv,…`; the imported `KeyValue`
  message resolves its fields.
- **Tests**: `protocols.test.ts` → "resolves message types imported from another
  proto file" and "degrades gracefully when an import cannot be resolved".

## The mechanisms round (corpus harness, structural identity, naming dialect)

After 22 hand-found bugs, the fix families were converted into standing
mechanisms (see `../mechanisms.md`): a corpus-differential CI harness
(`tools/corpus/`), structural hash-consed schema identity (decycle.ts), and
whole-spec naming-dialect inference + multi-surface collision repair
(dialect.ts / naming.ts). The harness found two shipped bugs on its FIRST run
— and then caught a third, unshipped regression during integration itself.

### 23. Same-named GraphQL Query+Mutation fields could not compile — FIXED
- **Symptom** (found by the harness's quick mode on Linear's real schema):
  `Query.initiativeUpdate` and `Mutation.initiativeUpdate` both derive
  canonicalName `initiative_update` → identical `mcp.toolName` → validate.ts
  hard-errors `duplicate_tool_name`; the whole 611-operation spec refuses to
  compile.
- **Root cause**: `resolveNameCollisions` grouped ONLY by `cli.command`. The
  two operations' CLI commands differ (`... list` vs `... create` action
  tokens), so the resolver never saw a group — while the tool name, which
  omits the action distinction, collided invisibly.
- **Fix**: collision repair now enforces uniqueness across BOTH projected
  surfaces — the identical shortest-distinguisher repair runs keyed by
  `cli.command` and then by `mcp.toolName`, re-deriving groups to a fixpoint,
  renaming canonicalName/id/command/toolName together, never a silent `_2`.
  Linear compiles: `linear_initiative_update_query` / `..._mutation`.
- **Test**: compiler.test.ts → "resolves toolName collisions across
  read/write surfaces (Linear's Query+Mutation same-name fields)".

### 24. `airToYaml` silently corrupted YAML-hostile whitespace — FIXED
- **Symptom** (found by the harness's sweep round-trip oracle on the real
  lgtm.com spec): a description containing a whitespace-only line plus
  trailing-space lines gained an extra `\n` through the pretty block-scalar
  emission — `contractHash` drifted between the compile and what
  `lint`/`certify` re-read from air.yaml. Silent, and invisible to every
  hand-run backtest because none of the 17 curated systems happened to carry
  that whitespace shape.
- **Root cause**: YAML block scalars cannot represent trailing whitespace on
  a line; the emitter's style chooser picked one anyway.
- **Fix**: `airToYaml` scans for risky whitespace (cheap regex, common case
  pays nothing), verifies its own output re-parses to deep equality when
  flagged, falls back to fully-quoted lossless emission on drift, and throws
  rather than emit a canonical artifact that will not round-trip.
- **Test**: air.test.ts → "round-trips descriptions with YAML-hostile
  whitespace" (the exact lgtm shape) + "keeps pretty block scalars for
  ordinary multi-line descriptions".

### 25. Write-method poll/export endpoints misclassified as reads — FIXED (external review)
- **Found by**: Codex automated review on PR #13 (P1) — the first finding from
  a reviewer outside this pipeline; credited accordingly.
- **Symptom**: `PUT /tickets/{id}/status` (and even `POST .../status`)
  compiled as `read`/`risk: none` — a state CHANGE bypassing the entire
  mutation review/confirmation posture, because the write-method read
  exception accepted any readIntent verb (search/export/poll families) on
  POST *or* PUT.
- **Fix**: the exception is now search-family on POST only — the original,
  Jira-validated case. Poll verbs never flip a write method (a write-method
  "status" endpoint sets status); POST export stays a mutation (creates a
  job/artifact); PUT never flips. Strictly tightening; a genuinely read-only
  outlier is what the manifest's `side_effect: read` override is for.
- **Tests**: compiler.test.ts → "never flips a write-method status/progress
  endpoint to a read" + "keeps PUT-search and POST-export conservatively
  mutations". Verified against the live corpus: jira/github/twilio/slack/
  zendesk/zoom/temporal all green, naming fixtures intact.

### 26. Discovery adapter dropped `servicePath` from the server URL — FIXED (external review)
- Gmail worked by luck (empty servicePath); Drive-shaped documents (rootUrl
  `googleapis.com/` + servicePath `drive/v3/` + relative method paths) would
  compile to runtime calls against `/files` instead of `/drive/v3/files`.
  Server is now `baseUrl ?? rootUrl+servicePath`. Test: "builds the server
  from baseUrl/servicePath, not bare rootUrl".

### 27. Discovery adapter lost per-method OAuth scopes — FIXED (external review)
- `method.scopes` was modeled but never emitted, so every Google operation
  inherited the document-level `oauth2: []` and lost its real scopes (Gmail
  send vs readonly) in the generated AIR. Methods with scopes now emit
  `security: [{oauth2: [...scopes]}]`, which normalize already consumes.
  Test: "emits per-operation security from method scopes".

## GDS / SOAP (Travelport uAPI Air v45_0 — real multi-file WSDL)

The first production SOAP tree (8 files: entry WSDL → wsdl:import'ed abstract
WSDL → transitive xsd:include/xsd:import chains with `../` relative paths)
surfaced the WSDL analogue of proto finding #22, in three connected parts.

### 28. Multi-file WSDL/XSD trees could not compile at all — FIXED
- **Symptom**: Travelport's `Air.wsdl` entry point compiled to **0
  operations** (its portType and messages live in the `wsdl:import`ed
  `AirAbstract.wsdl`); compiling the abstract WSDL directly yielded opaque
  request stubs (unresolved `xsd:include`/`xsd:import`); and `anvil source
  add` refused `.xsd` supporting files outright with `source/unparseable`
  (the importer YAML-probed them).
- **Fix (mechanism, mirrors #22)**: `.xsd` files get the `.proto`-style
  verbatim capture bypass and an XML import walker captures the whole
  referenced tree preserving relative directory structure; `adaptWsdl` takes
  an injectable import resolver (same shape as the proto one, now a shared
  `snapshotImportResolver`) and resolves `wsdl:import` / `xsd:include` /
  `xsd:import` transitively with cycle protection and graceful degradation
  for missing targets; `complexContent/extension` lowers to `allOf` and
  `element ref=` promotes to component `$ref`s via a deferred resolution
  pass. Adapters stay pure — no filesystem access inside `protocols/`.
- **Proof**: the real 8-file tree compiles from `Air.wsdl` with 29
  operations and real request schemas (AirLowFareSearch's body carries
  SearchPassenger/AirPricingModifiers/… from three different XSD files);
  the synthetic single-file `examples/soap/bank.wsdl` output is
  byte-identical before/after. Tests: 6 multi-file WSDL fixtures + 3
  importer capture tests.

### 29. portType names polluted WSDL operation naming — FIXED
- **Symptom**: operations compiled via an imported portType were named like
  `tp_air2 service create flight_details_port_type` — the portType's own
  name leaked in as the object noun, and the wire operation name lost out.
- **Fix**: when an operation name repeats across portTypes the
  portType-derived identity disambiguates the operationId/path while
  `x-soap-operation` keeps the wire name; unique names (bank.wsdl) are
  provably untouched. Travelport now yields `air_service_air_low_fare_search`
  (CLI `air_service AirLowFareSearch search`), and the classifier reads the
  real verbs: all five `*Search` operations classify as reads, ticketing/
  exchange as review-required mutations, and both refund operations as
  financial-risk mutations.

## The loopback round (self-test + model review — first executions of the generated path)

`anvil selftest` (boot the bundle's own mock + MCP server, drive every
approved tool over real MCP transport, diff sent args against the wire) and
`anvil review` (SOP-driven Haiku audit of the artifact surfaces) landed as
standing infrastructure. The self-test's FIRST runs found the largest bug of
the project so far — nothing had ever executed the generated MCP path.

### 30. Adapter-lowered reads were un-executable: GET with a required body — FIXED
- **Symptom**: every WSDL, GraphQL, AND gRPC read lowered to HTTP GET while
  keeping a required JSON `requestBody`. The runtime built GET+body, the
  HTTP client refused to send it ("Request with GET/HEAD method cannot have
  body"), and the operation failed with `upstream_unavailable` — zero wire
  requests, ever. Travelport searches, GitHub GraphQL queries, Linear
  queries, and Temporal list RPCs were all dead on the wire. Invisible to
  827 unit tests and every corpus oracle because none of them executed the
  generated server.
- **Root cause (mechanism-level)**: the adapters chose GET to *signal
  read-ness to the classifier* — smuggling effect semantics through the
  HTTP method of protocols that are POST-on-the-wire by definition.
- **Fix**: adapters emit the truthful wire method (POST for all SOAP,
  GraphQL, and gRPC operations) and assert effect explicitly via
  `x-anvil-effect: read`; the classifier honors the assertion as evidence
  (definitional 0.9 for GraphQL Query fields, name-heuristic 0.5 for
  WSDL/gRPC — matching the old GET path), and naming derives from the
  asserted effect so every generated name is byte-identical to before
  (proven by the corpus naming-differential fixtures across github_gql,
  linear, temporal). Retry/idempotency already derived from effect kind.
- **Proof**: Travelport selftest 9/9; bank.wsdl loopback fully green; a
  GraphQL query executes as POST and passes fidelity; corpus 19/19 with
  op-counts and names exactly at baseline.

### 31. Example synthesis produced no body for materialized schemas — FIXED
- `exampleFromSchema` returned nothing for `allOf` schemas whose first
  member is a depth-truncation stub (exactly what per-operation
  materialization produces for deep WSDL/REST trees), and mishandled
  oneOf/anyOf — so the self-test couldn't drive deep operations
  (`validation_error: Missing required input: body`, 0 wire requests) and
  generated skill examples were silently hollow. Now: allOf deep-merges
  member examples (later wins), oneOf/anyOf synthesize the first member,
  typeless stubs become `{}`, and a required body is never absent. The
  loopback also round-trips responses against the scenario the mock
  reports having served (capture records carry the scenario name) instead
  of guessing, and an empty approved surface reports plainly instead of
  leaking an MCP protocol error.

### 32. Path-item-level parameters never entered the input contract — FIXED
- Asana and Zendesk declare path params at the **path-item** level (shared
  across methods), which OpenAPI fully permits; `normalize()` read only
  operation-level `parameters`, so `{project_gid}`/`{ticket_id}` never became
  inputs — synthesis, the executor, the CLI, and the MCP tool schema all
  agreed on a contract missing the URL's own parameters, and the wire showed
  literal `%7Btask_gid%7D`. Path-item params now merge into every method
  (operation-level wins on name+location, per the spec's override rule).

### 33. Accept/Content-Type/Authorization header parameters forwarded — FIXED
- PagerDuty declares `Accept`/`Content-Type` as header parameters; Anvil
  modeled them as real inputs, so a synthesized value rode alongside the
  runtime's own header and undici comma-joined them on the wire
  (`accept: "application/json, example"`). The OpenAPI spec mandates those
  three header parameters be ignored — they are now dropped at parameter
  collection with an info `header_param_ignored` diagnostic each, so every
  downstream surface agrees.

### 34. Generated mock router missed segment-embedded params — FIXED (mock infra, not compiler)
- Twilio's `/Calls/{Sid}.json` templates 404'd: the emitted matcher only
  handled full-segment `{param}`s. Segments now compile to per-segment
  regexes (escaped literals + non-empty captures) with percent-decoding and
  deterministic most-literal-first routing.

### 35. Example synthesis, zod tool shape, and mock validation disagreed — FIXED
- Four gaps found by HubSpot/Intercom: vendor `example: null` returned
  literally; `anyOf` refinement branches carrying only `required` collapsed
  to `null` instead of deep-merging with the base object; record/
  `additionalProperties` maps synthesized nothing; optional inputs were sent
  as `null` where zod optional means *absent* (and `zodshape` stringified
  non-string enums). All three consumers of the input contract now agree by
  construction — pinned by a dedicated synthesis↔zodshape agreement suite.

### 36. Non-object bodies and unresolved proto messages — FIXED
- Jira's `addWatcher` takes a bare JSON **string** body; the mock validator
  hard-required an object. Body validation is now type-general
  (string/number/array/boolean/object/untyped). Temporal single-file proto:
  unresolved request/response message types degraded to `{type:"string"}`;
  by grammar an RPC request/response is always a message, so they degrade to
  permissive objects — an all-optional proto3 message accepts `{}` end to
  end.
