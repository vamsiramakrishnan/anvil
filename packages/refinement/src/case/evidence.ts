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
  type EvidenceCoordinate,
  type EvidencePolicyDoc,
  type EvidenceReport,
  parseEvidenceCoordinate,
} from "./model.js";
import { loadPolicy, loadTargetDoc, loadTools, readOptionalJson, writeJson } from "./store.js";

/**
 * **Evidence acquisition** — the provider boundary. An agent never hands Anvil a
 * trusted excerpt; it hands a *coordinate*, and an `EvidenceAcquirer` resolves and
 * freezes the artifact. Today there are two providers — the local repository (read,
 * hash, and verify the exact bytes) and an external artifact (an opaque pointer with
 * a caller-supplied, unverifiable excerpt) — chosen by the coordinate's `kind`, never
 * by an `if (source === ...)` ladder. New providers (GitHub MCP, Confluence MCP,
 * Jira, recorded traffic) become new acquirers, not new branches in `addEvidence`.
 */

/** A frozen evidence artifact — what a provider returns after resolving a coordinate. */
export type FrozenEvidenceArtifact = EvidenceArtifact;

/** The environment a provider resolves a coordinate against. */
export interface AcquisitionContext {
  workspace: CaseWorkspace;
  /** Injectable clock (ms) for reproducible acquisition timestamps in tests. */
  now?: number;
}

/**
 * A pluggable evidence provider: resolve a coordinate into a frozen artifact. `kind`
 * matches exactly one arm of the `EvidenceCoordinate` discriminated union — there is
 * no catch-all provider, so a coordinate of an unregistered kind fails loudly in
 * `acquirerFor` rather than being silently absorbed by whichever provider is last.
 * Async so a future remote provider (GitHub/Confluence/Jira MCP) is a drop-in
 * implementation, not an API migration — today's providers do only synchronous IO.
 */
export interface EvidenceAcquirer {
  readonly kind: EvidenceCoordinate["kind"];
  acquire(
    coordinate: EvidenceCoordinate,
    context: AcquisitionContext,
  ): Promise<FrozenEvidenceArtifact>;
}

/**
 * The local repository provider: a filesystem coordinate is *verified*. The path must
 * resolve inside an allowed scope, the line range must be valid, and Anvil reads the
 * exact bytes and hashes them (`verification.status === "verified"`). Anvil never trusts
 * an agent-provided excerpt for a source it can read itself.
 */
export class LocalRepositoryEvidenceAcquirer implements EvidenceAcquirer {
  readonly kind = "local_repository" as const;
  async acquire(
    coordinate: Extract<EvidenceCoordinate, { kind: "local_repository" }>,
    context: AcquisitionContext,
  ): Promise<FrozenEvidenceArtifact> {
    const { workspace } = context;
    const path = coordinate.path;
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
    // Identity is the SOURCE COORDINATE, not the content: two distinct files (or spans,
    // or revisions) that happen to contain the same excerpt are independent provenance
    // and must not collapse to one id. Content alone would falsely "corroborate" itself.
    const id = hashJson({
      kind: "local_repository",
      revision: workspace.repositoryRevision,
      path: rel,
      startLine: coordinate.startLine,
      endLine: coordinate.endLine ?? coordinate.startLine,
      contentHash,
    }).slice(0, 20);
    return {
      id,
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
      verification: { status: "verified", verifier: "local_repository" },
    };
  }
}

/**
 * The external artifact provider: a source Anvil cannot read itself (a Postman run,
 * an incident, a doc URL). It keeps the provided excerpt, hashed but
 * `verification.status === "unverified"`. When a real second-source integration arrives
 * (GitHub/Confluence MCP), it replaces this with an acquirer that actually resolves the
 * pointer.
 */
export class ExternalArtifactEvidenceAcquirer implements EvidenceAcquirer {
  readonly kind = "external_artifact" as const;
  async acquire(
    coordinate: Extract<EvidenceCoordinate, { kind: "external_artifact" }>,
    context: AcquisitionContext,
  ): Promise<FrozenEvidenceArtifact> {
    const uri = coordinate.uri;
    const excerpt = coordinate.excerpt ?? "";
    const contentHash = hashContent(excerpt);
    // Identity is the SOURCE (kind + source + uri + content), not the excerpt alone —
    // two different URIs are two independent pointers even with identical excerpts.
    const id = hashJson({
      kind: "external_artifact",
      source: coordinate.source,
      uri,
      contentHash,
    }).slice(0, 20);
    return {
      id,
      uri,
      source: coordinate.source as EvidenceArtifact["source"],
      contentHash,
      excerpt,
      acquiredAt: new Date(context.now ?? Date.now()).toISOString(),
      relevance: coordinate.note,
      verification: {
        status: "unverified",
        reason: "external artifact; excerpt is caller-supplied and not independently confirmed",
      },
    };
  }
}

/** The default providers — one per `EvidenceCoordinate` kind. */
export const DEFAULT_EVIDENCE_ACQUIRERS: readonly EvidenceAcquirer[] = [
  new LocalRepositoryEvidenceAcquirer(),
  new ExternalArtifactEvidenceAcquirer(),
];

/** Pick the provider whose `kind` matches the coordinate's — no catch-all fallback. */
export function acquirerFor(
  coordinate: EvidenceCoordinate,
  acquirers: readonly EvidenceAcquirer[] = DEFAULT_EVIDENCE_ACQUIRERS,
): EvidenceAcquirer {
  const provider = acquirers.find((a) => a.kind === coordinate.kind);
  if (!provider) {
    throw new Error(`No evidence provider registered for coordinate kind '${coordinate.kind}'.`);
  }
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
 * Record one piece of evidence: enforce the source AND predicate policy, build the
 * coordinate and validate it through `parseEvidenceCoordinate` (so a malformed shape
 * is rejected by the Zod schema itself, not just by a hand-rolled check), then hand it
 * to the resolved provider, which freezes the artifact (research phase) and returns
 * it. The atomic claim it grounds (extract phase) references the frozen artifact by
 * id, so it can never point at an excerpt the source does not actually contain.
 *
 * Async because acquisition is (providers may do remote IO in the future); every
 * caller must `await` it.
 */
export async function addEvidence(
  dir: string,
  input: AddEvidenceInput,
  acquirers: readonly EvidenceAcquirer[] = DEFAULT_EVIDENCE_ACQUIRERS,
): Promise<string> {
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

  const uri = input.uri ?? input.ref;
  if (input.path !== undefined && uri !== undefined) {
    throw new Error(
      "Evidence cannot specify both a filesystem path and a uri — choose one coordinate kind.",
    );
  }
  if (input.path === undefined && uri === undefined) {
    throw new Error(
      "Evidence needs either a filesystem path (--path) or a source uri (--uri/--ref).",
    );
  }
  const coordinate = parseEvidenceCoordinate(
    input.path !== undefined
      ? {
          kind: "local_repository",
          source: input.source,
          path: input.path,
          startLine: input.startLine,
          endLine: input.endLine,
          note: input.note,
        }
      : {
          kind: "external_artifact",
          source: input.source,
          uri,
          excerpt: input.excerpt,
          note: input.note,
        },
  );
  const artifact = await acquirerFor(coordinate, acquirers).acquire(coordinate, {
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
  const prov =
    artifact.verification.status === "verified"
      ? `verified ${artifact.uri}`
      : `unverified ${artifact.uri}`;
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
    if (a.verification.status !== "verified" || !a.path) continue;
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
