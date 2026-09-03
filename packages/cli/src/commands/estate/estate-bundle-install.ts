import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { type AirDocument, airFromJson } from "@anvil/air";
import {
  type FileSystemGatewayImportReceiptStore,
  type GatewayImportReceipt,
  GatewayImportReceiptView,
  isGatewayLifecycleArtifact,
  redactGatewayImportReceipt,
  verifyGatewayImportOutput,
  verifyGatewayImportOutputManifest,
} from "@anvil/compiler";
import {
  type GeneratedBundle,
  generateBundle,
  readBundleDir,
  writeBundle,
} from "@anvil/generators";
import { listProfiles, verifyTargetKit } from "@anvil/targets";

/**
 * Transactional installation of a generated gateway bundle.
 *
 * Moved verbatim out of `estate.ts`. It was already the right shape — no
 * `CliIO`, no Commander, a discriminated result carrying structured diagnostics —
 * it was simply unreachable from a test, being private to a 3,327-line module.
 * Thirteen of its error codes had no assertion anywhere in the workspace as a
 * result; `estate-bundle-install.test.ts` now covers them.
 *
 * The contract: stage the new bundle beside the target, verify the staged bytes
 * against the receipt's immutable manifest, and only then swap it in. An existing
 * directory is replaceable only when its own receipt view proves every file
 * belongs to an earlier generated bundle; files the receipt cannot account for
 * are never deleted, the install refuses instead. Two same-filesystem renames
 * form the commit, so an interrupted install leaves either the old complete
 * bundle or the new one and never a mixture.
 */

/** Injected so the backup-cleanup failure path is reachable from a test. */
export interface BundleInstallDeps {
  cleanupGatewayBundleBackup?: (path: string) => void;
}

export interface BundleInstallDiagnostic {
  level: "error" | "warning" | "info";
  code: string;
  message: string;
  path?: string;
}

interface BundleCommitResult {
  retainedBackup?: string;
  warning?: string;
}

export type PreparedBundleInstall =
  | {
      ok: true;
      written: string[];
      directory: string;
      commit: () => BundleCommitResult;
      rollback: () => void;
    }
  | { ok: false; diagnostics: BundleInstallDiagnostic[] };

/** Enumerate a bundle as relative POSIX file paths and refuse non-file nodes. */
export function listBundleFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path, relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      } else {
        throw new Error(`bundle contains unsupported filesystem node '${relativePath}'`);
      }
    }
  };
  visit(root, "");
  return files.sort();
}

export function exactFileSetDiagnostics(
  actual: readonly string[],
  expected: readonly string[],
  allowedAdded: ReadonlySet<string> = new Set(),
): BundleInstallDiagnostic[] {
  const diagnostics: BundleInstallDiagnostic[] = [];
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  for (const path of expectedSet) {
    if (!actualSet.has(path)) {
      diagnostics.push({
        level: "error",
        code: "gateway_receipt/output_missing",
        message: "Generated bundle is missing a recorded file.",
        path,
      });
    }
  }
  for (const path of actualSet) {
    if (!expectedSet.has(path) && !allowedAdded.has(path)) {
      diagnostics.push({
        level: "error",
        code: "gateway_receipt/output_added",
        message: "Generated bundle contains a file outside the receipt manifest.",
        path,
      });
    }
  }
  return diagnostics;
}

export interface GatewayLifecycleArtifacts {
  paths: Set<string>;
  diagnostics: BundleInstallDiagnostic[];
}

/**
 * Recognize post-import records and prove target-kit subtrees independently.
 * The `targets/` namespace is never trusted merely by name: only registered
 * profiles, regenerated exactly from canonical AIR, are safe to preserve or
 * ignore as lifecycle state. Every registered profile is recognized the same
 * way Gemini Enterprise always was.
 */
