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

type Ref = { $ref: string };
const isRef = (v: unknown): v is Ref =>
  typeof v === "object" && v !== null && typeof (v as Record<string, unknown>).$ref === "string";
const refName = (ref: Ref): string | undefined => ref.$ref.match(/^#\/components\/schemas\/(.+)$/)?.[1];

/** Collect `components.schemas` from a parsed OpenAPI document, defensively. */
function namedSchemasOf(document: unknown): Record<string, unknown> {
  const doc = document as { components?: { schemas?: Record<string, unknown> } } | undefined;
  return doc?.components?.schemas ?? {};
}

export function bundleDocument<T>(document: T, maxDepth = DEFAULT_MAX_SCHEMA_DEPTH): BundleResult<T> {
  const named = namedSchemasOf(document);
  // Object identity is NOT a reliable way to recognize "this is a reference to
  // named schema X": `@scalar/openapi-parser`'s `dereference()` clones a fresh
  // copy for every `$ref` occurrence rather than sharing one object per
  // target (verified against the real Stripe spec — even the simplest direct
  // `$ref` to a named schema is a distinct object every time). Kept as a
  // fast-path fallback (harmless — it just means one less title lookup on the
  // rare source where identity *is* preserved), but the real signal is each
  // schema's own `title`, which OpenAPI tooling (and Stripe's spec
  // specifically, verified) sets to the type's name wherever it's used —
  // `Customer`, `BalanceTransaction`, etc. — regardless of which cloned copy
  // you're looking at.
  const nameOf = new Map<object, string>();
  const titleToName = new Map<string, string>();
  const ambiguousTitles = new Set<string>();
  for (const [name, schema] of Object.entries(named)) {
    if (schema === null || typeof schema !== "object") continue;
    nameOf.set(schema, name);
    const title = (schema as Record<string, unknown>).title;
    if (typeof title !== "string" || title.length === 0) continue;
    const existing = titleToName.get(title);
    if (existing !== undefined && existing !== name) ambiguousTitles.add(title);
    else titleToName.set(title, name);
  }
  for (const title of ambiguousTitles) titleToName.delete(title);

  const truncatedAt: string[] = [];
  const depthLimitedAt: string[] = [];
  const resolved = new Map<object, { depth: number; value: unknown }>();

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
      maxDepth,
      truncatedAt,
      depthLimitedAt,
      resolved,
      nameOf,
      titleToName,
      name,
    );
  }

  // Phase 2: walk the rest of the document. Every occurrence of a named
  // schema anywhere (paths, parameters, other schemas already handled above)
  // collapses to a $ref — its real content is in `bundledSchemas`.
  const restWalked = walk(
    document,
    new Set(),
    "$",
    0,
    false,
    maxDepth,
    truncatedAt,
    depthLimitedAt,
    resolved,
    nameOf,
    titleToName,
    undefined,
  );

  // Splice the real definitions back in: components.schemas must hold full
  // bodies, not a self-referential $ref to each of its own entries (which is
  // what phase 2 alone would produce, since it has no `definingName`).
  const out = restWalked as { components?: { schemas?: unknown } } | null;
  if (out !== null && typeof out === "object" && out.components && typeof out.components === "object") {
    (out.components as Record<string, unknown>).schemas = bundledSchemas;
  }
  return { document: out as T, truncatedAt, depthLimitedAt };
}

function walk(
  node: unknown,
  ancestors: Set<object>,
  path: string,
  depth: number,
  inSchema: boolean,
  maxDepth: number,
  truncatedAt: string[],
  depthLimitedAt: string[],
  resolved: Map<object, { depth: number; value: unknown }>,
  nameOf: Map<object, string>,
  titleToName: Map<string, string>,
  definingName: string | undefined,
): unknown {
  if (node === null || typeof node !== "object") return node;

  // Named-schema reference collapse — checked before anything else, so a
  // reference to a named schema NEVER gets inlined or re-walked, regardless
  // of how it was reached (paths, another named schema, a cycle back to
  // itself). This is what makes the whole pass O(unique named schemas): a
  // node identified as named is either "the one call site defining it"
  // (processed normally, once) or "a use of it" (an O(1) pointer, no
  // recursion at all). Identity first (cheap, and correct on the rare source
  // that preserves it), title second (the reliable signal — see the note on
  // `titleToName` above).
  const title = !Array.isArray(node) ? (node as Record<string, unknown>).title : undefined;
  const name = nameOf.get(node) ?? (typeof title === "string" ? titleToName.get(title) : undefined);
  if (name !== undefined && name !== definingName) {
    return { $ref: `#/components/schemas/${name}` };
  }

  if (ancestors.has(node)) {
    truncatedAt.push(path);
    return truncate(node as Record<string, unknown> | unknown[]);
  }
  const cached = resolved.get(node);
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
        maxDepth,
        truncatedAt,
        depthLimitedAt,
        resolved,
        nameOf,
        titleToName,
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
      obj[k] = walk(
        v,
        nextAncestors,
        `${path}.${k}`,
        childDepth,
        childInSchema,
        maxDepth,
        truncatedAt,
        depthLimitedAt,
        resolved,
        nameOf,
        titleToName,
        undefined,
      );
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
}

/**
 * Resolve a (possibly `$ref`-bearing) schema — as produced by `bundleDocument`
 * — back into a small, fully self-contained, `$ref`-free schema, scoped to
 * one operation. Bounded by how many *named-schema* hops it follows
 * (`maxRefDepth`), not by total node count: each hop inlines one already-
 * bundled (and already depth-bounded) schema body, so this stays cheap
 * regardless of how densely the source spec's types cross-reference each
 * other — the expensive part already happened once, in `bundleDocument`.
 */
export function materializeSchema(
  schema: unknown,
  namedSchemas: Record<string, unknown>,
  maxRefDepth = DEFAULT_MAX_REF_DEPTH,
): MaterializeResult {
  const refDepthLimitedAt: string[] = [];
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
  const result = resolveRefs(schema, namedSchemas, new Set(), 0, maxRefDepth, "$", refDepthLimitedAt, resolved);
  return { schema: result, refDepthLimitedAt };
}

function resolveRefs(
  node: unknown,
  namedSchemas: Record<string, unknown>,
  ancestors: Set<string>,
  refDepth: number,
  maxRefDepth: number,
  path: string,
  refDepthLimitedAt: string[],
  resolved: Map<string, { refDepth: number; value: unknown }>,
): unknown {
  if (node === null || typeof node !== "object") return node;

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
      resolved,
    );
    resolved.set(name, { refDepth, value });
    return value;
  }

  if (Array.isArray(node)) {
    return node.map((v, i) =>
      resolveRefs(v, namedSchemas, ancestors, refDepth, maxRefDepth, `${path}[${i}]`, refDepthLimitedAt, resolved),
    );
  }
  const obj: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    obj[k] = resolveRefs(v, namedSchemas, ancestors, refDepth, maxRefDepth, `${path}.${k}`, refDepthLimitedAt, resolved);
  }
  return obj;
}
