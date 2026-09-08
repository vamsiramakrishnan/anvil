import { operationInputSchema } from "@anvil/air";
import {
  bundleHash,
  certifyBundle,
  DERIVED_RECORD_FILES,
  executableEvidenceStatuses,
  generateBundle,
  loadBundleAir,
  readBundleDir,
  reprojectBundleAtomically,
  resourceOptionsFromGenerationMetadata,
  verifyCertification,
} from "@anvil/generators";
import { execute } from "@anvil/runtime";
import type { ConsoleResponse } from "../contract.js";
import { ConsoleError, notFound } from "./errors.js";
import { type Request, summarizeReprojection } from "./mutations.js";
import { findBundle } from "./workspace.js";

function snapshot(root: string, id: string) {
  const { dir } = findBundle(root, id);
  const files = readBundleDir(dir);
  return { dir, files, air: loadBundleAir(dir, files), hash: bundleHash(files) };
}

function assertCurrent(actual: string, expected: string) {
  if (actual !== expected) {
    throw new ConsoleError(
      "console/refused",
      409,
      "This bundle changed since you opened it. Refresh and review the current version before continuing.",
    );
  }
}

export function operationView(
  root: string,
  id: string,
  operationId: string,
): ConsoleResponse<"operation"> {
  const { air, hash } = snapshot(root, id);
  const operation = air.operations.find((op) => op.id === operationId);
  if (!operation) throw notFound(`No operation '${operationId}' in this bundle.`);
  return {
    bundleHash: hash,
    operation,
    inputSchema: operationInputSchema(operation),
    diagnostics: air.diagnostics.filter((d) => d.operationId === operationId),
  };
}

/** A hard-wired dry run. No credentials, observer, ledger, or live transport is installed. */
export async function previewOperation(
  root: string,
  id: string,
  operationId: string,
  body: Request<"preview">,
): Promise<ConsoleResponse<"preview">> {
  const { air, hash } = snapshot(root, id);
  assertCurrent(hash, body.bundleHash);
  const operation = air.operations.find((op) => op.id === operationId);
  if (!operation) throw notFound(`No operation '${operationId}' in this bundle.`);
  const baseUrl = air.service.servers[0]?.url;
  if (!baseUrl)
    throw new ConsoleError(
      "console/refused",
      409,
      "No server URL is declared in this bundle. Add one in the source or manifest and recompile.",
    );
  const result = await execute(
    operation,
    {
      input: body.input,
      confirm: body.confirm,
      idempotencyKey: body.idempotencyKey,
      dryRun: true,
    },
    {
      serviceId: air.service.id,
      baseUrl,
      transport: {
        send: async () => {
          throw new Error("Console previews cannot send upstream requests.");
        },
      },
    },
  );
  if (result.outcome === "error") {
    const error = result.envelope.error;
    throw new ConsoleError(error.code, 422, error.message, { issues: error.required_flags ?? [] });
  }
  if (result.outcome !== "dry_run")
    throw new Error("The runtime did not return a request preview.");
  return { bundleHash: hash, outcome: "dry_run", plan: result.plan };
}

/** Runs static checks in memory; does not issue a certification or execute a test lane. */
export function evidenceView(root: string, id: string): ConsoleResponse<"evidence"> {
  const { air, files, hash } = snapshot(root, id);
  const assessment = certifyBundle(files, air);
  const certification = verifyCertification(files);
  return {
    bundleHash: hash,
    staticStatus: assessment.status,
    checks: assessment.checks,
    certification: {
      valid: certification.ok,
      detail: certification.ok
        ? "Passing static assurance matches the current bundle."
        : certification.reason,
    },
    execution: Object.values(executableEvidenceStatuses(files, hash)),
  };
}

/** Only generator-owned paths and known evidence records may be browsed. */
function artifactSnapshot(root: string, id: string) {
  const current = snapshot(root, id);
  const options = resourceOptionsFromGenerationMetadata(current.files["generation.json"]);
  if (!options)
    throw new ConsoleError(
      "console/refused",
      409,
      "Generation metadata is missing or invalid. Recompile the bundle before browsing generated artifacts.",
    );
  const generated = generateBundle(current.air, options).files;
  const paths = Object.keys(current.files)
    .filter((path) => Object.hasOwn(generated, path) || DERIVED_RECORD_FILES.has(path))
    .sort();
  return { ...current, paths };
}

export function artifactsView(root: string, id: string): ConsoleResponse<"artifacts"> {
  const { files, hash, paths } = artifactSnapshot(root, id);
  return {
    bundleHash: hash,
    files: paths.map((path) => ({ path, bytes: Buffer.byteLength(files[path] ?? "") })),
  };
}

export function artifactView(root: string, id: string, path: string): ConsoleResponse<"artifact"> {
  const { files, paths } = artifactSnapshot(root, id);
  if (!paths.includes(path))
    throw notFound("This path is not a generated artifact or evidence record.");
  const content = files[path] ?? "";
  const bytes = Buffer.byteLength(content);
  if (bytes > 256 * 1024) {
    throw new ConsoleError(
      "console/refused",
      413,
      "This artifact exceeds the 256 KiB preview limit. Open it from the bundle directory.",
    );
  }
  return { path, content, bytes };
}

export function regenerateBundle(
  root: string,
  id: string,
  body: Request<"regenerate">,
): ConsoleResponse<"regenerate"> {
  const { dir, air, hash } = snapshot(root, id);
  assertCurrent(hash, body.bundleHash);
  return summarizeReprojection(reprojectBundleAtomically(dir, air));
}
