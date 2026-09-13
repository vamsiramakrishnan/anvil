import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { type BusinessPlan, BusinessProject, hashCanonical } from "@anvil/air";
import { compileBusiness } from "@anvil/compiler";
import { generateBundle, writeBundle } from "@anvil/generators";
import { businessImpact } from "./impact.js";

export { BusinessProject } from "@anvil/air";
export interface ProjectRevision {
  digest: string;
  project: BusinessProject;
}

/** All project data stays below a real workspace directory. Refuse symlink components. */
export function businessProjectPath(root: string, ...parts: string[]): string {
  const base = resolve(root);
  const path = resolve(base, ...parts);
  const rel = relative(base, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || resolve(base, rel) !== path)
    throw new Error("Project path escapes the workspace.");
  let current = base;
  for (const part of ["", ...rel.split(sep).filter(Boolean)]) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink())
        throw new Error("Project paths cannot contain symlinks.");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  return path;
}
export function projectDirectory(root: string, id: string): string {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw new Error("Invalid business project id.");
  return businessProjectPath(root, ".anvil", "projects", id);
}
export function atomicBusinessJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporary, path);
    const directory = openSync(dirname(path), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}
export function validateBusinessProject(raw: unknown): ProjectRevision & { plan: BusinessPlan } {
  const project = BusinessProject.parse(raw);
  const { plan } = compileBusiness(project.definition, project.sources);
  const ids = project.tasks.map((t) => t.id);
  if (new Set(ids).size !== ids.length) throw new Error("Evaluation task ids must be unique.");
  for (const task of project.tasks)
    if (!project.definition.actions.some((a) => a.id === task.action))
      throw new Error(`Unknown evaluation action ${task.action}.`);
  return { project, digest: hashCanonical(project), plan };
}
export function readBusinessProject(root: string, id: string, digest?: string): ProjectRevision {
  const dir = projectDirectory(root, id);
  if (digest !== undefined && !/^[a-f0-9]{64}$/.test(digest))
    throw new Error("Invalid revision digest.");
  const path = businessProjectPath(root, dir, digest ? `revisions/${digest}.json` : "project.json");
  const raw = JSON.parse(readFileSync(path, "utf8")) as ProjectRevision;
  const checked = validateBusinessProject(raw.project);
  if (
    raw.digest !== checked.digest ||
    (digest && digest !== checked.digest) ||
    checked.project.definition.id !== id
  )
    throw new Error("Business project revision is corrupt or belongs to another project.");
  return { project: checked.project, digest: checked.digest };
}
export function listBusinessProjects(
  root: string,
): Array<{ id: string; name: string; digest: string; actions: number }> {
  const dir = businessProjectPath(root, ".anvil/projects");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const { project, digest } = readBusinessProject(root, e.name);
      return {
        id: e.name,
        name: project.definition.displayName,
        digest,
        actions: project.definition.actions.length,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}
/** Compare-and-swap revisions; a second browser/CLI cannot silently overwrite a review. */
export function saveBusinessProject(
  root: string,
  raw: unknown,
  expectedDigest: string | null,
): ProjectRevision {
  const { project, digest } = validateBusinessProject(raw);
  const dir = projectDirectory(root, project.definition.id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = businessProjectPath(root, dir, "write.lock");
  mkdirSync(lock);
  try {
    const head = businessProjectPath(root, dir, "project.json");
    const prior = existsSync(head) ? readBusinessProject(root, project.definition.id) : undefined;
    if ((prior?.digest ?? null) !== expectedDigest)
      throw new Error("Project changed. Reload and review the current revision before saving.");
    const revision = { project, digest };
    const snapshot = businessProjectPath(root, dir, `revisions/${digest}.json`);
    atomicBusinessJson(snapshot, revision);
    atomicBusinessJson(head, revision);
    return revision;
  } finally {
    rmSync(lock, { recursive: true });
  }
}
export function buildBusinessProject(
  root: string,
  id: string,
  expectedDigest: string,
): { bundleId: string; digest: string; planDigest: string } {
  const revision = readBusinessProject(root, id);
  if (revision.digest !== expectedDigest)
    throw new Error("Project changed. Review the current revision before building.");
  const { air, plan } = compileBusiness(revision.project.definition, revision.project.sources);
  const bundleId = `generated/${id}-${revision.digest.slice(0, 12)}`;
  const destination = businessProjectPath(root, bundleId);
  mkdirSync(dirname(destination), { recursive: true });
  mkdirSync(destination); // Never replace a reviewed bundle, even when a build races.
  try {
    writeBundle(destination, generateBundle(air, { businessPlan: plan }));
  } catch (e) {
    rmSync(destination, { recursive: true, force: true });
    throw e;
  }
  return { bundleId, digest: revision.digest, planDigest: plan.digest };
}
export function businessProjectView(revision: ProjectRevision, previous?: ProjectRevision) {
  const { air, plan } = compileBusiness(revision.project.definition, revision.project.sources);
  return {
    ...revision,
    planDigest: plan.digest,
    public: { service: air.service, business: air.business, operations: air.operations },
    impact: previous ? businessImpact(previous.project, revision.project) : null,
  };
}
