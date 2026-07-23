import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  GENERATION_METADATA_FILE,
  type GeneratedBundle,
  readBundleDir,
  resourceOptionsFromGenerationMetadata,
  writeBundle,
} from "@anvil/generators";

export interface BundleInstallDeps {
  installStage?: (stageDir: string, destination: string) => void;
  removeBackup?: (backupDir: string) => void;
  onCleanupWarning?: (message: string) => void;
}

/**
 * Install generated roots as one same-filesystem rename transaction. Existing
 * output must prove it is an Anvil bundle; non-compiler-owned files are copied
 * forward, while generated roots are replaced exactly. A failed commit restores
 * the prior directory.
 */
export function installGeneratedBundle(
  destination: string,
  bundle: GeneratedBundle,
  deps: BundleInstallDeps = {},
): string[] {
  const outDir = resolve(destination);
  const parent = dirname(outDir);
  const name = basename(outDir);
  if (parent === outDir || !name || name === "." || name === "..") {
    throw new Error(`Refusing unsafe bundle output path: ${outDir}`);
  }
  if (outDir === resolve(process.cwd())) {
    throw new Error("Refusing to replace the current working directory; choose a bundle --out.");
  }
  mkdirSync(parent, { recursive: true });
  const replacing = existsSync(outDir);
  if (replacing) {
    const stat = lstatSync(outDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Bundle output must be a real directory, not a symlink: ${outDir}`);
    }
    assertManagedBundle(outDir);
  }

  const stageDir = hiddenSibling(outDir, "compile-stage");
  let backupDir: string | undefined;
  try {
    if (replacing) {
      cpSync(outDir, stageDir, { recursive: true, verbatimSymlinks: true });
      resetCompilerOwned(stageDir, bundle);
    }
    const written = writeBundle(stageDir, bundle);
    verifyGeneratedRoots(stageDir, bundle);
    if (replacing) {
      backupDir = hiddenSibling(outDir, "compile-backup");
      rmSync(backupDir, { recursive: true, force: true });
      renameSync(outDir, backupDir);
    }
    try {
      (deps.installStage ?? renameSync)(stageDir, outDir);
    } catch (installError) {
      if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
      if (backupDir && existsSync(backupDir)) {
        renameSync(backupDir, outDir);
        backupDir = undefined;
      }
      throw installError;
    }
    if (backupDir) {
      try {
        (deps.removeBackup ?? ((path) => rmSync(path, { recursive: true, force: true })))(
          backupDir,
        );
        backupDir = undefined;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        deps.onCleanupWarning?.(
          `Bundle installed successfully, but old backup cleanup failed; retained ${backupDir}: ${detail}`,
        );
      }
    }
    return written;
  } finally {
    if (existsSync(stageDir)) rmSync(stageDir, { recursive: true, force: true });
    // A backup is retained only if restoration itself could not complete.
  }
}

function hiddenSibling(outDir: string, purpose: string): string {
  const prefix = `.${basename(outDir)}.${purpose}-`;
  const candidate = mkdtempSync(join(dirname(outDir), prefix));
  if (dirname(candidate) !== dirname(outDir) || !basename(candidate).startsWith(prefix)) {
    rmSync(candidate, { recursive: true, force: true });
    throw new Error(`Refusing unsafe bundle transaction path: ${candidate}`);
  }
  return candidate;
}

function assertManagedBundle(outDir: string): void {
  if (existsSync(join(outDir, ".git"))) {
    throw new Error(`Refusing to replace repository root as a bundle: ${outDir}`);
  }
  const entries = readdirSync(outDir);
  if (entries.length === 0) return;
  // `compile --root <same-dir-as-out>` locks the source before generation, so
  // the not-yet-a-bundle directory legitimately contains only Anvil's private
  // source store. Preserve that store through the first atomic install; no
  // arbitrary unmanaged sibling is admitted by this exception.
  if (entries.length === 1 && entries[0] === ".anvil") {
    const sourceStore = lstatSync(join(outDir, ".anvil"));
    if (sourceStore.isDirectory() && !sourceStore.isSymbolicLink()) return;
  }
  const files = readBundleDir(outDir);
  if (
    files["air.yaml"] === undefined ||
    files["air.json"] === undefined ||
    files["package.json"] === undefined ||
    !resourceOptionsFromGenerationMetadata(files[GENERATION_METADATA_FILE])
  ) {
    throw new Error(
      `Refusing to replace unmanaged output directory ${outDir}; choose an empty --out or an existing Anvil bundle.`,
    );
  }
}

function resetCompilerOwned(stageDir: string, bundle: GeneratedBundle): void {
  const roots = new Set<string>();
  for (const rel of Object.keys(bundle.files)) {
    const slash = rel.indexOf("/");
    if (slash === -1) {
      rmSync(join(stageDir, rel), { recursive: true, force: true });
    } else {
      roots.add(rel.slice(0, slash));
    }
  }
  for (const root of roots) rmSync(join(stageDir, root), { recursive: true, force: true });
}

function verifyGeneratedRoots(stageDir: string, bundle: GeneratedBundle): void {
  const actual = readBundleDir(stageDir);
  const expectedPaths = Object.keys(bundle.files).sort();
  const drift = expectedPaths.filter((path) => actual[path] !== bundle.files[path]);
  if (drift.length > 0) {
    throw new Error(`Staged compile failed byte verification for ${drift.slice(0, 8).join(", ")}.`);
  }
  const ownedDirectories = new Set(
    expectedPaths.filter((path) => path.includes("/")).map((path) => path.split("/")[0]),
  );
  const ownedFiles = new Set(expectedPaths.filter((path) => !path.includes("/")));
  const unexpected = Object.keys(actual).filter((path) => {
    const root = path.split("/")[0] as string;
    return (ownedDirectories.has(root) || ownedFiles.has(path)) && bundle.files[path] === undefined;
  });
  if (unexpected.length > 0) {
    throw new Error(
      `Staged compile retained unexpected compiler-owned files: ${unexpected.slice(0, 8).join(", ")}.`,
    );
  }
}
