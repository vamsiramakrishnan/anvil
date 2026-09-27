/**
 * Exposure profiles: a reviewed, declarative choice of which operations of a
 * full source contract become the exposed surface.
 *
 * A vendor spec declares far more than one agent should see (Jira's platform
 * API has 619 operations, Microsoft Graph's v1.0 has 17,870). A profile names
 * the subset by source operationId, tag, path glob, and method, and says what
 * happens to the rest: `skip` leaves them out of the AIR (and prunes every
 * schema only they reach, so nothing unreachable is materialized), `compile`
 * keeps them in the AIR but never approvable. The source snapshot stays the
 * contract of record; the profile's digest and the source digest are recorded
 * in `service.source.profile`.
 *
 * A profile may also carry a declarative approval: a named reviewer and a
 * reason approving some or all of the exposed operations at compile time. It
 * goes through the same channel as a manifest `state: approved` entry, so
 * every gate a manifest approval meets applies.
 *
 *   profile: jira-issues
 *   source:
 *     digest: sha256:0fc9…            # optional pin to the snapshot's sourceHash
 *   select:                          # or: select: all
 *     - operation_id: [getIssue, createIssue]
 *     - tag: Issue search
 *     - path: /rest/api/3/issue/{issueIdOrKey}/comment
 *       method: [get, post]
 *   exclude:
 *     - method: delete
 *   unexposed: skip                  # or: compile
 *   schema_bounds:
 *     max_ref_depth: 2
 *   approve:
 *     reviewed_by: alice@example.com
 *     reason: Read operations reviewed against the vendor docs.
 *     select:
 *       - method: get
 */
import { createHash } from "node:crypto";
import { type ExposureProfileRecord, HttpMethod, hashCanonical, type Operation } from "@anvil/air";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { OpenApiDocument } from "./parse.js";
import type { SchemaBounds } from "./schema-bounds.js";
import { parseSourceText } from "./source/detect.js";

const oneOrMany = <T extends z.ZodType>(item: T) =>
  z.union([item, z.array(item).min(1)]).transform((v) => (Array.isArray(v) ? v : [v]));

/**
 * One selector. Every key it sets must match (AND); a key given a list matches
 * any entry (OR). `operation_id` and `tag` accept `*` wildcards. `path` is a
 * glob over the source path: `*` matches within one segment, `**` matches any
 * number of segments.
 */
export const ProfileSelector = z
  .strictObject({
    operation_id: oneOrMany(z.string().min(1)).optional(),
    tag: oneOrMany(z.string().min(1)).optional(),
    path: oneOrMany(z.string().min(1)).optional(),
    method: oneOrMany(
      z
        .string()
        .transform((m) => m.toLowerCase())
        .pipe(HttpMethod),
    ).optional(),
  })
  .refine(
    (s) =>
      s.operation_id !== undefined ||
      s.tag !== undefined ||
      s.path !== undefined ||
      s.method !== undefined,
    "a selector needs at least one of operation_id, tag, path, method",
  );
export type ProfileSelector = z.infer<typeof ProfileSelector>;

const Selection = z.union([z.literal("all"), z.array(ProfileSelector).min(1)]);

/**
 * Bounds a profile compile materializes schemas under. These defaults apply to
 * every profile compile; a compile without a profile keeps the historical
 * whole-source defaults (one ref hop, a 4,000-node expansion budget, no
 * inheritance rule), so existing bundles do not move.
 *
 * Each schema gets the deepest depth up to three hops whose materialized tree
 * fits in 2,000 nodes, with `allOf` inheritance free. Measured on Microsoft
 * Graph: `GET /users` materializes the collection envelope and each `user`
 * with its inherited `directoryObject` and `entity` fields (two hops, about
 * 450 nodes), while `GET /users/{user-id}` stays at one hop, because two hops
 * would expand all of a user's navigation properties (about 2,800 nodes).
 */
export const PROFILE_DEFAULT_SCHEMA_BOUNDS: SchemaBounds = {
  maxRefDepth: 3,
  maxSchemaNodes: 2_000,
  inheritAllOf: true,
  fitToBudget: true,
};

