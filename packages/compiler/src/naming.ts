import type { Diagnostic, HttpMethod, Operation } from "@anvil/air";
import { snakeCase } from "@anvil/air";
import { actionVerbFor, isReadIntentWriteMethod } from "./classify.js";

/**
 * The naming pass. Operation names are the agent-facing surface — a CLI that
 * "smells generated" is one an agent second-guesses. Naming therefore is a
 * first-class pass, not an inline heuristic: it derives names *with a confidence
 * and the signals behind it*, resolves collisions deterministically across all
 * three surfaces (id / CLI command / MCP tool) instead of silently suffixing
 * `_2`, and critiques agent-hostile names into reviewable diagnostics.
 */

const VAGUE_ACTIONS = new Set([
  "do",
  "run",
  "exec",
  "execute",
  "process",
  "handle",
  "call",
  "post",
]);

export interface DerivedNames {
  id: string;
  canonicalName: string;
  displayName: string;
  cliCommand: string;
  toolName: string;
  resource: string;
  action: string;
  /** 0..1 confidence that these names are agent-friendly and stable. */
  confidence: number;
  /** Human-readable reasons behind the confidence (for review). */
  signals: string[];
}

export const singularize = (s: string): string => {
  if (/ies$/.test(s)) return s.replace(/ies$/, "y");
  if (/ses$/.test(s)) return s.replace(/ses$/, "s");
  if (/s$/.test(s) && !/ss$/.test(s)) return s.replace(/s$/, "");
  return s;
};

/** An API-version path segment: `v1`, `v60`, `v60.0`, `2.0`. Never a resource. */
function isVersionLike(segment: string): boolean {
  return /^v?\d+(\.\d+)*$/i.test(segment);
}

/**
 * OData addresses a single entity with a key predicate in the SAME segment —
 * `A_BusinessPartner('0001')` or `Address(Partner='1',ID='2')` — where REST
 * would use a separate `/{id}` segment. The predicate is the identity, not part
 * of the resource name, and its presence means the segment addresses one item
 * (so the action is get/update/delete, never list). Returns the bare resource
 * name and whether a key predicate was present.
 */
function stripODataKey(segment: string): { resource: string; keyed: boolean } {
  const match = /^([A-Za-z_]\w*)\(.*\)$/.exec(segment);
  return match
    ? { resource: match[1] as string, keyed: true }
    : { resource: segment, keyed: false };
}

export function actionFor(method: HttpMethod, endsWithParam: boolean): string {
  switch (method) {
    case "get":
    case "head":
      return endsWithParam ? "get" : "list";
    case "post":
      return "create";
    case "put":
      return "replace";
    case "patch":
      return "update";
    case "delete":
      return "delete";
    default:
      return method;
  }
}

// A REST format-selector suffix on a path segment (Twilio's `.json`, some
// APIs' `.xml`) is not part of the resource name — it selects a wire format.
// It must not leak into the agent-facing resource/CLI/tool names, and leaving
// it in also makes the *same* resource render two ways depending on whether a
// given operation's path carries the suffix (Twilio `Messages.json` for
// list/create vs `Messages` for fetch/delete, whose suffix sits on the id
// segment). Only the derived NAME is cleaned; the wire path (`sourceRef.path`)
// the runtime calls is untouched.
const FORMAT_SUFFIX = /\.(json|xml|csv|ya?ml|txt|html?|proto)$/i;

/**
 * The true action verb from an operationId when the HTTP method genuinely
 * can't express it: a POST reused for update/delete (Twilio's `UpdateMessage`,
 * `DeleteX` are all `POST`, since Twilio — like several REST APIs — reuses
 * POST for mutation-that-isn't-create). Scoped deliberately to POST and to
 * update/delete only: POST already defaults to "create", and this is exactly
 * the ambiguity the method drops. It does NOT trust a leading verb in general
 * — Stripe's `GetCustomers` is really a *list*, so honoring "get" there would
 * be worse than the method+path inference — so only these two method-defeating
 * cases are overridden, keeping the CLI action aligned with the
 * operationId-derived tool name (`twilio_update_message`, not a `_post`
 * disambiguation suffix) and preventing the create/update collision.
 */
