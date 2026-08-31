import type { AirDocument, Operation } from "@anvil/air";
import { snakeCase } from "@anvil/air";
import { type Deficiency, makeDeficiency } from "../deficiency.js";
import { concretePathSegments, routingTokens } from "../vocabulary.js";

/**
 * `resource_contradicted_by_own_name` — the detector home of "rule B" from
 * docs/design/resource-derivation-and-tool-name-stutter.md §6.
 *
 * The compiler derives `effect.resource` from ONE path segment while
 * `canonicalName`/`displayName` come from the spec's own operationId and
 * summary; the two sources are never reconciled. When the derived resource
 * shares NO content token with the operation's own name text, that is a real,
 * structural fact worth asking about — but it is NOT proof the resource is
 * wrong: vendors use synonyms (GitHub says "webhook" where its path says
 * `hooks`, "file" where the path says `contents`), so a hand audit of rule B
 * as a compiler rewrite found ~15 of 28 sampled changes semantically wrong.
 * This detector therefore only RAISES the question, with the full evidence a
 * decision-maker (human or coding harness) needs; the closure is the reviewed
 * manifest `name: { resource }` override (packages/compiler/src/manifest.ts,
 * applied through `projectRoutingNames` in packages/compiler/src/naming.ts),
 * never an automatic re-home.
 */

/** A sibling operation sharing this operation's parent path, as harness evidence. */
interface SiblingOperationFact {
  id: string;
  canonicalName: string;
  method?: string;
  path?: string;
  resource?: string;
}

/** How many siblings ride along before the bundle becomes a dump. */
const MAX_SIBLING_FACTS = 12;

/**
 * Estate-level naming-style facts, computed locally from the operations this
 * document can see (never from a compiler classification field), so a harness
 * can judge "is this estate's style path-grammar REST or RPC-over-HTTP" from
 * the same evidence a person would.
 */
interface EstateNamingFacts {
  operations: number;
  /** Operations with a derived resource, a path, and tokenizable name text. */
  resourcesMeasured: number;
  /** Of those, how many share no content token with their own name text. */
  resourcesContradicted: number;
  distinctResources: number;
  /** Paths whose final segment is a `{parameter}` — resource-grammar signal. */
  parameterTerminalPaths: number;
  /** Paths with a dotted concrete segment (`chat.postMessage`) — RPC signal. */
  dottedSegmentPaths: number;
}

/** The name text an agent actually routes on for this operation. */
function nameText(op: Operation): string {
  return `${op.canonicalName} ${op.displayName}`;
}

/**
 * Whether this operation's derivation is measurable at all: a derived resource,
 * a source path (the resource's provenance), and name text with content tokens.
 * Absence of any of these is not evidence of a contradiction.
 */
function measurable(op: Operation): boolean {
  return (
    Boolean(op.effect.resource && snakeCase(op.effect.resource).length > 0) &&
    Boolean(op.sourceRef.path) &&
    routingTokens(nameText(op)).length > 0
  );
}

/** True when the derived resource shares no content-token stem with the name. */
function contradicted(op: Operation): boolean {
  const resourceStems = new Set(routingTokens(snakeCase(op.effect.resource ?? "")));
  if (resourceStems.size === 0) return false;
  return !routingTokens(nameText(op)).some((stem) => resourceStems.has(stem));
}

/**
 * The coordinate sibling operations share: the concrete segment chain. A
 * collection (`/orgs/{org}/hooks`) and its item operations
 * (`/orgs/{org}/hooks/{hook_id}`) have IDENTICAL concrete segments, while a
 * different collection under the same parent (`/orgs/{org}/repos`) does not —
 * exactly the "operations on the same thing" a harness should read together.
 */
function parentKey(op: Operation): string | undefined {
  const segments = concretePathSegments(op.sourceRef.path);
  if (segments.length === 0) return undefined;
  return segments.join("/");
}

function estateNamingFacts(air: AirDocument): EstateNamingFacts {
  let measured = 0;
  let contradictions = 0;
  let parameterTerminal = 0;
  let dotted = 0;
  const resources = new Set<string>();
  for (const op of air.operations) {
    if (op.effect.resource) resources.add(op.effect.resource);
    const path = op.sourceRef.path;
    if (path?.trimEnd().endsWith("}")) parameterTerminal += 1;
    if (concretePathSegments(path).some((segment) => segment.includes("."))) dotted += 1;
    if (!measurable(op)) continue;
    measured += 1;
    if (contradicted(op)) contradictions += 1;
  }
  return {
    operations: air.operations.length,
    resourcesMeasured: measured,
    resourcesContradicted: contradictions,
    distinctResources: resources.size,
    parameterTerminalPaths: parameterTerminal,
    dottedSegmentPaths: dotted,
  };
}

/** The siblings sharing this operation's parent path segment, capped and sorted. */
function siblingFacts(air: AirDocument, op: Operation): SiblingOperationFact[] {
  const key = parentKey(op);
  if (key === undefined) return [];
  return air.operations
    .filter((candidate) => candidate.id !== op.id && parentKey(candidate) === key)
    .map((candidate) => ({
      id: candidate.id,
      canonicalName: candidate.canonicalName,
      ...(candidate.sourceRef.method ? { method: candidate.sourceRef.method } : {}),
      ...(candidate.sourceRef.path ? { path: candidate.sourceRef.path } : {}),
      ...(candidate.effect.resource ? { resource: candidate.effect.resource } : {}),
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, MAX_SIBLING_FACTS);
}

/**
 * The detector. Pure `(air) => Deficiency[]`; proves only the structural fact
 * ("these two naming surfaces share no vocabulary"), never a business one. The
 * facts block is the complete evidence bundle `anvil refine export-task`
 * carries to a coding harness: the operation's own coordinates, its derived
 * axes, the tokenizations that failed to overlap, the siblings under the same
 * parent segment, and the estate's locally-computed naming-style facts.
 */
export function detectResourceContradictions(air: AirDocument): Deficiency[] {
  const estate = estateNamingFacts(air);
  const out: Deficiency[] = [];
  for (const op of air.operations) {
    if (!measurable(op) || !contradicted(op)) continue;
    const resource = op.effect.resource ?? "";
    out.push(
      makeDeficiency(
        "resource_contradicted_by_own_name",
        { kind: "operation", operationId: op.id },
        `Operation '${op.id}' routes on resource '${resource}', which its own name ` +
          `'${op.canonicalName}' never mentions — a synonym, or a mis-derived path segment.`,
        {
          path: op.sourceRef.path ?? null,
          method: op.sourceRef.method ?? null,
          operationId: op.sourceRef.operationId ?? null,
          canonicalName: op.canonicalName,
          displayName: op.displayName,
          derivedResource: resource,
          derivedAction: op.effect.action,
          pathSegments: concretePathSegments(op.sourceRef.path),
          resourceTokens: [...new Set(routingTokens(snakeCase(resource)))],
          nameTokens: [...new Set(routingTokens(nameText(op)))],
          siblingOperations: siblingFacts(air, op) as unknown as Record<string, unknown>[],
          estateNamingFacts: estate as unknown as Record<string, unknown>,
          closure:
            "manifest `name: { resource }` override (compiler manifest.ts → projectRoutingNames); propose-only, review-tier always",
        },
      ),
    );
  }
  return out;
}
