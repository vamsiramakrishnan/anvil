/**
 * Turn a fully `$ref`-dereferenced OpenAPI document into one that is both
 * JSON-safe and bounded in size, without losing real structure. This is a
 * two-phase *bundle, then materialize* design — the same shape real tooling
 * uses (`json-schema-ref-parser`'s `bundle()`, OpenAPI Generator's one-type-
 * per-schema output) instead of naive full inlining:
 *
 * 1. `bundleDocument` — every **named** component schema
 *    (`components.schemas.<Name>`) is processed exactly once, and every
 *    *use* of it elsewhere (including inside another named schema, including
 *    itself) becomes a lightweight `{"$ref": "#/components/schemas/<Name>"}`
 *    pointer instead of being inlined. This is not a size *optimization* on
 *    top of inlining — it removes the combinatorial blowup structurally: a
 *    real, densely cross-referential spec (Stripe's ~860 schemas is the case
 *    that found this) costs O(unique named schemas), not O(every path that
 *    happens to reach one), because nothing is ever re-walked past a name it
 *    has already seen. A self-referential type (`Group.subgroups: Group[]`)
 *    or a cross-referential cycle (`Customer` → `Subscription` → `Invoice` →
 *    `Customer`) is just an ordinary `$ref` — no truncation needed, because
 *    it's real, valid JSON Schema, exactly how the *source* spec already
 *    represents it. Anonymous (unnamed) nested structure is still inlined
 *    directly, with a depth bound as a backstop for the rare case that isn't
 *    broken up by a name.
 * 2. `materializeSchema` — for one operation's own request/response schema,
 *    resolve its `$ref`s back into a small, fully self-contained, `$ref`-free
 *    schema (bounded by how many *named-schema* hops deep it follows, not by
 *    total node count) — so every existing consumer (`normalize.ts`,
 *    `exampleFromSchema`, doc/skill generators) keeps working against a
 *    plain, fully-resolved object exactly as before. The expensive part (the
 *    whole spec's schema graph) only happens once, in phase 1; phase 2 runs
 *    per operation over an already-small, already-deduped input.
 */
export interface BundleResult<T> {
  document: T;
  /** Document paths (dot/bracket notation) where a true cycle in *unnamed* structure was truncated. */
  truncatedAt: string[];
  /** Document paths where unnamed structure was cut off by the depth bound (not a cycle). */
  depthLimitedAt: string[];
  /**
   * Components synthesized by the bundler for large repeated ANONYMOUS
   * structure (no vendor name to collapse to). `path` is the position whose
   * repetition triggered the hoist; `name` is the deterministic
   * `components.schemas` entry the repeats now `$ref`.
   */
  synthesized: { name: string; path: string }[];
}

/**
 * Nesting levels a schema may expand before truncating, counted from each
 * schema's own root (see the `inSchema` gate in `walk` — document/path
 * wrapper structure never counts against this). This only bounds *unnamed*
 * (anonymous) structure now that named schemas collapse to `$ref` instead of
 * being inlined — real specs rarely nest anonymous objects this deep without
 * a name breaking it up, so this is a backstop, not the primary mechanism.
 */
export const DEFAULT_MAX_SCHEMA_DEPTH = 6;

/**
 * How many named-schema `$ref` hops `materializeSchema` follows before
 * truncating a nested reference to a typed stub instead of continuing to
 * inline it. Measured against a real Stripe operation (`capture a charge`,
 * whose response is the `charge` schema): depth 1 keeps it to ~15KB; depth 2
 * jumps to ~950KB; depth 3 (the first value tried here) reached 50MB for a
 * *single operation* — Stripe's core types are so densely mutually
 * cross-referential that each additional hop's breadth-first frontier of
 * newly-reached distinct schemas grows by roughly two orders of magnitude.
 * 1 hop is enough for `normalize.ts` to see an operation's own real field
 * names/types (what it actually needs), while any field that is itself
 * another named type gets a small, honest, non-recursive stub — "this is a
 * Customer object" — rather than either a dangling unresolved `$ref` or a
 * further unbounded expansion.
 */
export const DEFAULT_MAX_REF_DEPTH = 1;

/**
 * The maximum number of nodes one operation's materialized schema may contain
 * before further expansion truncates to stubs. The ref-*depth* bound above
 * caps a *deep* chain, but a single hop into a very *broad* schema can still
 * explode: DocuSign's `tabs`/`accountSettingsInformation` request bodies have
 * hundreds of properties, each itself a large object, so depth-1 materializes
 * to ~2.5MB *per operation* — 414 of those made a 400MB AIR that took `airTo
 * YAML` 30s+ to serialize. Depth alone can't catch breadth; this does. The
 * budget is generous — a real Stripe `charge` (the densest normal case)
 * materializes to well under it, so every non-pathological spec is untouched —
 * and it counts nodes in the OUTPUT, so it bounds input, output, and body
 * schemas alike. An agent cannot use a 2.5MB field list anyway; a bounded,
 * honestly-stubbed schema is strictly more usable.
 */
