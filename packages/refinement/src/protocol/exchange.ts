import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AirDocument } from "@anvil/air";
import type { Deficiency } from "../deficiency.js";
import { packFiles, type RefinementPack } from "../pack.js";
import { buildRefinementPlan } from "../plan.js";
import { GROUP_PATCH_KEYS } from "../skills/group-proposal.js";
import { skillFor } from "../skills/registry.js";
import { targetKey } from "../target.js";
import type { GroupRoutingDelta } from "./group.js";
import { admitOrRefuse, clusterDeficiency, groupDeltaClaim, scoreGroupProposal } from "./group.js";
import { importHarnessSubmission } from "./import.js";
import { resolveRepositoryRevision } from "./repository.js";
import type { RefinementTask } from "./schema.js";
import { createRefinementTask } from "./task.js";

/**
 * The file exchange with a coding harness: one hash-bound task OUT, one
 * measured refinement pack IN. `createRefinementTask` and
 * `importHarnessSubmission` are the protocol; this module is the glue that
 * used to live in `anvil refine export-task` / `import-proposal` — choosing
 * the deficiency a target key names, resolving the repository revision,
 * writing the task file, scoring a group proposal on the way in, and laying a
 * pack directory down without ever replacing a file with different bytes — so
 * that any caller (the CLI, a console) exports and imports through exactly the
 * same steps and produces exactly the same files.
 */

/* --------------------------------- files ---------------------------------- */

/**
 * Write a file unless one already exists with different content, in which case
 * refuse. Rewriting identical bytes is fine (idempotent re-export); replacing a
 * task or pack a reviewer may already be reading is not.
 */
