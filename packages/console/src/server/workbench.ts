import {
  bundleHash,
  loadBundleAir,
  readBundleDir,
  reprojectBundleAtomically,
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

export function regenerateBundle(
  root: string,
  id: string,
  body: Request<"regenerate">,
): ConsoleResponse<"regenerate"> {
  const { dir, air, hash } = snapshot(root, id);
  assertCurrent(hash, body.bundleHash);
  return summarizeReprojection(reprojectBundleAtomically(dir, air));
}