export const DEFAULT_MAX_SCHEMA_NODES = 4000;

type Ref = { $ref: string };
const isRef = (v: unknown): v is Ref =>
  typeof v === "object" && v !== null && typeof (v as Record<string, unknown>).$ref === "string";
const refName = (ref: Ref): string | undefined =>
  ref.$ref.match(/^#\/components\/schemas\/(.+)$/)?.[1];

/** Collect `components.schemas` from a parsed OpenAPI document, defensively. */
function namedSchemasOf(document: unknown): Record<string, unknown> {
  const doc = document as { components?: { schemas?: Record<string, unknown> } } | undefined;
  return doc?.components?.schemas ?? {};
}

// ---------------------------------------------------------------------------
// Structural identity (canonical hashing by hash refinement)
//
// `bundleDocument` must recognize "this node IS component X, inlined here" so
// it can collapse the occurrence back to `{$ref}`. Object identity alone is
// not enough — `@scalar/openapi-parser`'s `dereference()` clones a fresh copy
// per reference site for acyclic refs (verified against the real Stripe spec),
// only sharing objects where a cycle forces it. Identity used to be patched
// over with vendor-supplied `title` matching, which silently failed on every
// spec whose components carry no titles (or duplicate ones) — GitHub's real
// 1,752-type GraphQL schema hung the compile that way. The mechanism below
// derives identity purely from STRUCTURE, so it never depends on what a
// vendor chose to call anything:
//
// 1. Collect every distinct object/array node (by JS identity) reachable from
//    the document. Cycles force sharing in the dereferenced graph, so the
//    distinct-node count is far below traversal count.
// 2. Give each node a round-0 hash of its LOCAL shape only: object/array tag,
//    sorted key names, scalar values (title and description included — see
//    the match-hash nuance below), with composite children as placeholders.
// 3. Refine: each round, a node's next hash mixes its OWN previous hash with
//    its local shape and its children's previous-round hashes. Including the
//    node's own previous hash makes every round a strict refinement of the
//    last (hash classes only ever split, never merge), so the fixpoint test
//    is simply "the number of distinct hashes stopped growing". Isomorphic
//    (bisimilar) nodes — a component body and any clone of it, however deep
//    the cycles — hash identically in every round; distinguishable nodes
//    split within graph-diameter rounds, hard-capped at
//    MAX_REFINEMENT_ROUNDS. Cycles need no special casing at all.
// 4. After the refinement fixpoint, each node gets its MATCH hash: its own
//    local shape MINUS its own top-level `description`, combined with its
//    children's full refined hashes. This is the identity used for all
//    collapse decisions, and the asymmetry is deliberate and surgical:
//    `dereference()` merges each reference SITE's sibling `description` onto
//    the resolved clone's TOP object — measured on GitHub's real GraphQL
//    schema, 2,660 of 3,868 inlined component copies differed from their
//    component body ONLY in that top-level description, which made strict
//    hash matching miss, left the clones un-collapsed, and re-exploded the
//    output past V8's string limit. Descriptions everywhere DEEPER still
//    count (interior positions are cloned verbatim from the same source, so
//    they agree between body and clone), which keeps genuinely different
//    schemas that merely share a skeleton — e.g. two REST types whose nested
//    fields differ only in prose — from merging: only the one field
//    dereference actually rewrites is forgiven, nothing else.
// 5. `buildStructuralIndex` maps each named component body's match hash
//    to its name. Two DIFFERENT names with structurally identical bodies are
//    genuine aliases; the collapse target is picked deterministically:
//    prefer the alias whose name equals the shared body's own `title` (when
//    a title exists and matches one of the names), else the
//    lexicographically smallest name. Every alias keeps its own full body in
//    `components.schemas`; only *uses* collapse to the canonical pick.
//
// Only COMPOSITE component bodies (those with at least one object/array
// child) are indexed: collapsing every bare `{type: "string"}` in a document
// to a `$ref` because some component happens to be exactly that would be
// semantically sound but pure noise — the explosion bug family this kills is
// about composite/recursive structure.
// ---------------------------------------------------------------------------

/** Hard cap on refinement rounds; real graphs converge in ~graph-diameter rounds. */
const MAX_REFINEMENT_ROUNDS = 64;

/**
 * Keys ignored in a node's OWN local shape when computing its MATCH hash
 * (never in its children's): annotations that carry no validation semantics
 * and that dereference legitimately rewrites on the clone's top object per
 * reference site. See point 4 of the section comment for the measured
 * evidence.
 */
const IDENTITY_ANNOTATION_KEYS = new Set(["description"]);

/**
 * Minimum OUTPUT tree size (object/array node count) at which an
 * already-emitted expansion is hoisted into a synthesized component instead
 * of being emitted again at a second tree position. Small shared stubs are
 * cheaper inline than as a `$ref` + definition; large ones (GraphQL
 * connection wrappers, adapter-lowered arg objects) multiply through
 * `JSON.stringify`'s tree expansion — GitHub's real 1,752-type schema
 * reached >10.5M tree positions from only 23,502 distinct nodes that way.
 * With hoisting, any expansion this large appears at most twice (its first
 * inline emission plus the synthesized definition); every further
 * occurrence is a pointer, so output tree size stays O(distinct input
 * nodes × this constant) for ANY input.
 */
const HOIST_MIN_OUTPUT_NODES = 64;

interface StructuralIndex {
  /**
   * Canonical MATCH hash of every object/array node reachable from the
   * document: full structural identity, except the node's own top-level
   * annotation keys (IDENTITY_ANNOTATION_KEYS) are ignored — see point 4 of
   * the section comment.
   */
  nodeHash: Map<object, string>;
  /** Match hash of a named component body → all names with that structure + the canonical collapse target. */
  byHash: Map<string, { canonical: string; names: Set<string> }>;
}

/**
 * Deterministic 64-bit string hash (two independent 32-bit imul lanes, cyrb53
 * finalization). Pure arithmetic on char codes — identical across runs and
 * platforms, and fast enough to re-hash every node once per refinement round.
 */
interface HashState {
  h1: number;
  h2: number;
}
const newHashState = (): HashState => ({ h1: 0xdeadbeef, h2: 0x41c6ce57 });
function mixString(state: HashState, str: string): void {
  let { h1, h2 } = state;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  state.h1 = h1;
  state.h2 = h2;
}
function digest(state: HashState): string {
  let { h1, h2 } = state;
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

/** Injective-enough scalar encoding: type-tagged, JSON-escaped where it matters. */
function encodeScalar(v: unknown): string {
  if (v === null) return "z";
  switch (typeof v) {
    case "string":
      return `s${JSON.stringify(v)}`;
    case "number":
      return `n${v}`;
    case "boolean":
      return v ? "b1" : "b0";
    case "undefined":
      return "u";
    default:
      return `x${String(v)}`;
  }
}

/**
 * One node's local shape, precomputed once: literal text chunks interleaved
 * with composite-child slots. The hash input of a round is
 * `statics[0] · h(children[0]) · statics[1] · … · statics[n]`.
 */
interface NodeTemplate {
  statics: string[];
  children: object[];
}

function buildTemplate(node: object, skipAnnotations: boolean): NodeTemplate {
  const statics: string[] = [];
  const children: object[] = [];
  let run: string;
  if (Array.isArray(node)) {
    run = `A${node.length}`;
    for (const v of node) {
      if (v !== null && typeof v === "object") {
        statics.push(`${run}|`);
        children.push(v);
        run = "";
      } else {
        run += `|${encodeScalar(v)}`;
      }
    }
  } else {
    run = "O";
    const record = node as Record<string, unknown>;
    // Sorted keys: structural identity must not depend on insertion order.
    for (const key of Object.keys(record).sort()) {
      if (skipAnnotations && IDENTITY_ANNOTATION_KEYS.has(key)) continue;
      run += `|${JSON.stringify(key)}:`;
      const v = record[key];
      if (v !== null && typeof v === "object") {
        statics.push(run);
        children.push(v);
        run = "";
      } else {
        run += encodeScalar(v);
      }
    }
  }
  statics.push(run);
  return { statics, children };
}

/**
 * Canonical MATCH hash of every object/array node reachable from `root`, by
 * hash refinement over full structure followed by one annotation-agnostic
 * finishing pass (see points 3–4 of the section comment). O(distinct nodes ×
 * rounds); rounds ≈ graph diameter, capped at MAX_REFINEMENT_ROUNDS.
 */
function computeStructuralHashes(root: unknown): Map<object, string> {
  // 1. Collect distinct nodes (iterative — the graph can be deep and cyclic).
  const nodes: object[] = [];
  const templates: NodeTemplate[] = [];
  const stack: object[] = [];
  const seen = new Set<object>();
  if (root !== null && typeof root === "object") {
    seen.add(root);
    stack.push(root);
  }
  while (stack.length > 0) {
    const node = stack.pop() as object;
    const template = buildTemplate(node, false);
    nodes.push(node);
    templates.push(template);
    for (const child of template.children) {
      if (!seen.has(child)) {
        seen.add(child);
        stack.push(child);
      }
    }
  }

  // 2. Round 0: local shape only, children as placeholders. Leaf nodes (no
  //    composite children) never change after this round, so only composite
  //    ("dynamic") nodes are re-hashed in the refinement loop.
  const hash = new Map<object, string>();
  const dynamic: number[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const t = templates[i] as NodeTemplate;
    const state = newHashState();
    mixString(state, t.statics[0] as string);
    for (let c = 0; c < t.children.length; c++) {
      mixString(state, "?");
      mixString(state, t.statics[c + 1] as string);
    }
    hash.set(nodes[i] as object, digest(state));
    if (t.children.length > 0) dynamic.push(i);
  }

  // 3. Refine to fixpoint. Each round mixes a node's own previous hash first,
  //    so the partition only ever splits — "distinct count stopped growing"
  //    is therefore a genuine fixpoint, not a coincidence of counts.
  let distinct = 0;
  {
    const initial = new Set<string>();
    for (const i of dynamic) initial.add(hash.get(nodes[i] as object) as string);
    distinct = initial.size;
  }
  for (let round = 0; round < MAX_REFINEMENT_ROUNDS && dynamic.length > 0; round++) {
    const next = new Map<object, string>();
    const classes = new Set<string>();
    for (const i of dynamic) {
      const node = nodes[i] as object;
      const t = templates[i] as NodeTemplate;
      const state = newHashState();
      mixString(state, hash.get(node) as string);
      mixString(state, t.statics[0] as string);
      for (let c = 0; c < t.children.length; c++) {
        mixString(state, hash.get(t.children[c] as object) as string);
        mixString(state, t.statics[c + 1] as string);
      }
      const h = digest(state);
      next.set(node, h);
      classes.add(h);
    }
    for (const [node, h] of next) hash.set(node, h);
    if (classes.size === distinct) break;
    distinct = classes.size;
  }

  // 4. Finishing pass — the MATCH hash: each node's own local shape minus its
  //    own top-level annotation keys, with its children's FULL refined hashes.
  //    Only the one field dereference rewrites per reference site (the top
  //    object's description) is forgiven; every deeper description still
  //    participates in identity via the children's full hashes.
  const match = new Map<object, string>();
  for (const node of nodes) {
    const t = buildTemplate(node, true);
    const state = newHashState();
    mixString(state, t.statics[0] as string);
    for (let c = 0; c < t.children.length; c++) {
      mixString(state, hash.get(t.children[c] as object) ?? "?");
      mixString(state, t.statics[c + 1] as string);
    }
    match.set(node, digest(state));
  }
  return match;
}

/** True when a value is an object/array with at least one object/array child. */
function isComposite(value: unknown): value is object {
  if (value === null || typeof value !== "object") return false;
  const children = Array.isArray(value) ? value : Object.values(value);
  return children.some((v) => v !== null && typeof v === "object");
}

function buildStructuralIndex(document: unknown, named: Record<string, unknown>): StructuralIndex {
  const compositeNames = Object.keys(named)
    .filter((name) => isComposite(named[name]))
    .sort();
  // The node hashes are computed even when there is nothing to index by name:
  // hoisting (see `hoistShared`) uses them to give synthesized components
  // content-derived names and to deduplicate CLONES of a hoisted structure,
  // and a document can need hoisting with no (composite) components at all.
  const nodeHash = computeStructuralHashes(document);
  if (compositeNames.length === 0) return { nodeHash, byHash: new Map() };
  const byHash = new Map<string, { canonical: string; names: Set<string> }>();
  for (const name of compositeNames) {
    const h = nodeHash.get(named[name] as object);
    if (h === undefined) continue; // defensive: body not reachable from the document root
    const entry = byHash.get(h);
    if (entry === undefined) byHash.set(h, { canonical: name, names: new Set([name]) });
    else entry.names.add(name);
  }
  // Alias policy (documented above): prefer the name matching the shared
  // body's own title, else the lexicographically smallest name. Identical
  // hash ⇒ identical structure ⇒ every aliased body carries the same title,
  // so reading it off any one candidate body is representative.
  for (const entry of byHash.values()) {
    if (entry.names.size === 1) continue;
    const sorted = [...entry.names].sort();
    const body = named[sorted[0] as string] as Record<string, unknown> | unknown[];
    const title = Array.isArray(body) ? undefined : body.title;
    entry.canonical =
      typeof title === "string" && entry.names.has(title) ? title : (sorted[0] as string);
  }
  return { nodeHash, byHash };
}

/** Invariant state threaded through one `bundleDocument` walk. */
interface WalkContext {
  maxDepth: number;
  truncatedAt: string[];
  depthLimitedAt: string[];
  resolved: Map<object, { depth: number; value: unknown }>;
  nameOf: Map<object, string>;
  structural: StructuralIndex;
  /** The document's real `components.schemas` (name-collision authority for hoists). */
  named: Record<string, unknown>;
  /** Components synthesized for large repeated anonymous structure. */
  synthesized: Record<string, unknown>;
  synthesizedAt: { name: string; path: string }[];
  /** Input node → its synthesized component name, once hoisted. */
  hoistedNames: Map<object, string>;
}

export function bundleDocument<T>(
  document: T,
  maxDepth = DEFAULT_MAX_SCHEMA_DEPTH,
): BundleResult<T> {
  const named = namedSchemasOf(document);
  // Object identity is NOT a reliable way to recognize "this is a reference to
  // named schema X": `@scalar/openapi-parser`'s `dereference()` clones a fresh
  // copy for every `$ref` occurrence rather than sharing one object per
  // target (verified against the real Stripe spec — even the simplest direct
  // `$ref` to a named schema is a distinct object every time). Kept as an
  // exact fast path (when the graph really does share a component's body
  // object, that IS the vendor's intended name — cycles force this sharing);
  // the authoritative signal for everything else is the structural canonical
  // hash built below, which never depends on vendor-supplied names or titles.
  const nameOf = new Map<object, string>();
  for (const [name, schema] of Object.entries(named)) {
    if (schema === null || typeof schema !== "object") continue;
    nameOf.set(schema, name);
  }
  const ctx: WalkContext = {
    maxDepth,
    truncatedAt: [],
    depthLimitedAt: [],
    resolved: new Map(),
    nameOf,
    structural: buildStructuralIndex(document, named),
    named,
    synthesized: {},
    synthesizedAt: [],
    hoistedNames: new Map(),
  };

  // Phase 1: process each named schema's own body exactly once. `definingName`
  // suppresses the $ref-collapse for this one top-level call only — its
  // children (including a reference back to itself) collapse normally.
  const bundledSchemas: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(named)) {
    if (schema === null || typeof schema !== "object") {
      bundledSchemas[name] = schema;
      continue;
    }
    bundledSchemas[name] = walk(
      schema,
      new Set(),
      `$.components.schemas.${name}`,
      0,
      true,
      ctx,
      name,
    );
  }

  // Phase 2: walk the rest of the document. Every occurrence of a named
  // schema anywhere (paths, parameters, other schemas already handled above)
  // collapses to a $ref — its real content is in `bundledSchemas`.
  const restWalked = walk(document, new Set(), "$", 0, false, ctx, undefined);

  // Synthesized components are real definitions too: their `$ref`s must
  // resolve through `components.schemas` exactly like vendor-named ones.
  Object.assign(bundledSchemas, ctx.synthesized);

  // Splice the real definitions back in: components.schemas must hold full
  // bodies, not a self-referential $ref to each of its own entries (which is
  // what phase 2 alone would produce, since it has no `definingName`).
  const out = restWalked as { components?: { schemas?: unknown } } | null;
  if (out !== null && typeof out === "object") {
    if (!out.components || typeof out.components !== "object") {
      // A document with no components container can still need one, when
      // hoisting synthesized a component out of repeated anonymous structure.
      if (Object.keys(bundledSchemas).length > 0) out.components = {};
    }
    if (out.components && typeof out.components === "object") {
      (out.components as Record<string, unknown>).schemas = bundledSchemas;
    }
  }
  return {
    document: out as T,
    truncatedAt: ctx.truncatedAt,
    depthLimitedAt: ctx.depthLimitedAt,
    synthesized: ctx.synthesizedAt,
  };
}

/**
 * Count object/array TREE positions (no dedupe — this is what
 * `JSON.stringify` pays), capped so probing a huge expansion stays O(cap).
 */
function treeSize(value: unknown, cap: number): number {
  let count = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const v = stack.pop();
    if (v === null || typeof v !== "object") continue;
    count++;
    if (count >= cap) return count;
    if (Array.isArray(v)) for (const c of v) stack.push(c);
    else for (const c of Object.values(v)) stack.push(c);
  }
  return count;
}