export const ExposureProfile = z.strictObject({
  /** The profile's id: a lowercase slug. */
  profile: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/, "profile id must be a lowercase slug"),
  description: z.string().optional(),
  source: z
    .strictObject({
      /**
       * Where the reviewed contract is published. Provenance only: a compile
       * never fetches it, and a URL alone pins nothing, so it needs `sha256`
       * or `digest` beside it.
       */
      url: z
        .string()
        .url()
        .regex(/^https:\/\//, "url must be https")
        .optional(),
      /**
       * sha256 of the entrypoint file's bytes (what `sha256sum` prints on the
       * downloaded file), so the pin holds whatever the file is named.
       */
      sha256: z
        .string()
        .regex(/^sha256:[0-9a-f]{64}$/, "sha256 must be sha256:<64 hex>")
        .optional(),
      /**
       * sha256 of the entrypoint's parsed document as canonical JSON (keys
       * sorted, no whitespace), for a publisher whose bytes vary between
       * downloads while the document does not (Google Discovery reorders its
       * keys on every response). A refusal prints the value to pin.
       */
      content_sha256: z
        .string()
        .regex(/^sha256:[0-9a-f]{64}$/, "content_sha256 must be sha256:<64 hex>")
        .optional(),
      /** The snapshot `sourceHash` this profile was reviewed against. */
      digest: z
        .string()
        .regex(/^sha256:[0-9a-f]{64}$/, "digest must be sha256:<64 hex>")
        .optional(),
    })
    .refine(
      (s) => s.sha256 !== undefined || s.content_sha256 !== undefined || s.digest !== undefined,
      "source needs sha256, content_sha256, or digest to pin the contract (a url alone pins nothing)",
    )
    .optional(),
  select: Selection,
  exclude: z.array(ProfileSelector).default([]),
  unexposed: z.enum(["skip", "compile"]).default("skip"),
  schema_bounds: z
    .strictObject({
      max_ref_depth: z.number().int().min(1).max(8).optional(),
      max_schema_nodes: z.number().int().min(100).max(1_000_000).optional(),
      inherit_all_of: z.boolean().optional(),
    })
    .optional(),
  approve: z
    .strictObject({
      reviewed_by: z.string().trim().min(1),
      reason: z.string().trim().min(1),
      /** Which exposed operations the approval covers; `all` by default. */
      select: Selection.default("all"),
      exclude: z.array(ProfileSelector).default([]),
    })
    .optional(),
});
export type ExposureProfile = z.infer<typeof ExposureProfile>;

/** The profile's JSON Schema, derived from the zod schema that parses it. */
export function profileJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(ExposureProfile, {
    target: "draft-2020-12",
    unrepresentable: "any",
    io: "input",
  }) as Record<string, unknown>;
  return {
    title: "Anvil exposure profile",
    description:
      "Which operations of a full source contract are the exposed surface (`anvil compile --profile`): selectors by source operationId, tag, path glob, and method; what happens to the rest; schema materialization bounds; and an optional declarative approval. Keys are strict.",
    ...schema,
  };
}

export type ProfileParseResult =
  | { ok: true; profile: ExposureProfile; digest: string }
  | { ok: false; issues: string[] };

