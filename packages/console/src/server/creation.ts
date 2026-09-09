import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  compileSource,
  FileSystemSourceSnapshotStore,
  FilesystemSourceImporter,
  SourceService,
} from "@anvil/compiler";
import {
  bundleHash,
  certifyBundle,
  executableEvidenceStatuses,
  generateBundle,
  installGeneratedBundle,
  loadBundleAir,
  readBundleDir,
  verifyCertification,
} from "@anvil/generators";
import type { ConsoleResponse } from "../contract.js";
import { ConsoleError, invalidRequest } from "./errors.js";
import type { Request } from "./mutations.js";
import { findBundle, resolveInsideRoot } from "./workspace.js";

/** Compile through the same locked-source and transactional installation path as the CLI. */
export async function createBundle(
  root: string,
  body: Request<"createBundle">,
): Promise<ConsoleResponse<"createBundle">> {
  if (existsSync(join(root, "air.yaml")) || existsSync(join(root, "air.json"))) {
    throw invalidRequest("Open the parent workspace to create another bundle.", [
      "Run anvil console on a directory containing your bundles.",
    ]);
  }
  const id = `generated/${body.name}`;
  const destination = resolveInsideRoot(root, id);
  if (existsSync(destination))
    throw new ConsoleError(
      "console/destination_exists",
      409,
      `Bundle '${id}' already exists. Choose a new name to keep both versions for comparison.`,
    );

  let uploadDir: string | undefined;
  try {
    let target: string;
    let entrypoint: string | undefined;
    if (body.input.kind === "upload") {
      const paths = body.input.files.map((file) => file.path);
      if (new Set(paths).size !== paths.length || !paths.includes(body.input.entrypoint)) {
        throw invalidRequest(
          "Choose an uploaded entrypoint and give every file a unique path.",
          [],
        );
      }
      const scratch = resolveInsideRoot(root, ".anvil/console/uploads");
      mkdirSync(scratch, { recursive: true });
      uploadDir = mkdtempSync(join(scratch, "source-"));
      for (const file of body.input.files) {
        const path = resolveInsideRoot(uploadDir, file.path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, file.content, { flag: "wx", mode: 0o600 });
      }
      // Import the directory to preserve sibling and parent-relative references.
      target = uploadDir;
      entrypoint = body.input.entrypoint;
    } else {
      target = resolveInsideRoot(root, body.input.path);
      entrypoint = body.input.entrypoint;
    }
    const store = resolveInsideRoot(root, ".anvil/sources");
    const service = new SourceService({
      importer: new FilesystemSourceImporter(),
      store: new FileSystemSourceSnapshotStore(store),
    });
    const added = await service.add([target], { name: body.name });
    if (!added.dir || added.snapshot?.status !== "valid") {
      throw invalidRequest(
        "The source could not be compiled. Fix the source diagnostics and try again.",
        added.diagnostics.map((d) => `${d.code}: ${d.message}`),
      );
    }
    const resolved = await service.compilerSource(added.snapshot.snapshotId, entrypoint);
    if (!resolved.source)
      throw invalidRequest(
        "Choose a compilable entrypoint.",
        resolved.diagnostics.map((d) => `${d.code}: ${d.message}`),
      );
    const air = await compileSource(resolved.source, {
      serviceId: body.name,
      manifest: body.manifest,
      humanApproval: body.humanApproval,
    });
    const bundle = generateBundle(air);
    // No await between exclusive directory reservation and installation. The
    // create route never replaces a pre-existing bundle, even on concurrent POSTs.
    resolveInsideRoot(root, id);
    mkdirSync(dirname(destination), { recursive: true });
    try {
      mkdirSync(destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new ConsoleError(
          "console/destination_exists",
          409,
          `Bundle '${id}' already exists. Choose a new name.`,
        );
      throw error;
    }
    try {
      const written = installGeneratedBundle(destination, bundle);
      return {
        id,
        snapshotId: added.snapshot.snapshotId,
        generatedFiles: written.length,
        operations: air.operations.length,
        diagnostics: air.diagnostics,
      };
    } catch (error) {
      rmSync(destination, { recursive: true, force: true });
      throw error;
    }
  } finally {
    if (uploadDir) rmSync(uploadDir, { recursive: true, force: true });
  }
}

export function evidenceView(root: string, id: string): ConsoleResponse<"evidence"> {
  const bundle = findBundle(root, id);
  const files = readBundleDir(bundle.dir);
  const air = loadBundleAir(bundle.dir, files);
  const certification = verifyCertification(files);
  return {
    bundleHash: bundleHash(files),
    staticChecks: certifyBundle(files, air).checks,
    certification: {
      valid: certification.ok,
      detail: certification.ok
        ? "Passing static assurance matches the current bundle."
        : certification.reason,
    },
    executable: Object.values(executableEvidenceStatuses(files)),
  };
}