/** Deterministic, human-scannable name for a hoisted structure. */
function hoistName(node: object, path: string, ctx: WalkContext): string {
  const title = Array.isArray(node) ? undefined : (node as Record<string, unknown>).title;
  const raw =
    typeof title === "string" && title.length > 0
      ? title
      : (path.match(/([A-Za-z0-9_-]+)[^A-Za-z0-9_-]*$/)?.[1] ?? "schema");
  let base = raw.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "");
  if (base.length === 0) base = "schema";
  if (/^\d/.test(base)) base = `s${base}`;
  const hash8 = (ctx.structural.nodeHash.get(node) ?? "anon0000").slice(0, 8);
  let name = `${base}_${hash8}`;
  let n = 2;
  while (name in ctx.named || name in ctx.synthesized) name = `${base}_${hash8}_${n++}`;
  return name;
}

/**
 * Hoist a large, already-emitted expansion into a synthesized component so
 * every occurrence past the first becomes a `$ref` — the guarantee that the
 * output's TREE size (what serialization pays) stays proportional to unique
 * structure even for large repeated ANONYMOUS schemas that have no vendor
 * name to collapse to (GraphQL/Discovery adapter output is full of them).
 * The synthesized body is re-walked from depth 0 as a defining walk, so it
 * gets full fidelity rather than baking in whatever depth-truncation the
 * first emission position happened to impose.
 */
