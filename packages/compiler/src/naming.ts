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
  const lastRaw = concrete[concrete.length - 1];
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
  const trailingVerb =
    decomposed?.rpcAction === undefined &&
    lastConcrete !== undefined &&
    !snakeCase(lastConcrete).includes("_")
      ? actionVerbFor(lastConcrete)
      : undefined;
  const resource =
    trailingVerb && concrete.length > 1
      ? decomposeSegment(concrete[concrete.length - 2] as string).resource
      : hasResource
        ? (lastConcrete as string)
        : serviceId;
  const endsWithParam =
    segments.length > 0 && (segments[segments.length - 1] as string).startsWith("{");
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

/**
 * Resolve name collisions across the whole operation set, coherently across id,
 * CLI command, and MCP tool name (they must not drift apart). Disambiguation is
 * deterministic and meaningful: prefer a path segment that distinguishes the
 * clashing operations, then the HTTP method, then a stable index. Every rename
 * is surfaced as a diagnostic — never silent.
 */
export function resolveNameCollisions(operations: Operation[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const byCommand = new Map<string, Operation[]>();
  for (const op of operations) {
    const list = byCommand.get(op.cli.command) ?? [];
    list.push(op);
    byCommand.set(op.cli.command, list);
  }

  for (const [command, group] of byCommand) {
    if (group.length < 2) continue;
    // Identity must not depend on source-file ordering: when the token falls
    // back to the HTTP method or an index, whoever comes first in the group
    // decides who gets the bare token. Order the group by (path, method) so a
    // reshuffled spec still derives the same ids.
    group.sort(
      (a, b) =>
        (a.sourceRef.path ?? "").localeCompare(b.sourceRef.path ?? "") ||
        (a.sourceRef.method ?? "").localeCompare(b.sourceRef.method ?? ""),
    );
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
        message: `CLI command "${command}" was shared; disambiguated "${before}" with "${suffix}".`,
        operationId: op.id,
      });
    }
  }
  return diagnostics;
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

/** A cleaned path token that distinguishes `op` from the rest of its collision group. */
function distinguishingToken(op: Operation, group: Operation[]): string | undefined {
  const mine = cleanPathTokens(op.sourceRef.path);
  const others = group
    .filter((o) => o !== op)
    .map((o) => new Set(cleanPathTokens(o.sourceRef.path)));
  for (const seg of mine) {
    if (others.every((set) => !set.has(seg))) return seg;
  }
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
