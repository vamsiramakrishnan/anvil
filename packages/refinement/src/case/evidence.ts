import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { Claim } from "@anvil/air";
import type { JsonValue } from "../skills/contract.js";
import { type CaseWorkspace, hashContent, hashJson, withinScopes } from "./identity.js";
import { isStageFrozen } from "./lifecycle.js";
import {
  CASE_OUTPUT,
  type ClaimSet,
  type EvidenceArtifact,
  type EvidencePolicyDoc,
  type EvidenceReport,
} from "./model.js";
import { loadPolicy, loadTargetDoc, loadTools, readOptionalJson, writeJson } from "./store.js";

/**
 * **Evidence acquisition** — the provider boundary. An agent never hands Anvil a
 * trusted excerpt; it hands a *coordinate*, and an `EvidenceAcquirer` resolves and
 * freezes the artifact. Today there are two providers — the local repository (read,
 * hash, and verify the exact bytes) and an external artifact (an opaque pointer with
 * a caller-supplied, unverifiable excerpt) — chosen by the shape of the coordinate,
 * never by an `if (source === ...)` ladder. New providers (GitHub MCP, Confluence
 * MCP, Jira, recorded traffic) become new acquirers, not new branches in `addEvidence`.
 */

/** A frozen evidence artifact — what a provider returns after resolving a coordinate. */
export type FrozenEvidenceArtifact = EvidenceArtifact;

/** What an agent submits: where the evidence is, not what it says. */
export interface EvidenceCoordinate {
  source: string;
  /** A filesystem source coordinate — the local provider reads and verifies it. */
  path?: string;
  startLine?: number;
  endLine?: number;
  /** A non-filesystem source pointer (Postman, incident, doc URL). */
  uri?: string;
  /** The provided excerpt for a non-filesystem source (cannot be verified). */
  excerpt?: string;
  note?: string;
}

/** The environment a provider resolves a coordinate against. */
export interface AcquisitionContext {
  workspace: CaseWorkspace;
  /** Injectable clock (ms) for reproducible acquisition timestamps in tests. */
  now?: number;
}

/** A pluggable evidence provider: resolve a coordinate into a frozen artifact. */
export interface EvidenceAcquirer {
  readonly kind: "local_repository" | "external_artifact";
  /** Whether this provider handles the given coordinate shape. */
  supports(coordinate: EvidenceCoordinate): boolean;
  acquire(coordinate: EvidenceCoordinate, context: AcquisitionContext): FrozenEvidenceArtifact;
}

/**
 * The local repository provider: a filesystem coordinate is *verified*. The path must
 * resolve inside an allowed scope, the line range must be valid, and Anvil reads the
 * exact bytes and hashes them (`verified: true`). Anvil never trusts an agent-provided
 * excerpt for a source it can read itself.
 */
export class LocalRepositoryEvidenceAcquirer implements EvidenceAcquirer {
  readonly kind = "local_repository" as const;
  supports(coordinate: EvidenceCoordinate): boolean {
    return coordinate.path !== undefined;
  }
  acquire(coordinate: EvidenceCoordinate, context: AcquisitionContext): FrozenEvidenceArtifact {
    const { workspace } = context;
    const path = coordinate.path as string;
    const abs = isAbsolute(path) ? resolve(path) : resolve(workspace.repositoryRoot, path);
    const scopes = workspace.inspectScopes.length
      ? workspace.inspectScopes
      : [workspace.repositoryRoot];
    if (!withinScopes(scopes, abs)) {
      throw new Error(
        `Evidence path '${path}' resolves outside the allowed scopes (${scopes.join(", ")}).`,
      );
    }
    if (!existsSync(abs)) throw new Error(`Evidence path '${path}' does not exist.`);
    const content = readFileSync(abs, "utf8");
    const lines = content.split("\n");
    let excerpt = content;
    if (coordinate.startLine !== undefined) {
      const start = coordinate.startLine;
      const end = coordinate.endLine ?? coordinate.startLine;
      if (start < 1 || end < start || end > lines.length) {
        throw new Error(
          `Invalid line range ${start}-${end} for '${path}' (${lines.length} lines).`,
        );
      }
      excerpt = lines.slice(start - 1, end).join("\n");
    }
    const contentHash = hashContent(excerpt);
    const rel = relative(workspace.repositoryRoot, abs);
    const uri = coordinate.startLine
      ? `${rel}#L${coordinate.startLine}-L${coordinate.endLine ?? coordinate.startLine}`
      : rel;
    return {
      id: contentHash.slice(0, 12),
      uri,
      source: coordinate.source as EvidenceArtifact["source"],
      revision: workspace.repositoryRevision,
      contentHash,
      excerpt,
      acquiredAt: new Date(context.now ?? Date.now()).toISOString(),
      relevance: coordinate.note,
      path: rel,
      startLine: coordinate.startLine,
      endLine: coordinate.endLine ?? coordinate.startLine,
      verified: true,
    };
  }
}