function hoistShared(node: object, path: string, ctx: WalkContext): string {
  const existing = ctx.hoistedNames.get(node);
  if (existing !== undefined) return existing;
  const name = hoistName(node, path, ctx);
  ctx.hoistedNames.set(node, name);
  ctx.synthesized[name] = {}; // reserve the key while the defining walk runs
  // Register structurally too, so clones of this structure (not just this
  // exact object) collapse to the same synthesized component.
  const hash = ctx.structural.nodeHash.get(node);
  if (hash !== undefined && !ctx.structural.byHash.has(hash)) {
    ctx.structural.byHash.set(hash, { canonical: name, names: new Set([name]) });
  }
  ctx.synthesizedAt.push({ name, path });
  ctx.synthesized[name] = walk(node, new Set(), `$.components.schemas.${name}`, 0, true, ctx, name);
  return name;
}

function walk(
  node: unknown,
  ancestors: Set<object>,
  path: string,
  depth: number,
  inSchema: boolean,
  ctx: WalkContext,
  definingName: string | undefined,
): unknown {
  if (node === null || typeof node !== "object") return node;
  const { nameOf, structural, resolved, maxDepth, truncatedAt, depthLimitedAt } = ctx;

  // Named-schema reference collapse — checked before anything else, so a
  // reference to a named schema NEVER gets inlined or re-walked, regardless
  // of how it was reached (paths, another named schema, a cycle back to
  // itself). This is what makes the whole pass O(unique named schemas): a
  // node identified as named is either "the one call site defining it"
  // (processed normally, once) or "a use of it" (an O(1) pointer, no
  // recursion at all). Identity first (exact — the graph literally shares
  // the component's body object), structural canonical hash second (the
  // authoritative, vendor-name-independent signal — dereference clones a
  // fresh copy per reference site, so identity rarely fires; see the
  // structural-identity section above). Structural collapse only applies
  // inside schema content (`inSchema`): a non-schema document node (a
  // response object, an example value) that happens to be shaped like a
  // component body must not become a schema $ref.
  let name = nameOf.get(node);
  if (name === undefined && inSchema) {
    const hash = structural.nodeHash.get(node);
    const entry = hash === undefined ? undefined : structural.byHash.get(hash);
    // A component's own defining walk must not collapse — neither to itself
    // nor to a structurally identical alias (which would hollow out its body
    // into a bare $ref); every alias keeps its own full definition.
    if (entry !== undefined && !(definingName !== undefined && entry.names.has(definingName))) {
      name = entry.canonical;
    }
  }
  if (name !== undefined && name !== definingName) {
    return { $ref: `#/components/schemas/${name}` };
  }

  if (ancestors.has(node)) {
    truncatedAt.push(path);
    return truncate(node as Record<string, unknown> | unknown[]);
  }
  const cached = resolved.get(node);
  if (cached !== undefined && inSchema) {
    // Already hoisted (this exact object) — every further occurrence is a pointer.
    const hoisted = ctx.hoistedNames.get(node);
    if (hoisted !== undefined && hoisted !== definingName) {
      return { $ref: `#/components/schemas/${hoisted}` };
    }
    // Hard law: never emit a LARGE already-emitted expansion at a second
    // tree position. The memo below returns the SAME output object for every
    // further occurrence — compact as a DAG in memory, but `JSON.stringify`
    // expands it into a full copy per position, which is exactly how
    // GitHub's 23,502-distinct-node bundle exploded past 10.5M tree
    // positions. Large repeats are hoisted into a synthesized component and
    // referenced; small stubs stay inline (cheaper than a $ref + definition).
    if (
      definingName === undefined &&
      treeSize(cached.value, HOIST_MIN_OUTPUT_NODES) >= HOIST_MIN_OUTPUT_NODES
    ) {
      return { $ref: `#/components/schemas/${hoistShared(node, path, ctx)}` };
    }
  }
  // A cached expansion is only reusable if it was resolved at a depth at
  // least as deep as this visit's budget allows (see bounds discussion in
  // the module doc) — recomputing from a deeper prior visit is always safe.
  if (cached !== undefined && cached.depth <= depth) return cached.value;
  // The depth bound caps *unnamed* schema-content nesting only — document/
  // path wrapper structure (`paths.<p>.<method>.requestBody...`) never
  // counts, and named-schema references never recurse at all (handled
  // above), so this now only ever triggers on genuinely deep anonymous
  // structure, which real specs rarely have without a name breaking it up.
  if (inSchema && depth >= maxDepth) {
    depthLimitedAt.push(path);
    return truncate(node as Record<string, unknown> | unknown[]);
  }

  // Prefer a vendor-declared *compact* shape over the fully expanded one:
  // Stripe (and specs following the same convention) marks an "expandable"
  // field with `x-expansionResources` alongside an `anyOf`/`oneOf` — the
  // field is a plain string ID by default at runtime, and only becomes the
  // nested object if the caller opts in via the API's own `expand[]`
  // parameter. Collapsing this reflects the API's real default response
  // shape; it is not a fallback for the bound above.
  const collapsed = collapseExpandable(node as Record<string, unknown>);
  const effective = collapsed ?? node;

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(node);

  let out: unknown;
  if (Array.isArray(effective)) {
    out = effective.map((v, i) =>
      walk(
        v,
        nextAncestors,
        `${path}[${i}]`,
        inSchema ? depth + 1 : depth,
        inSchema,
        ctx,
        undefined,
      ),
    );
  } else {
    // A schema starts at the `schema` key itself (parameters, request/
    // response bodies, headers) or each entry directly under a `schemas` map
    // — once `inSchema` flips true for a subtree it stays true for every
    // descendant, and depth starts counting from 0 there.
    const isSchemasContainer = /(^|\.)schemas$/.test(path);
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(effective as Record<string, unknown>)) {
      const entersSchema = k === "schema" || isSchemasContainer;
      const childInSchema = inSchema || entersSchema;
      const childDepth = entersSchema ? 0 : inSchema ? depth + 1 : depth;
      obj[k] = walk(v, nextAncestors, `${path}.${k}`, childDepth, childInSchema, ctx, undefined);
    }
    out = obj;
  }
  resolved.set(node, { depth, value: out });
  return out;
}