function postVerbFromOperationId(operationId: string | undefined): string | undefined {
  if (!operationId) return undefined;
  const s = snakeCase(operationId);
  if (/^(update|edit|modify|patch)(_|$)/.test(s)) return "update";
  if (/^(delete|remove|destroy)(_|$)/.test(s)) return "delete";
  return undefined;
}

/**
 * The action for a PATCH/PUT whose operationId names an *upsert* — the
 * idempotent create-or-update by an external key (Salesforce's
 * `upsertAccountByExternalId`, many OData/REST APIs). The HTTP method collapses
 * it to "update", so a plain `updateX` and an `upsertX` on the same resource
 * would collide onto one command and disambiguate with a meaningless `_patch`
 * suffix. Honouring the operationId verb keeps them distinct and truthful
 * (`account update` vs `account upsert`). Scoped to the one verb the method
 * genuinely drops, mirroring `postVerbFromOperationId`.
 */
function upsertVerbFromOperationId(operationId: string | undefined): string | undefined {
  if (!operationId) return undefined;
  return /^upsert(_|$)/.test(snakeCase(operationId)) ? "upsert" : undefined;
}

/**
 * Decompose a concrete path segment into a resource token and, when the
 * segment is an RPC-style dotted method (Slack's `chat.postMessage`,
 * `users.profile.set`), the method name that should drive the action. A plain
 * REST segment (no dot after stripping any format suffix) yields the segment
 * itself as the resource and no rpc action.
 *
 * This is the general form of the same principle behind the verb-trailing-
 * segment handling below: the agent-facing name must reflect what the
 * operation *is*, not the literal shape of one URL segment — and it keeps the
 * CLI command aligned with the operationId-derived MCP tool name (Slack's
 * `chat.postMessage` → CLI `slack chat post_message`, tool
 * `slack_chat_post_message`) instead of drifting to `chat.postMessage send`.
 */
function decomposeSegment(segment: string): { resource: string; rpcAction?: string } {
  const noSuffix = segment.replace(FORMAT_SUFFIX, "");
  // A dotted API-version segment (`v60.0`, `2.0`) is not an RPC dotted method —
  // splitting it would make the version ("v60") the resource and its minor
  // ("0") the action. It is not a resource at all; return it whole so the
  // caller's version guard can skip it.
  if (isVersionLike(noSuffix)) return { resource: noSuffix };
  if (noSuffix.includes(".")) {
    const parts = noSuffix.split(".").filter(Boolean);
    if (parts.length >= 2) {
      // Last component is the method (drives the action); EVERYTHING before it
      // is the resource namespace, joined — not just the immediate parent.
      // Slack has both `conversations.archive` and `admin.conversations.archive`;
      // keeping only `conversations` would collapse them onto one name (a
      // spurious collision), so the resource is `conversations` vs
      // `admin_conversations` — distinct, and each still reads as what it is.
      return {
        resource: parts.slice(0, -1).join("_"),
        rpcAction: parts[parts.length - 1],
      };
    }
  }
  return { resource: noSuffix || segment };
}

interface RawForNaming {
  operationId?: string;
  summary?: string;
}

/**
 * Derive the names for one operation, scoring how trustworthy the result is.
 * A declared `operationId` is the strongest signal; a name synthesized purely
 * from an HTTP verb over a service-level fallback resource is the weakest.
 */