/**
 * The external artifact provider: a source Anvil cannot read itself (a Postman run,
 * an incident, a doc URL). It keeps the provided excerpt, hashed but `verified: false`.
 * When a real second-source integration arrives (GitHub/Confluence MCP), it replaces
 * this with an acquirer that actually resolves the pointer.
 */
export class ExternalArtifactEvidenceAcquirer implements EvidenceAcquirer {
  readonly kind = "external_artifact" as const;
  supports(_coordinate: EvidenceCoordinate): boolean {
    return true;
  }
  acquire(coordinate: EvidenceCoordinate, context: AcquisitionContext): FrozenEvidenceArtifact {
    const uri = coordinate.uri ?? "(unspecified)";
    const excerpt = coordinate.excerpt ?? "";
    const contentHash = hashContent(excerpt);
    return {
      id: hashJson({ uri, excerpt, source: coordinate.source }).slice(0, 12),
      uri,
      source: coordinate.source as EvidenceArtifact["source"],
      contentHash,
      excerpt,
      acquiredAt: new Date(context.now ?? Date.now()).toISOString(),
      relevance: coordinate.note,
      verified: false,
    };
  }
}

/** The providers, in resolution order — the first that supports the coordinate wins. */
export const EVIDENCE_ACQUIRERS: readonly EvidenceAcquirer[] = [
  new LocalRepositoryEvidenceAcquirer(),
  new ExternalArtifactEvidenceAcquirer(),
];

/** Pick the provider for a coordinate (local for a path, external otherwise). */
export function acquirerFor(
  coordinate: EvidenceCoordinate,
  acquirers: readonly EvidenceAcquirer[] = EVIDENCE_ACQUIRERS,
): EvidenceAcquirer {
  const provider = acquirers.find((a) => a.supports(coordinate));
  if (!provider) throw new Error(`No evidence provider handles source '${coordinate.source}'.`);
  return provider;
}

/**
 * The predicates a claim may assert for this case: the skill's *output* predicates
 * plus its narrow *supporting* predicates. Anything else is rejected — an executor
 * may not smuggle a free-form predicate into `claims.json`.
 */
export function allowedPredicates(policy: EvidencePolicyDoc): Set<string> {
  return new Set<string>([...policy.writablePredicates, ...policy.supportingPredicates]);
}

/* ------------------------------ add-evidence ------------------------------ */

export interface AddEvidenceInput {
  predicate: string;
  value?: JsonValue;
  source: string;
  path?: string;
  startLine?: number;
  endLine?: number;
  uri?: string;
  excerpt?: string;
  /** Legacy alias for `uri` (a bare source pointer). */
  ref?: string;
  note?: string;
  confidence?: number;
  now?: number;
}

/**
 * Record one piece of evidence: enforce the source AND predicate policy, then hand
 * the *coordinate* to the resolved provider, which freezes the artifact (research
 * phase) and returns it. The atomic claim it grounds (extract phase) references the
 * frozen artifact by id, so it can never point at an excerpt the source does not
 * actually contain.
 */