/**
 * Collapse a vendor-declared "expandable" field (`x-expansionResources`
 * alongside an `anyOf`/`oneOf`) to just its non-expansion alternative(s) —
 * conservatively: only when at least one alternative is clearly *not* one of
 * the declared expansion variants, and at least one *is*, so this never
 * touches a plain `anyOf`/`oneOf` that isn't this specific pattern.
 */
function collapseExpandable(node: Record<string, unknown>): Record<string, unknown> | undefined {
  const expansion = node["x-expansionResources"];
  if (expansion === null || typeof expansion !== "object") return undefined;
  const variants = new Set<unknown>([
    ...(Array.isArray((expansion as Record<string, unknown>).oneOf)
      ? ((expansion as Record<string, unknown>).oneOf as unknown[])
      : []),
    ...(Array.isArray((expansion as Record<string, unknown>).anyOf)
      ? ((expansion as Record<string, unknown>).anyOf as unknown[])
      : []),
  ]);
  if (variants.size === 0) return undefined;
  const key = Array.isArray(node.anyOf) ? "anyOf" : Array.isArray(node.oneOf) ? "oneOf" : undefined;
  if (!key) return undefined;
  const alternatives = node[key] as unknown[];
  const compact = alternatives.filter((alt) => !variants.has(alt));
  if (compact.length === 0 || compact.length === alternatives.length) return undefined;

  const { "x-expansionResources": _drop, anyOf: _a, oneOf: _o, ...rest } = node;
  const note =
    "the full expanded object is available via the API's expand parameter; " +
    "Anvil keeps the compact (actual runtime default) shape here";
  return {
    ...rest,
    ...(compact.length === 1 ? (compact[0] as object) : { [key]: compact }),
    description: typeof node.description === "string" ? `${node.description} (${note})` : note,
  };
}