export function deriveNames(
  serviceId: string,
  path: string,
  method: HttpMethod,
  raw: RawForNaming,
): DerivedNames {
  const segments = path.split("/").filter(Boolean);
  const concrete = segments.filter((s) => !s.startsWith("{"));
  const hasResource = concrete.length > 0;
  // Clean the trailing segment before reading anything off it: strip a REST
  // format suffix (`Messages.json` → `Messages`) and split an RPC-style dotted
  // method (`chat.postMessage` → resource `chat`, method `postMessage`). Both
  // otherwise leak the literal URL shape into the agent-facing names.
  // An OData key predicate rides on the segment (`Set('id')`); strip it to the
  // bare resource name before any other segment reasoning, and remember that the
  // segment addresses a single item.
  const lastStripped = concrete[concrete.length - 1];
  const odata = lastStripped !== undefined ? stripODataKey(lastStripped) : undefined;
  const lastRaw = odata?.resource ?? concrete[concrete.length - 1];
  const decomposed = lastRaw !== undefined ? decomposeSegment(lastRaw) : undefined;
  // A static trailing path segment that names a verb from the shared action
  // vocabulary (classify.ts) is a verb over the resource before it, not a
  // sub-resource itself — e.g. `GET /field/search` searches fields, it does not
  // read a resource called "search". Naively taking the last segment as the
  // resource misreads these ("search list field" instead of "field search").
  // Reusing classify.ts's table (rather than a second, parallel keyword list)
  // is what keeps this verb and `effect.action` from ever disagreeing.
  const lastConcrete = decomposed?.resource;
  // Only a *bare* trailing verb (a single-word segment that IS the verb, like
  // `/field/search`) names an action over the resource before it. A multi-word
  // segment that merely *contains* a vocab verb is a full operation name, not a
  // verb: GraphQL/gRPC lower every operation to `/graphql/Mutation/<field>` or
  // `/<pkg.Service>/<Method>`, and a field like `acceptEnterpriseAdminInvitation`
  // (contains "accept") or `issueFigmaFileKeySearch` (ends "search") must stay
  // the resource, or every field collapses onto the synthetic `Mutation`/`Query`
  // wrapper as its resource and collides — then disambiguation re-appends the
  // field name and the tool name doubles.
  // A bare trailing verb names an action over the segment BEFORE it — but only
  // when that segment is a real resource. When it is an API version (or absent),
  // the trailing segment IS the resource: `/data/v60.0/query` is the `query`
  // resource, not a `search` over the version.
  const beforeLast = concrete.length > 1 ? concrete[concrete.length - 2] : undefined;
  const beforeIsResource = beforeLast !== undefined && !isVersionLike(beforeLast);
  const trailingVerb =
    decomposed?.rpcAction === undefined &&
    lastConcrete !== undefined &&
    beforeIsResource &&
    !snakeCase(lastConcrete).includes("_")
      ? actionVerbFor(lastConcrete)
      : undefined;
  const resource =
    trailingVerb && concrete.length > 1
      ? decomposeSegment(concrete[concrete.length - 2] as string).resource
      : hasResource
        ? (lastConcrete as string)
        : serviceId;
  // The path addresses a single item when it ends in a `/{param}` segment or an
  // OData key predicate (`Set('id')`) — either way the action is get/update/
  // delete, not list.
  const lastSegment = segments[segments.length - 1] as string | undefined;
  const endsWithParam =
    lastSegment !== undefined && (lastSegment.startsWith("{") || stripODataKey(lastSegment).keyed);
  // A write-method endpoint with a readIntent verb (see classify.ts) is
  // reclassified to a read; the action verb must agree, or the CLI/MCP surface
  // would call a read "create" while its own safety posture says otherwise.
  const readIntentSignal = `${raw.operationId ?? ""} ${raw.summary ?? ""}`;
  // Priority: an RPC method name (Slack `postMessage`) names the action
  // directly; then a verb-trailing segment; then a read-intent write; then the
  // HTTP-method default. An RPC action is snake_cased so it reads as one CLI
  // token (`post_message`) that matches the operationId-derived tool name.
  const action = decomposed?.rpcAction
    ? snakeCase(decomposed.rpcAction)
    : trailingVerb
      ? trailingVerb
      : isReadIntentWriteMethod(method, readIntentSignal)
        ? (actionVerbFor(readIntentSignal) as string)
        : method === "post"
          ? (postVerbFromOperationId(raw.operationId) ?? actionFor(method, endsWithParam))
          : method === "patch" || method === "put"
            ? (upsertVerbFromOperationId(raw.operationId) ?? actionFor(method, endsWithParam))
            : actionFor(method, endsWithParam);

  const fromOperationId = Boolean(raw.operationId);
  const canonicalName = raw.operationId
    ? snakeCase(raw.operationId)
    : `${action}_${singularize(resource)}`;
  const displayName =
    raw.summary ?? canonicalName.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

  // Confidence + the signals behind it.
  const signals: string[] = [];
  let confidence = 0.6;
  if (fromOperationId) {
    confidence = 0.9;
    signals.push("name derived from a declared operationId");
  } else {
    signals.push("name synthesized from HTTP method + path");
  }
  if (!hasResource) {
    confidence -= 0.25;
    signals.push("no concrete path segment — resource fell back to the service name");
  }
  const verb = canonicalName.split("_")[0] ?? "";
  if (VAGUE_ACTIONS.has(verb)) {
    // Large enough to pull even a strong operationId signal (0.9) below the
    // review threshold: a real spec's operationId can be well-declared and
    // still name nothing an agent can route on. Jira's own `doTransition` is
    // exactly this case — Atlassian's community MCP server renames it to
    // `transition_issue` for the same reason this must not stay confident.
    confidence -= 0.45;
    signals.push(`vague verb "${verb}" — hard for an agent to route on`);
  }

  return {
    id: `${serviceId}.${snakeCase(resource)}.${action}`,
    canonicalName,
    displayName,
    cliCommand: `${serviceId} ${resource} ${action}`,
    toolName: `${serviceId}_${canonicalName}`,
    resource,
    action,
    confidence: Math.max(0, Math.min(1, confidence)),
    signals,
  };
}

