import { IdentityProfile } from "@anvil/air";
import {
  certifyBundle,
  DERIVED_RECORD_FILES,
  executableEvidenceStatuses,
  GENERATION_METADATA_FILE,
  generateBundle,
  loadBundleAir,
  readBundleDir,
  resourceOptionsFromGenerationMetadata,
  verifyCertification,
} from "@anvil/generators";
import { listTargetKitVerifiers, targetKitCertificationChecks } from "@anvil/targets";
import type { ConsoleResponse } from "../contract.js";
import { ConsoleError, notFound } from "./errors.js";
import { findBundle } from "./workspace.js";

function load(root: string, id: string) {
  const bundle = findBundle(root, id);
  const files = readBundleDir(bundle.dir);
  return { path: bundle.dir, files, air: loadBundleAir(bundle.dir, files) };
}

/** Pure checks over the current bytes. GET never records a certification. */
export function assuranceView(root: string, id: string): ConsoleResponse<"assurance"> {
  const { path, files, air } = load(root, id);
  const current = certifyBundle(files, air);
  const targetChecks = targetKitCertificationChecks(files, air);
  current.checks.push(...targetChecks);
  if (targetChecks.some((check) => check.status === "failed")) current.status = "failed";
  const recorded = verifyCertification(files);
  return {
    path,
    bundleHash: current.bundleHash,
    status: current.status === "passed" ? "passed" : "failed",
    checks: current.checks,
    certification: {
      valid: recorded.ok,
      detail: recorded.ok
        ? "Passing static assurance matches the current bundle."
        : recorded.reason,
    },
    evidence: Object.values(executableEvidenceStatuses(files, current.bundleHash)),
  };
}

/** Only generator-owned paths and named evidence records are browsable.
 * Arbitrary workspace files (.env, credentials, source archives) are not exposed.
 * readBundleDir also refuses symlinks rather than following them.
 */
function artifactFiles(root: string, id: string): Record<string, string> {
  const { files, air } = load(root, id);
  const expected = generateBundle(
    air,
    resourceOptionsFromGenerationMetadata(files[GENERATION_METADATA_FILE]),
  ).files;
  const allowed = new Set([...Object.keys(expected), ...DERIVED_RECORD_FILES]);
  // Deployment configuration is browsable only after exact regeneration proves
  // it contains the strict, non-secret profile; invalid or tampered bytes stay private.
  const identity = listTargetKitVerifiers().find((verifier) => verifier.id === "identity");
  const verified = identity?.verify(air, files);
  if (verified?.ok) for (const path of verified.expectedFiles) allowed.add(path);
  const gemini = listTargetKitVerifiers().find((verifier) => verifier.id === "gemini-enterprise");
  const connector = gemini?.verify(air, files);
  if (
    connector?.ok &&
    connector.config &&
    "identityProfile" in connector.config &&
    IdentityProfile.safeParse(connector.config.identityProfile).success
  )
    for (const path of connector.expectedFiles) allowed.add(path);
  return Object.fromEntries(Object.entries(files).filter(([path]) => allowed.has(path)));
}

export function artifactsView(root: string, id: string): ConsoleResponse<"artifacts"> {
  return {
    files: Object.entries(artifactFiles(root, id))
      .map(([path, content]) => ({ path, bytes: Buffer.byteLength(content) }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  };
}

const PREVIEW_BYTES = 256 * 1024;
export function artifactView(root: string, id: string, path: string): ConsoleResponse<"artifact"> {
  const files = artifactFiles(root, id);
  if (!Object.hasOwn(files, path))
    throw notFound(`No generated artifact '${path}' in bundle '${id}'.`);
  const bytes = Buffer.from(files[path] as string, "utf8");
  if (bytes.length > 1024 * 1024)
    throw new ConsoleError(
      "console/artifact_too_large",
      413,
      "This artifact exceeds the 1 MiB preview limit. Open it from the bundle directory.",
    );
  // Text is returned as JSON and rendered as text, never as executable HTML.
  return {
    path,
    content: bytes.subarray(0, PREVIEW_BYTES).toString("utf8"),
    bytes: bytes.length,
    truncated: bytes.length > PREVIEW_BYTES,
  };
}