/**
 * Replace a node truncated by cycle-breaking or the depth bound with a
 * shallow, safe stub — type-preserving. An array in, an array out: this walk
 * runs over the *whole* OpenAPI document, not just JSON Schema, so a
 * truncated node can just as easily be a plain array (e.g. OAuth scope
 * lists) as an object — collapsing an array into `{}` would silently turn a
 * `string[]` into an object downstream code still expects to `.map()` over.
 */
function truncate(node: Record<string, unknown> | unknown[]): Record<string, unknown> | unknown[] {
  if (Array.isArray(node)) return [];
  const stub: Record<string, unknown> = {};
  if (typeof node.type === "string") stub.type = node.type;
  const note = "nested reference truncated by Anvil to keep the schema JSON-safe and bounded";
  stub.description = typeof node.description === "string" ? `${node.description} (${note})` : note;
  return stub;
}

export interface MaterializeResult {
  schema: unknown;
  /** Named-schema chains cut off by the ref-depth bound (real cycles or very deep chains). */
  refDepthLimitedAt: string[];
  /** Document paths where expansion stopped because the node budget was hit (breadth blowup). */
  nodeBudgetLimitedAt: string[];
}

/** Shared mutable expansion budget threaded through one materialization walk. */
interface Budget {
  count: number;
  max: number;
  /** True once the budget is exhausted — further structure truncates to stubs. */
  spent: boolean;
}