export function gatewayLifecycleArtifacts(
  files: Record<string, string>,
  air: AirDocument,
): GatewayLifecycleArtifacts {
  const paths = new Set(Object.keys(files).filter((path) => isGatewayLifecycleArtifact(path)));
  const diagnostics: BundleInstallDiagnostic[] = [];
  const targetPaths = Object.keys(files).filter((path) => path.startsWith("targets/"));
  const targetIds = new Set(
    targetPaths
      .map((path) => /^targets\/([^/]+)\//.exec(path)?.[1])
      .filter((targetId): targetId is string => targetId !== undefined),
  );
  for (const profile of listProfiles()) {
    if (!targetIds.has(profile.id)) continue;

    targetIds.delete(profile.id);
    const verification = verifyTargetKit(air, profile, files);
    if (!verification.ok) {
      diagnostics.push(
        ...verification.findings.map((finding) => ({
          level: "error" as const,
          code: "gateway_receipt/unverified_target",
          message: finding.detail,
          path: finding.path,
        })),
      );
      continue;
    }
    for (const path of verification.actualFiles) paths.add(path);
  }
  for (const targetId of targetIds) {
    diagnostics.push({
      level: "error",
      code: "gateway_receipt/unverified_target",
      message: `Target subtree '${targetId}' is not a recognized, independently verifiable lifecycle artifact; refusing to ignore or delete it.`,
      path: `targets/${targetId}`,
    });
  }
  for (const path of targetPaths) {
    if (!/^targets\/[^/]+\//.test(path)) {
      diagnostics.push({
        level: "error",
        code: "gateway_receipt/unverified_target",
        message: "Target artifact has no verifiable target-profile subtree.",
        path,
      });
    }
  }
  return { paths, diagnostics };
}

function verifyBundleDirectory(
  root: string,
  receipt: GatewayImportReceipt,
  expectedFiles: readonly string[],
): BundleInstallDiagnostic[] {
  const diagnostics = exactFileSetDiagnostics(listBundleFiles(root), expectedFiles);
  const files = new Map<string, Uint8Array>();
  for (const expected of receipt.output.files) {
    const path = join(root, expected.path);
    if (existsSync(path)) files.set(expected.path, readFileSync(path));
  }
  diagnostics.push(...verifyGatewayImportOutput(receipt, files).diagnostics);
  try {
    const view = GatewayImportReceiptView.parse(
      JSON.parse(readFileSync(join(root, "import.receipt.json"), "utf8")),
    );
    if (view.importId !== receipt.importId || view.receiptDigest !== receipt.digest) {
      diagnostics.push({
        level: "error",
        code: "gateway_receipt/bundle_receipt_mismatch",
        message: "Bundle receipt view does not identify the private receipt.",
        path: "import.receipt.json",
      });
    }
  } catch (err) {
    diagnostics.push({
      level: "error",
      code: "gateway_receipt/bundle_receipt_unparseable",
      message: `Bundle import.receipt.json is not a valid receipt view: ${(err as Error).message}`,
      path: "import.receipt.json",
    });
  }
  return diagnostics;
}

/**
 * Stage and verify a complete bundle, then swap it into place. An existing
 * directory is replaceable only when its prior receipt view proves every file
 * belongs to an earlier generated bundle; unknown files are never deleted.
 */
export async function prepareBundleInstall(
  outDir: string,
  bundle: GeneratedBundle,
  receipt: GatewayImportReceipt,
  store: FileSystemGatewayImportReceiptStore,
  workspaceRoot: string,
  replaceDerived = false,
  deps: BundleInstallDeps = {},
): Promise<PreparedBundleInstall> {
  const directory = resolve(outDir);
  const parent = dirname(directory);
  const name = basename(directory);
  if (!name || directory === parent) {
    return {
      ok: false,
      diagnostics: [
        {
          level: "error",
          code: "gateway_receipt/unsafe_output_path",
          message: `Refusing to install a generated bundle at broad path '${directory}'.`,
        },
      ],
    };
  }
  let stage: string | undefined;
  let backup: string | undefined;
  let installed = false;
  try {
    mkdirSync(parent, { recursive: true });
    stage = mkdtempSync(join(parent, `.${name}.anvil-stage-`));
    const written = writeBundle(stage, bundle);
    const expected = Object.keys(bundle.files).sort();
    const stageDiagnostics = verifyBundleDirectory(stage, receipt, expected);
    if (stageDiagnostics.length > 0) return { ok: false, diagnostics: stageDiagnostics };

    if (existsSync(directory)) {
      if (!statSync(directory).isDirectory()) {
        return {
          ok: false,
          diagnostics: [
            {
              level: "error",
              code: "gateway_receipt/output_not_directory",
              message: `Bundle output '${directory}' exists and is not a directory.`,
            },
          ],
        };
      }
      let priorView: GatewayImportReceiptView;
      try {
        priorView = GatewayImportReceiptView.parse(
          JSON.parse(readFileSync(join(directory, "import.receipt.json"), "utf8")),
        );
      } catch {
        return {
          ok: false,
          diagnostics: [
            {
              level: "error",
              code: "gateway_receipt/unmanaged_output",
              message:
                "Existing output has no valid gateway receipt view; refusing to replace or delete its files.",
              path: directory,
            },
          ],
        };
      }
      const priorReceipt = await store.verify(priorView.importId);
      const expectedPriorView = priorReceipt.receipt
        ? redactGatewayImportReceipt(priorReceipt.receipt, { workspaceRoot })
        : undefined;
      const normalizedPriorView =
        priorView.lineage.status === "stale"
          ? { ...priorView, lineage: { status: "bound" as const } }
          : priorView;
      if (
        !priorReceipt.ok ||
        priorView.receiptDigest !== priorReceipt.receipt?.digest ||
        JSON.stringify(normalizedPriorView) !== JSON.stringify(expectedPriorView)
      ) {
        return {
          ok: false,
          diagnostics: [
            {
              level: "error",
              code: "gateway_receipt/untrusted_output",
              message:
                "Existing output receipt view is not backed by the intact private receipt in this workspace; refusing to replace or delete its files.",
              path: directory,
            },
          ],
        };
      }
      const priorIdentity = priorReceipt.receipt?.selection.identity;
      const candidateIdentity = receipt.selection.identity;
      if (
        !priorIdentity ||
        !candidateIdentity ||
        priorIdentity.digest !== candidateIdentity.digest
      ) {
        const describe = (identity: GatewayImportReceipt["selection"]["identity"]): string =>
          identity
            ? `${identity.vendor}/${identity.gatewayId}/${identity.apiId}/${identity.environment}/${identity.revision} (${identity.digest})`
            : "legacy receipt without a first-class gateway identity";
        return {
          ok: false,
          diagnostics: [
            {
              level: "error",
              code: "gateway_receipt/output_identity_collision",
              message:
                `Existing output belongs to ${describe(priorIdentity)}, but this import is ${describe(candidateIdentity)}. ` +
                "A different vendor/gateway/API/environment/revision/export lineage may never replace this directory. Omit --out for the collision-safe default, or choose a new --out directory.",
              path: directory,
            },
          ],
        };
      }
      if (priorIdentity.lineageDigest !== candidateIdentity.lineageDigest && !replaceDerived) {
        return {
          ok: false,
          diagnostics: [
            {
              level: "error",
              code: "gateway_receipt/evidence_transition_requires_replace",
              message:
                `The stable gateway coordinate is unchanged (${candidateIdentity.digest}), but export/inventory evidence changed from ${priorIdentity.lineageDigest} to ${candidateIdentity.lineageDigest}. ` +
                "Review the estate diff, then re-run with --replace-derived to accept this verified lineage transition. A changed unrelated API will not change the default output path.",
              path: directory,
            },
          ],
        };
      }
      const existingFiles = readBundleDir(directory);
      if (priorView.lineage.status === "bound" && priorReceipt.receipt) {
        const priorOutputFiles = new Map<string, Uint8Array>();
        for (const expected of priorReceipt.receipt.output.files) {
          const path = join(directory, expected.path);
          if (existsSync(path)) priorOutputFiles.set(expected.path, readFileSync(path));
        }
        const priorOutputIntegrity = verifyGatewayImportOutput(
          priorReceipt.receipt,
          priorOutputFiles,
        );
        if (!priorOutputIntegrity.ok) {
          return {
            ok: false,
            diagnostics: [
              {
                level: "error",
                code: "gateway_receipt/prior_output_changed",
                message:
                  "Existing receipt-bound output no longer matches its immutable manifest; refusing a lineage transition or replacement.",
                path: directory,
              },
              ...priorOutputIntegrity.diagnostics,
            ],
          };
        }
      }
      let existingAir: AirDocument;
      try {
        existingAir = airFromJson(existingFiles["air.json"] ?? "");
      } catch (err) {
        return {
          ok: false,
          diagnostics: [
            {
              level: "error",
              code: "gateway_receipt/output_air_unreadable",
              message: `Existing canonical AIR cannot validate lifecycle artifacts: ${err instanceof Error ? err.message : String(err)}`,
              path: "air.json",
            },
          ],
        };
      }
      const recognizedLifecycle = gatewayLifecycleArtifacts(existingFiles, existingAir);
      if (recognizedLifecycle.diagnostics.length > 0) {
        return { ok: false, diagnostics: recognizedLifecycle.diagnostics };
      }
      if (priorView.lineage.status === "stale") {
        if (!replaceDerived) {
          return {
            ok: false,
            diagnostics: [
              {
                level: "error",
                code: "gateway_receipt/stale_output_requires_replace",
                message:
                  "Existing output was deliberately changed after gateway import. Re-run with --replace-derived to discard the derived approval state after its recorded digest is verified.",
                path: directory,
              },
            ],
          };
        }
        const generatedPaths = new Set(Object.keys(generateBundle(existingAir).files));
        const untrustedPaths = priorView.lineage.currentOutputFiles
          .map((file) => file.path)
          .filter((path) => !generatedPaths.has(path) && !recognizedLifecycle.paths.has(path));
        if (untrustedPaths.length > 0) {
          return {
            ok: false,
            diagnostics: [
              {
                level: "error",
                code: "gateway_receipt/stale_manifest_untrusted_path",
                message:
                  "The stale-lineage manifest names files that are neither deterministic compiler output nor independently recognized lifecycle artifacts; refusing to delete them.",
                path: untrustedPaths[0],
              },
            ],
          };
        }
        const currentFiles = new Map<string, Uint8Array>();
        for (const expected of priorView.lineage.currentOutputFiles) {
          const path = join(directory, expected.path);
          if (existsSync(path)) currentFiles.set(expected.path, readFileSync(path));
        }
        const currentIntegrity = verifyGatewayImportOutputManifest(
          {
            digest: priorView.lineage.currentOutputDigest,
            files: priorView.lineage.currentOutputFiles,
          },
          currentFiles,
        );
        if (!currentIntegrity.ok) {
          return {
            ok: false,
            diagnostics: [
              {
                level: "error",
                code: "gateway_receipt/stale_output_changed",
                message: `Existing derived output no longer matches the exact staged state recorded at approval: ${currentIntegrity.diagnostics.map((diagnostic) => `${diagnostic.path ? `${diagnostic.path}: ` : ""}${diagnostic.message}`).join("; ")}`,
                path: directory,
              },
            ],
          };
        }
        for (const file of priorView.lineage.currentOutputFiles) {
          recognizedLifecycle.paths.add(file.path);
        }
      }
      const priorExpected = [
        ...priorView.output.files.map((file) => file.path),
        "import.receipt.json",
      ].sort();
      const extras = exactFileSetDiagnostics(
        listBundleFiles(directory),
        priorExpected,
        recognizedLifecycle.paths,
      ).filter((diagnostic) => diagnostic.code === "gateway_receipt/output_added");
      if (extras.length > 0) return { ok: false, diagnostics: extras };

      if (!replaceDerived && recognizedLifecycle.paths.size > 0) {
        let candidateAir: AirDocument;
        try {
          candidateAir = airFromJson(bundle.files["air.json"] ?? "");
        } catch (err) {
          return {
            ok: false,
            diagnostics: [
              {
                level: "error",
                code: "gateway_receipt/candidate_air_unreadable",
                message: `Candidate canonical AIR cannot validate lifecycle artifacts: ${err instanceof Error ? err.message : String(err)}`,
                path: "air.json",
              },
            ],
          };
        }
        const compatibleLifecycle = gatewayLifecycleArtifacts(existingFiles, candidateAir);
        if (compatibleLifecycle.diagnostics.length > 0) {
          return {
            ok: false,
            diagnostics: compatibleLifecycle.diagnostics.map((diagnostic) => ({
              ...diagnostic,
              code: "gateway_receipt/lifecycle_incompatible",
              message: `${diagnostic.message} Move or remove the artifact, or re-run with --replace-derived to discard verified derived state.`,
            })),
          };
        }
        const expectedSet = new Set(expected);
        for (const relativePath of compatibleLifecycle.paths) {
          if (expectedSet.has(relativePath)) {
            return {
              ok: false,
              diagnostics: [
                {
                  level: "error",
                  code: "gateway_receipt/lifecycle_collision",
                  message:
                    "A lifecycle artifact collides with a compiler-owned candidate file; refusing replacement.",
                  path: relativePath,
                },
              ],
            };
          }
          const destination = join(stage, relativePath);
          mkdirSync(dirname(destination), { recursive: true });
          copyFileSync(join(directory, relativePath), destination);
          written.push(relativePath);
        }
      }

      backup = mkdtempSync(join(parent, `.${name}.anvil-previous-`));
      rmSync(backup, { recursive: true, force: true });
      renameSync(directory, backup);
    }
    try {
      renameSync(stage, directory);
      installed = true;
    } catch (err) {
      if (backup && existsSync(backup) && !existsSync(directory)) renameSync(backup, directory);
      throw err;
    }

    let closed = false;
    return {
      ok: true,
      written,
      directory,
      commit: () => {
        if (closed) return {};
        closed = true;
        if (!backup) return {};
        try {
          (
            deps.cleanupGatewayBundleBackup ??
            ((path: string) => rmSync(path, { recursive: true, force: true }))
          )(backup);
          return {};
        } catch (err) {
          const retainedBackup = existsSync(backup) ? backup : undefined;
          const detail = err instanceof Error ? err.message : String(err);
          return {
            retainedBackup,
            warning: retainedBackup
              ? `The new gateway bundle was installed successfully, but the previous bundle backup could not be removed and remains at ${retainedBackup}: ${detail}`
              : `The new gateway bundle was installed successfully, but backup cleanup reported an error: ${detail}`,
          };
        }
      },
      rollback: () => {
        if (closed) return;
        rmSync(directory, { recursive: true, force: true });
        if (backup && existsSync(backup)) renameSync(backup, directory);
        closed = true;
      },
    };
  } catch (err) {
    if (backup && existsSync(backup) && !existsSync(directory)) renameSync(backup, directory);
    return {
      ok: false,
      diagnostics: [
        {
          level: "error",
          code: "gateway_receipt/output_install_failed",
          message: err instanceof Error ? err.message : String(err),
          path: directory,
        },
      ],
    };
  } finally {
    if (!installed && stage) rmSync(stage, { recursive: true, force: true });
  }
}
