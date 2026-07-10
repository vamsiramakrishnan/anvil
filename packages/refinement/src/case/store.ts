import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type AllowedToolsDoc,
  CASE_FILES,
  type CaseDocument,
  type CaseTargetDoc,
  type CaseTask,
  type EvidencePolicyDoc,
  parseCaseDocument,
} from "./model.js";

/**
 * The **case store** — the one place that reads and writes a run directory. It owns
 * the JSON file plumbing every other case module shares, the loaders for the
 * canonical `case.json` and its sections, the `inspect` view, and the explicit
 * resume/delete verbs. Keeping IO here (not scattered across the command surface)
 * is what lets the other modules stay pure domain logic over already-loaded data.
 */

/* --------------------------------- file IO -------------------------------- */

export function readJson<T>(dir: string, rel: string): T {
  return JSON.parse(readFileSync(join(dir, rel), "utf8")) as T;
}

export function readOptionalJson<T>(dir: string, rel: string): T | undefined {
  const full = join(dir, rel);
  return existsSync(full) ? (JSON.parse(readFileSync(full, "utf8")) as T) : undefined;
}

export function writeJson(dir: string, rel: string, value: unknown): void {
  const full = join(dir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/* -------------------------------- loaders --------------------------------- */

/** Load and validate the one canonical case document. */
export function loadCaseDocument(dir: string): CaseDocument {
  return parseCaseDocument(readJson(dir, CASE_FILES.doc));
}
export function loadTask(dir: string): CaseTask {
  return loadCaseDocument(dir).task;
}
export function loadTargetDoc(dir: string): CaseTargetDoc {
  return loadCaseDocument(dir).target;
}
export function loadPolicy(dir: string): EvidencePolicyDoc {
  return loadCaseDocument(dir).policy;
}
export function loadTools(dir: string): AllowedToolsDoc {
  const doc = loadCaseDocument(dir);
  return { workspace: doc.workspace, helpers: doc.tools.helpers, deny: doc.tools.deny };
}

/* ------------------------------ inspect view ------------------------------ */

/** Render the case's target facts and policy — the `anvil case inspect` view. */
export function inspectTarget(dir: string): string {
  const t = loadTargetDoc(dir);
  const p = loadPolicy(dir);
  const lines: string[] = [];
  lines.push(`${t.describe}  (${t.key})`);
  if (t.operationId)
    lines.push(`  operation: ${t.operationName ?? t.operationId} [${t.operationEffect}]`);
  if (t.field) {
    lines.push(
      `  field: ${t.field.name}  type=${t.field.type ?? "?"}  required=${t.field.required}`,
    );
    if (t.field.enumValues) lines.push(`  enum: ${JSON.stringify(t.field.enumValues)}`);
    if (t.field.existingDescription)
      lines.push(`  existing description: ${t.field.existingDescription}`);
  }
  if (t.siblingFields?.length) {
    lines.push(`  siblings: ${t.siblingFields.map((s) => s.name).join(", ")}`);
  }
  if (t.errorCode) lines.push(`  error code: ${t.errorCode}`);
  lines.push(`  admissible sources: ${p.allowedSources.join(", ")} (min ${p.minimumStrength})`);
  lines.push(`  writable fields: ${p.writableFields.join(", ") || "(none)"}`);
  lines.push(`  output predicates: ${p.writablePredicates.join(", ") || "(none)"}`);
  lines.push(`  supporting predicates: ${p.supportingPredicates.join(", ") || "(none)"}`);
  lines.push(`  prior evidence: ${t.priorEvidence.length} claim(s)`);
  lines.push(`  expected output schema: ${CASE_FILES.expectedSchema}`);
  return lines.join("\n");
}

/* ---------------------------- resume / delete ----------------------------- */

/** A handle onto an already-materialised run: its directory and canonical document. */
export interface ResumedRun {
  dir: string;
  doc: CaseDocument;
}

/**
 * Explicitly reopen an existing run directory. Unlike `openCase` (which always
 * *creates* a fresh, immutable run), `resumeCase` recovers one that was already
 * materialised — the deliberate second verb, so creation and recovery never hide
 * behind one polymorphic call. Throws if the directory holds no canonical document.
 */
export function resumeCase(runDir: string): ResumedRun {
  if (!existsSync(join(runDir, CASE_FILES.doc))) {
    throw new Error(`No case at '${runDir}' (missing ${CASE_FILES.doc}). Open one first.`);
  }
  return { dir: runDir, doc: loadCaseDocument(runDir) };
}

/** Delete a run directory — the explicit destructive verb, never implicit in `openCase`. */
export function deleteRun(runDir: string): void {
  rmSync(runDir, { recursive: true, force: true });
}