/** Globally-minimal candidate order: shortest first, ties lexicographic. */
const byShortestThenLex = (a: string, b: string): number =>
  a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);

/**
 * The canonical processing order inside a collision group. Every step of the
 * repair (token choice, `usedTokens` dedupe, index fallback) iterates the group
 * in this order, so the final assignment is a pure function of the group's
 * MEMBERSHIP — never of the order operations arrived from the source file.
 */
const byStableIdentity = (a: Operation, b: Operation): number =>
  (a.sourceRef.path ?? "").localeCompare(b.sourceRef.path ?? "") ||
  (a.sourceRef.method ?? "").localeCompare(b.sourceRef.method ?? "") ||
  (a.sourceRef.operationId ?? "").localeCompare(b.sourceRef.operationId ?? "");

/**
 * The projected surfaces on which every operation name must be unique. The CLI
 * command and the MCP tool name can collide INDEPENDENTLY: Linear's GraphQL
 * schema has both `Query.initiativeUpdate` and `Mutation.initiativeUpdate`,
 * whose commands differ (`... list` vs `... create`) while both derive the same
 * canonicalName and hence the same tool name — grouping by command alone never
 * sees them and the whole spec fails validation on `duplicate_tool_name`.
 */
const SURFACES: ReadonlyArray<{ label: string; keyOf: (op: Operation) => string }> = [
  { label: "CLI command", keyOf: (op) => op.cli.command },
  { label: "MCP tool name", keyOf: (op) => op.mcp.toolName },
];

/**
 * Resolve name collisions across the whole operation set, coherently across id,
 * CLI command, and MCP tool name (they must not drift apart). Uniqueness is
 * enforced on EVERY projected surface (command and tool name), not just the CLI
 * command. Disambiguation is deterministic, input-order-independent, and
 * meaningful: the globally-minimal path token that distinguishes the clashing
 * operations (shortest, ties lexicographic), then the shortest distinguishing
 * token pair, then the HTTP method, then a stable index. Every rename is
 * surfaced as a diagnostic — never silent.
 */
