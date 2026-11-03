/** Shared atomic target-kit installation used by every authoring surface. */
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { TargetKitFile } from "./model.js";

/** Filesystem commit seam used to prove rollback without monkeypatching node:fs. */
export interface TargetKitInstallDeps {
  backupTarget?: (targetDir: string, backupDir: string) => void;
  installStagedTarget?: (stageDir: string, targetDir: string) => void;
  cleanupTargetBackup?: (backupDir: string) => void;
}

export interface TargetWriteResult {
  targetDir: string;
  warnings: string[];
  retainedBackupDir?: string;
}

/**
 * Build the complete target subtree in a hidden sibling, then swap it into
 * place. A failed write leaves the previous generated target intact.
 *
 * `onBeforeInstall`, when given, runs against the staged directory (which is
 * about to become `targetDir`) before the atomic swap — e.g. migrating
 * legacy in-target mutable state out to external storage. Profiles with no
 * mutable state of their own simply omit it.
 */
export function writeTargetKitAtomically(
  outRoot: string,
  profileId: string,
  files: TargetKitFile[],
  deps: TargetKitInstallDeps,
  onBeforeInstall?: (targetDir: string) => void,
): TargetWriteResult {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(profileId)) throw new Error("Invalid target profile id");
  const targetsRoot = join(outRoot, "targets");
  if (existsSync(targetsRoot) && lstatSync(targetsRoot).isSymbolicLink())
    throw new Error("Target root must not be a symlink");
  const targetDir = join(targetsRoot, profileId);
  mkdirSync(targetsRoot, { recursive: true });
  const stageDir = mkdtempSync(join(targetsRoot, `.${profileId}.stage-`));
  const expectedPrefix = `targets/${profileId}/`;
  const stageRoot = `${resolve(stageDir)}${sep}`;

  try {
    for (const file of files) {
      if (!file.path.startsWith(expectedPrefix)) {
        throw new Error(`Target kit file escapes ${expectedPrefix}: ${file.path}`);
      }
      const dest = resolve(stageDir, file.path.slice(expectedPrefix.length));
      if (!dest.startsWith(stageRoot)) {
        throw new Error(`Target kit file escapes its staging directory: ${file.path}`);
      }
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, file.bytes);
    }
    onBeforeInstall?.(targetDir);
  } catch (error) {
    rmSync(stageDir, { recursive: true, force: true });
    throw error;
  }

  return commitStagedTarget(stageDir, targetDir, deps);
}

function commitStagedTarget(
  stageDir: string,
  targetDir: string,
  deps: TargetKitInstallDeps,
): TargetWriteResult {
  const backupDir = `${stageDir}.previous`;
  const hadPrevious = existsSync(targetDir);
  let previousMoved = false;
  try {
    if (hadPrevious) {
      (deps.backupTarget ?? renameSync)(targetDir, backupDir);
      previousMoved = true;
    }
    (deps.installStagedTarget ?? renameSync)(stageDir, targetDir);
  } catch (error) {
    if (existsSync(stageDir)) rmSync(stageDir, { recursive: true, force: true });
    // An injectable/custom installer may have created some or all of targetDir
    // before throwing. That candidate is never authoritative: remove it before
    // restoring the exact previous subtree (or leave no target on first install).
    if ((!hadPrevious || previousMoved) && existsSync(targetDir))
      rmSync(targetDir, { recursive: true, force: true });
    if (previousMoved && existsSync(backupDir)) {
      renameSync(backupDir, targetDir);
    }
    throw error;
  }
  const warnings: string[] = [];
  let retainedBackupDir: string | undefined;
  if (hadPrevious) {
    try {
      (
        deps.cleanupTargetBackup ??
        ((path: string) => rmSync(path, { recursive: true, force: true }))
      )(backupDir);
    } catch (error) {
      if (existsSync(backupDir)) retainedBackupDir = backupDir;
      const detail = error instanceof Error ? error.message : String(error);
      warnings.push(
        retainedBackupDir
          ? `The new target was installed successfully, but the previous target backup could not be removed and was retained at ${retainedBackupDir}: ${detail}`
          : `The new target was installed successfully, but backup cleanup reported an error: ${detail}`,
      );
    }
  }
  return { targetDir, warnings, retainedBackupDir };
}

/** Install a reviewed group of target kits as one filesystem transaction. */
export function writeTargetKitsAtomically(
  outRoot: string,
  files: TargetKitFile[],
  deps: TargetKitInstallDeps = {},
): TargetWriteResult {
  if (!files.length) throw new Error("No target kit files were supplied");
  const targetDir = join(outRoot, "targets");
  const stageDir = mkdtempSync(join(outRoot, ".targets.stage-"));
  try {
    if (existsSync(targetDir)) copyTargetTree(targetDir, stageDir);
    const groups = new Set<string>();
    const paths = new Set<string>();
    for (const file of files) {
      const match = /^targets\/([a-z0-9][a-z0-9-]*)\/(.+)$/.exec(file.path);
      if (!match?.[1] || !match[2] || paths.has(file.path))
        throw new Error("Invalid or duplicate target kit path");
      const profileId = match[1];
      paths.add(file.path);
      if (!groups.has(profileId)) {
        rmSync(join(stageDir, profileId), { recursive: true, force: true });
        groups.add(profileId);
      }
      const prefix = `${resolve(stageDir, profileId)}${sep}`;
      const dest = resolve(stageDir, profileId, match[2]);
      if (!dest.startsWith(prefix)) throw new Error("Target kit path escapes its profile");
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, file.bytes);
    }
  } catch (error) {
    rmSync(stageDir, { recursive: true, force: true });
    throw error;
  }
  return commitStagedTarget(stageDir, targetDir, deps);
}

function copyTargetTree(source: string, destination: string): void {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error("Target directories must be real directories");
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) copyTargetTree(from, to);
    else if (entry.isFile()) copyFileSync(from, to);
    else throw new Error("Target kits must not contain symlinks or special files");
  }
}
