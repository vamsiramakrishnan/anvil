import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { hashCanonical } from "@anvil/air";
import { isWithin } from "../case/identity.js";
import { rejectHarness } from "./errors.js";
import type { HarnessEvidenceArtifact, HarnessEvidenceInput, RefinementTask } from "./schema.js";

function git(root: string, args: string[]): Buffer {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "buffer",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    rejectHarness(
      "refinement/repository_evidence_invalid",
      "evidence",
      `Git could not resolve ${args.join(" ")} in the selected repository.`,
    );
  }
}

/** Resolve the full commit identity used to bind an exported task. */
export function resolveRepositoryRevision(repositoryRoot: string): string {
  return git(resolve(repositoryRoot), ["rev-parse", "HEAD"]).toString("utf8").trim();
}

/** Refuse imports when the checkout moved after the task was exported. */
export function verifyRepositoryRevision(repositoryRoot: string, expected: string): void {
  const current = resolveRepositoryRevision(repositoryRoot);
  if (current !== expected) {
    rejectHarness(
      "refinement/repository_revision_mismatch",
      "binding",
      "The repository revision no longer matches the exported task.",
      [`task revision: ${expected}`, `current revision: ${current}`],
    );
  }
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function portablePath(repositoryRoot: string, path: string): string {
  if (isAbsolute(path)) {
    rejectHarness(
      "refinement/repository_evidence_invalid",
      "evidence",
      `Evidence path '${path}' must be repository-relative.`,
    );
  }
  const absolute = resolve(repositoryRoot, path);
  if (!isWithin(repositoryRoot, absolute)) {
    rejectHarness(
      "refinement/repository_evidence_invalid",
      "evidence",
      `Evidence path '${path}' escapes the selected repository.`,
    );
  }
  return relative(repositoryRoot, absolute).split(sep).join("/") || ".";
}

function assertInInspectScopes(root: string, path: string, scopes: readonly string[]): void {
  if (scopes.length === 0) return;
  const absolute = resolve(root, path);
  const permitted = scopes.some((scope) => isWithin(resolve(root, scope), absolute));
  if (!permitted) {
    rejectHarness(
      "refinement/repository_evidence_invalid",
      "evidence",
      `Evidence path '${path}' is outside the task's inspect scopes.`,
      scopes.map((scope) => `allowed: ${scope}`),
    );
  }
}

function repositoryArtifact(
  root: string,
  revision: string,
  scopes: readonly string[],
  input: Extract<HarnessEvidenceInput, { kind: "repository" }>,
): HarnessEvidenceArtifact {
  const path = portablePath(root, input.path);
  assertInInspectScopes(root, path, scopes);
  if (path === ".") {
    rejectHarness(
      "refinement/repository_evidence_invalid",
      "evidence",
      "Repository evidence must name a file, not the repository root.",
    );
  }

  const objectSpec = `${revision}:${path}`;
  const blob = git(root, ["show", objectSpec]);
  const text = blob.toString("utf8");
  if (text.includes("\uFFFD")) {
    rejectHarness(
      "refinement/repository_evidence_invalid",
      "evidence",
      `Evidence path '${path}' is not valid UTF-8 text.`,
    );
  }
  const gitBlob = git(root, ["rev-parse", objectSpec]).toString("utf8").trim();
  const lines = text.split("\n");
  let excerpt = text;
  if (input.startLine !== undefined) {
    const end = input.endLine ?? input.startLine;
    if (end > lines.length) {
      rejectHarness(
        "refinement/repository_evidence_invalid",
        "evidence",
        `Evidence line range ${input.startLine}-${end} exceeds '${path}' (${lines.length} lines).`,
      );
    }
    excerpt = lines.slice(input.startLine - 1, end).join("\n");
  }
  const contentHash = sha256(excerpt);
  const blobSha256 = sha256(blob);
  const uri =
    input.startLine === undefined
      ? `${path}@${revision}`
      : `${path}#L${input.startLine}-L${input.endLine ?? input.startLine}@${revision}`;
  return {
    id: hashCanonical({
      taskRevision: revision,
      inputId: input.id,
      path,
      gitBlob,
      startLine: input.startLine,
      endLine: input.endLine ?? input.startLine,
      contentHash,
    }).slice(0, 24),
    inputId: input.id,
    uri,
    source: input.source,
    revision,
    gitBlob,
    blobSha256,
    contentHash,
    excerpt,
    path,
    startLine: input.startLine,
    endLine: input.endLine ?? input.startLine,
    verification: { status: "verified", verifier: "git_repository" },
  };
}

function externalArtifact(
  input: Extract<HarnessEvidenceInput, { kind: "external" }>,
): HarnessEvidenceArtifact {
  const contentHash = sha256(input.excerpt);
  return {
    id: hashCanonical({
      kind: input.kind,
      inputId: input.id,
      source: input.source,
      uri: input.uri,
      contentHash,
    }).slice(0, 24),
    inputId: input.id,
    uri: input.uri,
    source: input.source,
    blobSha256: contentHash,
    contentHash,
    excerpt: input.excerpt,
    verification: {
      status: "unverified",
      reason: "external artifact; Anvil could not independently resolve the supplied excerpt",
    },
  };
}

/** Resolve every submitted coordinate into bytes Anvil, rather than the harness, owns. */
export function freezeHarnessEvidence(
  task: RefinementTask,
  inputs: readonly HarnessEvidenceInput[],
  repositoryRoot: string,
): HarnessEvidenceArtifact[] {
  const root = resolve(repositoryRoot);
  verifyRepositoryRevision(root, task.repository.revision);
  return inputs.map((input) =>
    input.kind === "repository"
      ? repositoryArtifact(root, task.repository.revision, task.repository.inspectScopes, input)
      : externalArtifact(input),
  );
}