export function addEvidence(dir: string, input: AddEvidenceInput): string {
  if (isStageFrozen(dir, "research")) {
    throw new Error(
      "The research stage is frozen (a proposal was synthesized). Open a new run to gather more evidence.",
    );
  }
  const policy = loadPolicy(dir);
  const tdoc = loadTargetDoc(dir);
  if (!policy.allowedSources.includes(input.source as never)) {
    throw new Error(
      `Source '${input.source}' is not admissible for this case. Allowed: ${policy.allowedSources.join(", ")}.`,
    );
  }
  const allowed = allowedPredicates(policy);
  if (!allowed.has(input.predicate)) {
    throw new Error(
      `Predicate '${input.predicate}' is not permitted for this case. ` +
        `Output: ${policy.writablePredicates.join(", ") || "(none)"}; ` +
        `supporting: ${policy.supportingPredicates.join(", ") || "(none)"}.`,
    );
  }

  const coordinate: EvidenceCoordinate = {
    source: input.source,
    path: input.path,
    startLine: input.startLine,
    endLine: input.endLine,
    uri: input.uri ?? input.ref,
    excerpt: input.excerpt,
    note: input.note,
  };
  const artifact = acquirerFor(coordinate).acquire(coordinate, {
    workspace: loadTools(dir).workspace,
    now: input.now,
  });
  const evidence = readOptionalJson<EvidenceReport>(dir, CASE_OUTPUT.research) ?? { artifacts: [] };
  evidence.artifacts.push(artifact);
  writeJson(dir, CASE_OUTPUT.research, evidence);

  const subject = tdoc.field?.path ?? tdoc.operationId ?? tdoc.errorCode ?? tdoc.key;
  const claim: Claim = {
    subject,
    predicate: input.predicate,
    value: input.value,
    source: input.source as Claim["source"],
    // The claim references the FROZEN artifact, not a raw agent-provided pointer.
    sourceRef: artifact.id,
    sourceRevision: artifact.revision,
    method: "case_investigation",
    confidence: input.confidence ?? 0.8,
    note: input.note,
  };
  const claims = readOptionalJson<ClaimSet>(dir, CASE_OUTPUT.extract) ?? { claims: [] };
  claims.claims.push(claim);
  writeJson(dir, CASE_OUTPUT.extract, claims);

  const kind = policy.writablePredicates.includes(input.predicate) ? "output" : "supporting";
  const prov = artifact.verified ? `verified ${artifact.uri}` : `unverified ${artifact.uri}`;
  return `Recorded ${claims.claims.length} claim(s). Latest (${kind}): ${input.predicate}=${JSON.stringify(input.value)} from ${input.source} [${prov}, artifact ${artifact.id}].`;
}

/**
 * Re-verify the frozen filesystem evidence against the source repository: every
 * verified artifact's excerpt must still hash to what was recorded. A mismatch means
 * the source changed (or was tampered with) after acquisition — the investigation's
 * evidence is no longer trustworthy and close should refuse it.
 */
export function verifyFrozenEvidence(dir: string): {
  ok: boolean;
  mismatches: Array<{ id: string; uri: string; reason: string }>;
} {
  const workspace = loadTools(dir).workspace;
  const report = readOptionalJson<EvidenceReport>(dir, CASE_OUTPUT.research) ?? { artifacts: [] };
  const mismatches: Array<{ id: string; uri: string; reason: string }> = [];
  for (const a of report.artifacts) {
    if (!a.verified || !a.path) continue;
    const abs = resolve(workspace.repositoryRoot, a.path);
    if (!existsSync(abs)) {
      mismatches.push({ id: a.id, uri: a.uri, reason: "source path no longer exists" });
      continue;
    }
    const lines = readFileSync(abs, "utf8").split("\n");
    const excerpt =
      a.startLine !== undefined
        ? lines.slice(a.startLine - 1, a.endLine ?? a.startLine).join("\n")
        : lines.join("\n");
    if (hashContent(excerpt) !== a.contentHash) {
      mismatches.push({ id: a.id, uri: a.uri, reason: "source content changed since acquisition" });
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}