/**
 * Resolve a (possibly `$ref`-bearing) schema — as produced by `bundleDocument`
 * — back into a small, fully self-contained, `$ref`-free schema, scoped to
 * one operation. Bounded on two independent axes, because a schema can be
 * pathological in either: `maxRefDepth` caps a *deep* named-schema chain, and
 * `maxNodes` caps a *broad* one (DocuSign's `tabs`/`accountSettingsInformation`
 * fan out to megabytes in a single hop). Once the node budget is spent every
 * further object/ref becomes a typed stub, so no single operation's schema can
 * blow up the AIR regardless of the source spec's shape.
 */
export function materializeSchema(
  schema: unknown,
  namedSchemas: Record<string, unknown>,
  maxRefDepth = DEFAULT_MAX_REF_DEPTH,
  maxNodes = DEFAULT_MAX_SCHEMA_NODES,
): MaterializeResult {
  const refDepthLimitedAt: string[] = [];
  const nodeBudgetLimitedAt: string[] = [];
  // Memoized by name, not just cycle-guarded by ancestor chain: an
  // operation's response commonly reaches the same named type from several
  // unrelated branches (e.g. a Stripe `charge` references `customer`
  // directly, and `invoice`, which *also* references `customer`) — without
  // this, each branch re-inlines that type's whole body independently, and
  // since each hop can itself fan out to further shared types, a handful of
  // operations each touching a dozen or so cross-referential named types
  // was enough to produce a 400MB+ document even though `bundleDocument`
  // (the whole-spec pass) had already deduplicated everything once.
  const resolved = new Map<string, { refDepth: number; value: unknown }>();
  const budget: Budget = { count: 0, max: maxNodes, spent: false };
  const result = resolveRefs(
    schema,
    namedSchemas,
    new Set(),
    0,
    maxRefDepth,
    "$",
    refDepthLimitedAt,
    nodeBudgetLimitedAt,
    resolved,
    budget,
  );
  return { schema: result, refDepthLimitedAt, nodeBudgetLimitedAt };
}