/** Parse and validate profile YAML (or JSON). Every problem comes back as one line. */
export function parseExposureProfile(text: string): ProfileParseResult {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    return { ok: false, issues: [err instanceof Error ? err.message : String(err)] };
  }
  const parsed = ExposureProfile.safeParse(raw ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`,
      ),
    };
  }
  return { ok: true, profile: parsed.data, digest: profileDigest(parsed.data) };
}

/** sha256 over the parsed profile's canonical JSON: formatting never changes it. */
export function profileDigest(profile: ExposureProfile): string {
  return `sha256:${hashCanonical(profile)}`;
}

export function profileSchemaBounds(profile: ExposureProfile): SchemaBounds {
  const b = profile.schema_bounds;
  return {
    maxRefDepth: b?.max_ref_depth ?? PROFILE_DEFAULT_SCHEMA_BOUNDS.maxRefDepth,
    maxSchemaNodes: b?.max_schema_nodes ?? PROFILE_DEFAULT_SCHEMA_BOUNDS.maxSchemaNodes,
    inheritAllOf: b?.inherit_all_of ?? PROFILE_DEFAULT_SCHEMA_BOUNDS.inheritAllOf,
    fitToBudget: true,
  };
}

/** What a selector sees of one operation: the source's own identifiers. */
export interface SelectableOperation {
  path: string;
  method: string;
  operationId?: string;
  tags: readonly string[];
}

const globCache = new Map<string, RegExp>();

/** `*` within a segment, `**` across segments; everything else literal. */
function pathGlob(glob: string): RegExp {
  const key = `p:${glob}`;
  const hit = globCache.get(key);
  if (hit) return hit;
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] as string;
    if (ch === "*" && glob[i + 1] === "*") {
      // `/**` also matches the bare prefix: `/issue/**` matches `/issue`.
      if (out.endsWith("/")) out = `${out.slice(0, -1)}(?:/.*)?`;
      else out += ".*";
      i++;
    } else if (ch === "*") out += "[^/]*";
    else out += ch.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  const re = new RegExp(`^${out}$`);
  globCache.set(key, re);
  return re;
}

/** `*` matches any run of characters. */
function wildcard(pattern: string): RegExp {
  const key = `w:${pattern}`;
  const hit = globCache.get(key);
  if (hit) return hit;
  const re = new RegExp(
    `^${pattern
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  );
  globCache.set(key, re);
  return re;
}

function selectorMatches(selector: ProfileSelector, op: SelectableOperation): boolean {
  if (selector.method && !selector.method.includes(op.method.toLowerCase() as HttpMethod)) {
    return false;
  }
  if (selector.path && !selector.path.some((glob) => pathGlob(glob).test(op.path))) return false;
  if (selector.operation_id) {
    const id = op.operationId;
    if (id === undefined || !selector.operation_id.some((p) => wildcard(p).test(id))) return false;
  }
  if (selector.tag && !selector.tag.some((p) => op.tags.some((t) => wildcard(p).test(t)))) {
    return false;
  }
  return true;
}

function selectionMatches(
  select: "all" | readonly ProfileSelector[],
  exclude: readonly ProfileSelector[],
  op: SelectableOperation,
): boolean {
  const included = select === "all" || select.some((s) => selectorMatches(s, op));
  return included && !exclude.some((s) => selectorMatches(s, op));
}

/** Whether a source operation is in the profile's exposed surface. */
export function profileSelects(profile: ExposureProfile, op: SelectableOperation): boolean {
  return selectionMatches(profile.select, profile.exclude, op);
}

/** Whether an exposed operation is covered by the profile's declarative approval. */
export function profileApproves(profile: ExposureProfile, op: SelectableOperation): boolean {
  if (!profile.approve || !profileSelects(profile, op)) return false;
  return selectionMatches(profile.approve.select, profile.approve.exclude, op);
}

/** The selector view of a compiled operation. */
export function selectableOf(op: Operation): SelectableOperation {
  return {
    path: op.sourceRef.path ?? "",
    method: op.sourceRef.method ?? "",
    ...(op.sourceRef.operationId ? { operationId: op.sourceRef.operationId } : {}),
    tags: op.tags,
  };
}

const PATH_ITEM_METHODS = HttpMethod.options;

/**
 * The components sections pruned to what the kept operations reach. Security
 * schemes are kept whole: they are referenced by name, not by `$ref`.
 */
const PRUNABLE_SECTIONS = [
  "schemas",
  "responses",
  "parameters",
  "requestBodies",
  "headers",
  "examples",
  "links",
  "callbacks",
  "pathItems",
];

export interface ProfileSelectionResult {
  /** The document with unselected operations and unreachable components removed. */
  document: OpenApiDocument;
  /** Operations the whole source declared, before selection. */
  sourceOperations: number;
  /** Operations the selection kept. */
  selectedOperations: number;
}

/**
 * Apply `unexposed: skip` to a pre-dereference OpenAPI 3 document: drop every
 * unselected operation, then every component only a dropped operation
 * reached. This runs before `$ref` dereferencing, so the pipeline never
 * dereferences, hashes, or materializes a schema no exposed operation uses.
 *
 * A path item that is itself a `$ref` cannot be judged before resolution and
 * is kept; the operation-level filter after normalization is the authority.
 */
export function selectDocument(
  document: OpenApiDocument,
  profile: ExposureProfile,
): ProfileSelectionResult {
  let sourceOperations = 0;
  let selectedOperations = 0;
  const keepItems = (
    items: Record<string, Record<string, unknown>> | undefined,
    pathOf: (key: string) => string,
  ): Record<string, Record<string, unknown>> | undefined => {
    if (!items || typeof items !== "object") return items;
    const out: Record<string, Record<string, unknown>> = {};
    for (const [key, item] of Object.entries(items)) {
      if (!item || typeof item !== "object") continue;
      if (typeof item.$ref === "string") {
        out[key] = item;
        continue;
      }
      const kept: Record<string, unknown> = {};
      let methods = 0;
      for (const [field, value] of Object.entries(item)) {
        if (!(PATH_ITEM_METHODS as readonly string[]).includes(field)) {
          kept[field] = value;
          continue;
        }
        sourceOperations++;
        const raw = (value ?? {}) as { operationId?: unknown; tags?: unknown };
        const selected = profileSelects(profile, {
          path: pathOf(key),
          method: field,
          ...(typeof raw.operationId === "string" ? { operationId: raw.operationId } : {}),
          tags: Array.isArray(raw.tags) ? raw.tags.filter((t) => typeof t === "string") : [],
        });
        if (!selected) continue;
        selectedOperations++;
        methods++;
        kept[field] = value;
      }
      if (methods > 0) out[key] = kept;
    }
    return out;
  };

  const next: OpenApiDocument = { ...document };
  next.paths = keepItems(document.paths, (key) => key) ?? {};
  if (document.webhooks) next.webhooks = keepItems(document.webhooks, (key) => `/webhooks/${key}`);
  pruneComponents(next);
  return { document: next, sourceOperations, selectedOperations };
}

/** Count the operations a document declares, for the `unexposed: compile` record. */
export function countDocumentOperations(document: OpenApiDocument): number {
  let count = 0;
  for (const items of [document.paths, document.webhooks]) {
    if (!items || typeof items !== "object") continue;
    for (const item of Object.values(items)) {
      if (!item || typeof item !== "object") continue;
      for (const method of PATH_ITEM_METHODS) if (item[method]) count++;
    }
  }
  return count;
}

/** Decode one JSON-pointer token. */
const unescapeToken = (token: string): string => token.replace(/~1/g, "/").replace(/~0/g, "~");

/**
 * Keep only components reachable by internal `$ref` from the rest of the
 * document. A `$ref` into `#/paths/...` keeps nothing extra: the referenced
 * path item is already in the document or was deliberately dropped, and the
 * dereference step reports a dangling pointer rather than guessing.
 */
function pruneComponents(document: OpenApiDocument): void {
  const components = document.components as Record<string, unknown> | undefined;
  if (!components || typeof components !== "object") return;
  const sections = new Map<string, Record<string, unknown>>();
  for (const name of PRUNABLE_SECTIONS) {
    const section = components[name];
    if (section && typeof section === "object")
      sections.set(name, section as Record<string, unknown>);
  }
  if (sections.size === 0) return;

  const reached = new Map<string, Set<string>>();
  const queue: unknown[] = [];
  const visit = (ref: string): void => {
    if (!ref.startsWith("#/components/")) return;
    const [section, name] = ref.slice("#/components/".length).split("/");
    if (section === undefined || name === undefined) return;
    const body = sections.get(section);
    if (!body) return;
    const key = unescapeToken(name);
    let set = reached.get(section);
    if (!set) {
      set = new Set();
      reached.set(section, set);
    }
    if (set.has(key) || !(key in body)) return;
    set.add(key);
    queue.push(body[key]);
  };

  // Everything outside the prunable sections is a root.
  for (const [key, value] of Object.entries(document)) {
    if (key !== "components") queue.push(value);
  }
  for (const [key, value] of Object.entries(components)) {
    if (!sections.has(key)) queue.push(value);
  }
  const seen = new Set<object>();
  while (queue.length > 0) {
    const node = queue.pop();
    if (node === null || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const child of node) queue.push(child);
      continue;
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === "$ref" && typeof child === "string") visit(child);
      else queue.push(child);
    }
  }

  const next: Record<string, unknown> = { ...components };
  for (const [name, body] of sections) {
    const keep = reached.get(name) ?? new Set<string>();
    const pruned: Record<string, unknown> = {};
    for (const key of Object.keys(body)) if (keep.has(key)) pruned[key] = body[key];
    next[name] = pruned;
  }
  document.components = next as OpenApiDocument["components"];
}

/**
 * The AIR record of a compile under a profile. `exposed` is computed from the
 * compiled operations, not the document, so an operation reached through a
 * `$ref` path item is judged by what it resolved to.
 */
/**
 * Refuse a snapshot other than the one the profile was reviewed against: by
 * the snapshot's `sourceHash` (`source.digest`), and by the sha256 of its
 * entrypoint file's bytes (`source.sha256`).
 */
export function assertProfileSource(
  profile: ExposureProfile | undefined,
  source: { sourceHash: string; entrypointPath: string; entrypointBytes: Uint8Array | undefined },
): void {
  const pin = profile?.source;
  if (!profile || !pin) return;
  const review = (key: string) =>
    `Review the profile against this source and update source.${key}` +
    (pin.url ? `, or fetch ${pin.url} again.` : ".");
  if (pin.digest !== undefined && pin.digest !== source.sourceHash) {
    throw new Error(
      `Exposure profile '${profile.profile}' is pinned to source ${pin.digest}, but the snapshot being compiled is ${source.sourceHash}. ${review("digest")}`,
    );
  }
  const bytes = source.entrypointBytes;
  if (pin.sha256 !== undefined) {
    const actual = bytes
      ? `sha256:${createHash("sha256").update(bytes).digest("hex")}`
      : "unreadable";
    if (actual !== pin.sha256) {
      throw new Error(
        `Exposure profile '${profile.profile}' is pinned to a contract file with ${pin.sha256}, but ${source.entrypointPath} is ${actual}. ${review("sha256")}`,
      );
    }
  }
  if (pin.content_sha256 !== undefined) {
    const doc = bytes ? parseSourceText(new TextDecoder().decode(bytes)).doc : undefined;
    const actual = doc === undefined ? "unparseable" : `sha256:${hashCanonical(doc)}`;
    if (actual !== pin.content_sha256) {
      throw new Error(
        `Exposure profile '${profile.profile}' is pinned to a contract document with content ${pin.content_sha256}, but ${source.entrypointPath} has content ${actual}. ${review("content_sha256")}`,
      );
    }
  }
}

export function profileRecord(
  profile: ExposureProfile,
  digest: string,
  input: {
    sourceHash?: string;
    sourceOperations: number;
    exposed: readonly string[];
    approved: readonly string[];
    bounds: SchemaBounds;
  },
): ExposureProfileRecord {
  return {
    id: profile.profile,
    digest,
    ...(input.sourceHash ? { sourceHash: input.sourceHash } : {}),
    ...(profile.source?.url || profile.source?.sha256 || profile.source?.content_sha256
      ? {
          source: {
            ...(profile.source.url ? { url: profile.source.url } : {}),
            ...(profile.source.sha256 ? { sha256: profile.source.sha256 } : {}),
            ...(profile.source.content_sha256
              ? { contentSha256: profile.source.content_sha256 }
              : {}),
          },
        }
      : {}),
    unexposed: profile.unexposed,
    sourceOperations: input.sourceOperations,
    exposedOperations: [...input.exposed].sort(),
    schemaBounds: { ...input.bounds },
    ...(profile.approve
      ? {
          approval: {
            reviewedBy: profile.approve.reviewed_by,
            reason: profile.approve.reason,
            operations: [...input.approved].sort(),
          },
        }
      : {}),
  };
}