export function resolveNameCollisions(operations: Operation[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  // A rename triggered by one surface updates all three names, which the next
  // surface's grouping must see — so re-derive groups and repeat to a fixpoint.
  // Termination: a pass only acts on a colliding group and leaves that group's
  // keys unique, and suffixed names only ever grow; in practice this settles in
  // one or two sweeps. The bound is a safety net — validate() still hard-errors
  // on any duplicate that could somehow survive it.
  for (let sweep = 0; sweep < 10; sweep++) {
    let changed = false;
    for (const surface of SURFACES) {
      changed = resolveSurfaceCollisions(operations, surface, diagnostics) || changed;
    }
    if (!changed) break;
  }
  return diagnostics;
}

/** One repair pass over one surface. Returns whether any group was renamed. */
function resolveSurfaceCollisions(
  operations: Operation[],
  surface: { label: string; keyOf: (op: Operation) => string },
  diagnostics: Diagnostic[],
): boolean {
  const groups = new Map<string, Operation[]>();
  for (const op of operations) {
    const key = surface.keyOf(op);
    const list = groups.get(key) ?? [];
    list.push(op);
    groups.set(key, list);
  }

  // Order-independence: group membership is a set (keyed by the surface name,
  // which cannot depend on input order), groups are processed in sorted-key
  // order, and members in `byStableIdentity` order. Shuffling the input spec
  // therefore yields byte-identical assignments.
  let changed = false;
  const keys = [...groups.keys()].sort();
  for (const key of keys) {
    const group = groups.get(key) as Operation[];
    if (group.length < 2) continue;
    changed = true;
    group.sort(byStableIdentity);
    const usedTokens = new Set<string>();
    for (const [index, op] of group.entries()) {
      let token = distinguishingToken(op, group) ?? op.sourceRef.method ?? String(index + 1);
      let candidate = token;
      let n = 2;
      while (usedTokens.has(candidate)) candidate = `${token}_${n++}`;
      token = candidate;
      usedTokens.add(token);

      const suffix = snakeCase(token);
      const before = op.id;
      op.canonicalName = `${op.canonicalName}_${suffix}`;
      op.id = `${op.id}.${suffix}`;
      op.cli.command = `${op.cli.command} ${suffix}`;
      op.mcp.toolName = `${op.mcp.toolName}_${suffix}`;
      diagnostics.push({
        level: "info",
        code: "naming_collision_resolved",
        message: `${surface.label} "${key}" was shared; disambiguated "${before}" with "${suffix}".`,
        operationId: op.id,
      });
    }
  }
  return changed;
}

/** Concrete path segments as cleaned word-tokens: format suffix stripped, RPC
 * dotted segments split into their parts. So a distinguishing token is always
 * a real word (`admin`, `local`), never a raw `Messages.json` or a whole
 * dotted method — the same cleaning the derived names already got. */
function cleanPathTokens(path: string | undefined): string[] {
  return (path ?? "")
    .split("/")
    .filter((s) => s && !s.startsWith("{"))
    .flatMap((s) => s.replace(FORMAT_SUFFIX, "").split(".").filter(Boolean));
}

/**
 * The globally-minimal token that distinguishes `op` from the rest of its
 * collision group: among ALL of the operation's own cleaned path tokens that no
 * other group member's path contains, pick the shortest (ties break
 * lexicographically) — not the first-in-path-order one, which on real specs
 * drags in long prefix segments (`administrative_gateway`) when a short unique
 * token (`v2`) exists further along. If no single token distinguishes, the
 * shortest distinguishing PAIR of own tokens (joined `_`, kept in path order)
 * is tried before the caller falls back to the HTTP method / stable index.
 */
function distinguishingToken(op: Operation, group: Operation[]): string | undefined {
  const mine = cleanPathTokens(op.sourceRef.path);
  const others = group
    .filter((o) => o !== op)
    .map((o) => new Set(cleanPathTokens(o.sourceRef.path)));

  const unique = [...new Set(mine.filter((seg) => others.every((set) => !set.has(seg))))];
  if (unique.length > 0) return unique.sort(byShortestThenLex)[0];

  // No single token distinguishes: try pairs of own tokens (in path order) that
  // no other member's path contains in full.
  const pairs: string[] = [];
  for (let i = 0; i < mine.length; i++) {
    for (let j = i + 1; j < mine.length; j++) {
      const a = mine[i] as string;
      const b = mine[j] as string;
      if (a === b) continue;
      if (others.every((set) => !(set.has(a) && set.has(b)))) pairs.push(`${a}_${b}`);
    }
  }
  if (pairs.length > 0) return [...new Set(pairs)].sort(byShortestThenLex)[0];
  return undefined;
}

/**
 * Critique the final names for agent-friendliness, emitting reviewable
 * diagnostics. This is the "review output" a human reads instead of the YAML:
 * which operations have weak or ambiguous names, and why.
 */
export function critiqueNames(
  operations: Operation[],
  nameConfidence: Map<string, number>,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const op of operations) {
    const conf = nameConfidence.get(op.id);
    if (conf !== undefined && conf < 0.5) {
      diagnostics.push({
        level: "info",
        code: "weak_operation_name",
        message: `Operation "${op.id}" has a low-confidence name (${conf.toFixed(2)}). Consider a manifest display_name / operationId so agents can route on it.`,
        operationId: op.id,
      });
    }
  }
  return diagnostics;
}
