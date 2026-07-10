import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import type { AirDocument } from "@anvil/air";

/**
 * Run identity and workspace containment — the metadata that makes a case run
 * *reproducible and bounded*. A case run is immutable: it is stamped with content
 * hashes of the inputs it was opened against, and the repository it may inspect is
 * resolved to canonical absolute paths that cannot escape the repository root.
 */

/** A stable content hash (sha256 hex) of any JSON-serialisable value. */
export function hashJson(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value) ?? "")
    .digest("hex");
}

/** A content hash (sha256 hex) of a raw string — used to freeze an evidence excerpt. */
export function hashContent(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * The repository the investigation may read. Scopes are resolved to canonical
 * absolute paths and proven to lie within the repository root; the case directory
 * is the ONLY place the agent may write, and the repository is read-only.
 */
export interface CaseWorkspace {
  repositoryRoot: string;
  repositoryRevision?: string;
  /** Canonical absolute paths, each within `repositoryRoot`. */
  inspectScopes: string[];
}

export interface ResolveWorkspaceInput {
  repositoryRoot?: string;
  repositoryRevision?: string;
  inspect?: string[];
}

/**
 * Resolve inspect scopes against an explicit repository root, canonicalise them,
 * and reject any that escape the root (path traversal). This is the containment
 * boundary: a scope like `../secrets` or an absolute path outside the repo is
 * refused at case creation, not trusted at read time.
 */
export function resolveWorkspace(input: ResolveWorkspaceInput): CaseWorkspace {
  const repositoryRoot = resolve(input.repositoryRoot ?? process.cwd());
  const inspectScopes = (input.inspect ?? []).map((scope) => {
    const abs = isAbsolute(scope) ? resolve(scope) : resolve(repositoryRoot, scope);
    if (!isWithin(repositoryRoot, abs)) {
      throw new Error(
        `Inspect scope '${scope}' resolves to '${abs}', outside the repository root '${repositoryRoot}'.`,
      );
    }
    return abs;
  });
  return { repositoryRoot, repositoryRevision: input.repositoryRevision, inspectScopes };
}

/** Is `candidate` the root itself or contained within it (no traversal, no sibling)? */
export function isWithin(root: string, candidate: string): boolean {
  const r = resolve(root);
  const c = resolve(candidate);
  if (c === r) return true;
  const rel = relative(r, c);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Is `candidate` within at least one of the allowed scopes? */
export function withinScopes(scopes: string[], candidate: string): boolean {
  return scopes.some((s) => isWithin(s, candidate));
}

/**
 * The immutable identity stamped on a case run: a run id plus content hashes of the
 * exact inputs it was opened against, so a run is auditable and can never be
 * confused with one opened against a different model, skill, or policy.
 */
export interface RunIdentity {
  runId: string;
  caseKey: string;
  airHash: string;
  sourceRevision?: string;
  skillVersion: number;
  policyHash: string;
  executor: string;
  createdAt: string;
}

export interface BuildRunIdentityInput {
  caseKey: string;
  air: AirDocument;
  skillVersion: number;
  policy: unknown;
  executor?: string;
  repositoryRevision?: string;
  /** Injectable clock (ms) for reproducible run ids in tests. */
  now?: number;
}

/**
 * Stamp a run identity. The run id is content+time addressed (a hash of the AIR
 * hash, policy hash, case key, and creation time), so two opens of the same case
 * against the same inputs at different times get different, immutable run dirs.
 */
export function buildRunIdentity(input: BuildRunIdentityInput): RunIdentity {
  const createdAtMs = input.now ?? Date.now();
  const airHash = hashJson(input.air).slice(0, 16);
  const policyHash = hashJson(input.policy).slice(0, 16);
  const runId = hashJson({ airHash, policyHash, caseKey: input.caseKey, createdAtMs }).slice(0, 12);
  return {
    runId,
    caseKey: input.caseKey,
    airHash,
    sourceRevision: input.repositoryRevision,
    skillVersion: input.skillVersion,
    policyHash,
    executor: input.executor ?? "unspecified",
    createdAt: new Date(createdAtMs).toISOString(),
  };
}