function resolveRefs(
  node: unknown,
  namedSchemas: Record<string, unknown>,
  ancestors: Set<string>,
  refDepth: number,
  maxRefDepth: number,
  path: string,
  refDepthLimitedAt: string[],
  nodeBudgetLimitedAt: string[],
  resolved: Map<string, { refDepth: number; value: unknown }>,
  budget: Budget,
): unknown {
  if (node === null || typeof node !== "object") return node;

  // Node budget: once spent, every further composite node collapses to a stub,
  // so a very *broad* schema (many properties, each a large object) can't blow
  // up the AIR even within the ref-depth bound. Scalars still pass through.
  if (budget.count >= budget.max) {
    if (!budget.spent) {
      budget.spent = true;
      nodeBudgetLimitedAt.push(path);
    }
    return truncate(node as Record<string, unknown> | unknown[]);
  }
  budget.count += 1;

  if (isRef(node)) {
    const name = refName(node);
    if (name === undefined || !(name in namedSchemas)) return node; // unresolvable — leave as-is, never silently drop
    const cached = resolved.get(name);
    if (cached !== undefined && cached.refDepth <= refDepth) return cached.value;
    if (ancestors.has(name) || refDepth >= maxRefDepth) {
      refDepthLimitedAt.push(path);
      const target = namedSchemas[name];
      const type =
        target !== null && typeof target === "object" && !Array.isArray(target)
          ? (target as Record<string, unknown>).type
          : undefined;
      const description = `A '${name}' object; nested one level deep to keep this schema a bounded size — see the '${name}' schema for its full fields.`;
      return truncate(typeof type === "string" ? { type, description } : { description });
    }
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(name);
    const value = resolveRefs(
      namedSchemas[name],
      namedSchemas,
      nextAncestors,
      refDepth + 1,
      maxRefDepth,
      `${path}(${name})`,
      refDepthLimitedAt,
      nodeBudgetLimitedAt,
      resolved,
      budget,
    );
    // Only memoize a fully-expanded value: one truncated by an exhausted budget
    // is not the type's real body and must not be served to another reference.
    if (!budget.spent) resolved.set(name, { refDepth, value });
    return value;
  }

  if (Array.isArray(node)) {
    return node.map((v, i) =>
      resolveRefs(
        v,
        namedSchemas,
        ancestors,
        refDepth,
        maxRefDepth,
        `${path}[${i}]`,
        refDepthLimitedAt,
        nodeBudgetLimitedAt,
        resolved,
        budget,
      ),
    );
  }
  const obj: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    obj[k] = resolveRefs(
      v,
      namedSchemas,
      ancestors,
      refDepth,
      maxRefDepth,
      `${path}.${k}`,
      refDepthLimitedAt,
      nodeBudgetLimitedAt,
      resolved,
      budget,
    );
  }
  return obj;
}