function writeWithoutReplacingDifferent(path: string, contents: string): void {
  if (existsSync(path)) {
    const current = readFileSync(path, "utf8");
    if (current !== contents) {
      throw new Error(`Refusing to replace existing '${path}' with different content.`);
    }
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
}

/* --------------------------------- export --------------------------------- */

export interface SelectTaskDeficiencyOptions {
  /** Select a skill when one target has multiple deficiencies. */
  skill?: string;
  /** Observed-capability report whose groupings ride into a GROUP task. */
  trafficReportPath?: string;
  /** How the caller named the bundle, for the hint in the "nothing to export" error. */
  displayPath?: string;
}

/**
 * Resolve a target key to the one deficiency a task will be exported for.
 * `group:<cluster-id>` keys are derived from the benchmark report beside the
 * bundle (a derived record the pure-over-AIR detectors cannot produce); every
 * other key is looked up in the deterministic refinement plan and must name
 * exactly one skill.
 */
export function selectTaskDeficiency(
  air: AirDocument,
  bundleDir: string,
  key: string,
  opts: SelectTaskDeficiencyOptions = {},
): Deficiency {
  if (key.startsWith("group:")) {
    return clusterDeficiency(air, bundleDir, key.slice("group:".length), opts.trafficReportPath);
  }
  if (opts.trafficReportPath) {
    throw new Error("--traffic-report only applies to group targets (group:<cluster-id>).");
  }
  const plan = buildRefinementPlan(air);
  const candidates = plan.deficiencies.filter((deficiency) => {
    const skill = skillFor(deficiency.code);
    return (
      targetKey(deficiency.target) === key &&
      skill !== undefined &&
      (opts.skill === undefined || skill.name === opts.skill)
    );
  });
  const bySkill = new Map(
    candidates.flatMap((deficiency) => {
      const skill = skillFor(deficiency.code);
      return skill ? ([[skill.name, deficiency]] as const) : [];
    }),
  );
  if (bySkill.size === 0) {
    throw new Error(
      `No investigable deficiency at target '${key}'${opts.skill ? ` for skill '${opts.skill}'` : ""}. Run \`anvil case list ${opts.displayPath ?? bundleDir}\`.`,
    );
  }
  if (bySkill.size > 1) {
    throw new Error(
      `Target '${key}' has multiple skills (${[...bySkill.keys()].join(", ")}); select one with --skill.`,
    );
  }
  const deficiency = bySkill.values().next().value;
  if (!deficiency) throw new Error(`No deficiency selected for target '${key}'.`);
  return deficiency;
}

export interface ExportRefinementTaskOptions {
  /** Git repository the harness may inspect; its HEAD revision is bound into the task. */
  repositoryRoot: string;
  /** Repository-relative inspect scopes. */
  inspectScopes?: string[];
}

/** Hash-bind one deficiency into a portable task file (refusing to overwrite a different one). */
export function exportRefinementTask(
  air: AirDocument,
  deficiency: Deficiency,
  outFile: string,
  opts: ExportRefinementTaskOptions,
): RefinementTask {
  const task = createRefinementTask(air, deficiency, {
    repositoryRoot: opts.repositoryRoot,
    repositoryRevision: resolveRepositoryRevision(opts.repositoryRoot),
    inspectScopes: opts.inspectScopes,
  });
  writeWithoutReplacingDifferent(outFile, `${JSON.stringify(task, null, 2)}\n`);
  return task;
}

/* --------------------------------- import --------------------------------- */

export interface ImportRefinementSubmissionOptions {
  /** Git repository named by the task. */
  repositoryRoot: string;
}

export interface ImportedRefinementPack {
  pack: RefinementPack;
  /** Present when the submission was a group proposal: the measured, admitted delta. */
  delta?: GroupRoutingDelta;
  /** The files written under the pack directory, by relative name. */
  files: Record<string, string>;
}

/**
 * Re-enter deterministic validation and measurement for a harness submission
 * and write the resulting pack. GROUP admission happens HERE — after
 * validation, before anything is written — so a refused proposal leaves no
 * pack behind: the current side is recomputed live over AIR, a negative delta
 * throws `GroupAdmissionRefusal`, and a non-negative one is attached to the
 * refinement as evidence plus `routing-delta.json` in the pack. The tier stays
 * review either way (approval.ts pins the group patch keys).
 */
export async function importRefinementSubmission(
  air: AirDocument,
  task: unknown,
  submission: unknown,
  outDir: string,
  opts: ImportRefinementSubmissionOptions,
): Promise<ImportedRefinementPack> {
  const pack = importHarnessSubmission(air, task, submission, {
    repositoryRoot: opts.repositoryRoot,
  });

  const groupRecord = pack.harnessImports?.[0];
  // Driven off `GROUP_PATCH_KEYS` rather than a literal list, so a group patch
  // key added later cannot reach a reviewer unscored by simply not being named
  // here — the admission refusal is the only thing standing between a harness's
  // confident abstraction and a catalog that routes worse.
  const groupRefinement = pack.refinements.find(
    (refinement) =>
      refinement.target.kind === "group" &&
      GROUP_PATCH_KEYS.some((key) => key in refinement.proposal.set),
  );
  let delta: GroupRoutingDelta | undefined;
  if (groupRefinement && groupRecord) {
    delta = admitOrRefuse(
      await scoreGroupProposal(air, groupRecord.task.deficiency, groupRefinement.proposal.set),
    );
    // The delta is EVIDENCE on the proposal — the reviewer sees the number.
    groupRefinement.evidence.push(groupDeltaClaim(delta));
  }

  const files = packFiles(pack);
  if (delta !== undefined) files["routing-delta.json"] = `${JSON.stringify(delta, null, 2)}\n`;
  // Check every destination before writing any, so a conflict on the last file
  // cannot leave a half-written pack.
  for (const [name, contents] of Object.entries(files)) {
    const destination = join(outDir, name);
    if (existsSync(destination) && readFileSync(destination, "utf8") !== contents) {
      throw new Error(`Refusing to replace existing '${destination}' with different content.`);
    }
  }
  for (const [name, contents] of Object.entries(files)) {
    writeWithoutReplacingDifferent(join(outDir, name), contents);
  }
  return { pack, ...(delta !== undefined ? { delta } : {}), files };
}
