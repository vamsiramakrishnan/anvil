import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { type AirDocument, airFromJson } from "@anvil/air";
import { type AgentDriver, ClaudeCodeAgentDriver } from "../case/driver.js";
import { defaultExecutionPolicy } from "../case/execution-policy.js";
import type { AgentProcessRunner } from "../case/process-runner.js";
import { compareSeverity, type Deficiency, makeDeficiency } from "../deficiency.js";
import {
  type DiscardedFinding,
  REVIEW_SCHEMA_VERSION,
  type ReviewFinding,
  ReviewModelOutput,
  ReviewReport,
  type ReviewSummary,
} from "./schema.js";
import { generateReviewSop } from "./sop.js";

/**
 * The artifact-review pipeline: deterministically assemble a review context from
 * a generated bundle, materialize a review workspace (SOP + excerpts + brief),
 * drive a reviewer agent through the existing `AgentDriver` seam, then parse and
 * *mechanically re-ground* what came back. The model is untrusted end to end —
 * its JSON must parse against the strict schema (one repair retry), every
 * excerpt must actually appear in the file it cites, and every opId must exist
 * in the bundle. What survives converts into catalog deficiencies.
 */

/** Driver could not run at all (binary missing, not authenticated, crashed). */
export class ReviewDriverUnavailableError extends Error {
  readonly code = "review/driver_unavailable";
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReviewDriverUnavailableError";
  }
}

/** Driver ran but never produced parseable output (after the one repair retry). */
export class ReviewOutputError extends Error {
  readonly code = "review/invalid_output";
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReviewOutputError";
  }
}

/** Bundle context contains a filesystem node that cannot be safely sent to a model. */
export class ReviewContextSecurityError extends Error {
  readonly code = "review/unsafe_context";
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReviewContextSecurityError";
  }
}

export interface ArtifactReviewOptions {
  /** Reviewer model recorded in the report (selection itself is the driver's). */
  model?: string;
  /** Where to materialize the review workspace (default: a fresh temp dir). */
  workspaceRoot?: string;
  /** Per-file excerpt cap in characters. */
  maxFileChars?: number;
  /** Total context budget in characters. */
  maxTotalChars?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => string;
}

const DEFAULT_MAX_FILE_CHARS = 16_000;
const DEFAULT_MAX_TOTAL_CHARS = 240_000;

/* -------------------------------------------------------------------------- */
/* Context assembly — deterministic given the bundle                          */
/* -------------------------------------------------------------------------- */

export interface ReviewContextFile {
  /** Bundle-relative path (also the path under the workspace's `context/`). */
  file: string;
  text: string;
  truncated: boolean;
}

/**
 * Credential material must never reach the reviewer prompt. Matched against the
 * whole bundle-relative path; anything credential-shaped is excluded even if a
 * tier below would otherwise admit it.
 */
const SECRET_PATH = /secret|credential|token|api[-_]?key|\.env|env\.schema|password/i;

/**
 * Which files the reviewer sees, in priority order. Earlier tiers survive the
 * total budget first; anything without a tier (generated JS, runtime manifests,
 * mocks, deploy material, records) is never included. `air.json` comes last —
 * it is the largest file and the catalog already carries the per-op semantics.
 */
function contextTier(file: string): number | undefined {
  if (SECRET_PATH.test(file)) return undefined;
  if (file === "catalog.json") return 0;
  if (file === "skill/SKILL.md") return 1;
  if (file.startsWith("skill/reference/")) return 2;
  if (file.startsWith("docs/")) return 3;
  if (file.startsWith("skill/examples/")) return 4;
  if (file.startsWith("schemas/") && file.endsWith(".schema.json")) return 5;
  if (file === "air.json") return 6;
  return undefined;
}

const REVIEW_CONTEXT_ROOTS = ["catalog.json", "air.json", "skill", "docs", "schemas"] as const;

interface ContextRoot {
  path: string;
  real: string;
}

function contextRoot(dir: string): ContextRoot {
  const path = resolve(dir);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    throw new ReviewContextSecurityError(`Review bundle cannot be inspected: ${path}`, {
      cause: error,
    });
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ReviewContextSecurityError(
      `Review bundle must be a real directory, not a symlink or special node: ${path}`,
    );
  }
  return { path, real: realpathSync(path) };
}

function assertContainedNode(root: ContextRoot, full: string, rel: string): string {
  const real = realpathSync(full);
  if (real !== root.real && !real.startsWith(`${root.real}${sep}`)) {
    throw new ReviewContextSecurityError(
      `Review context path escapes the bundle through the filesystem: ${rel}`,
    );
  }
  return real;
}

function walkFiles(root: ContextRoot): string[] {
  const files: string[] = [];
  const walk = (rel: string): void => {
    const full = join(root.path, rel);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) {
      throw new ReviewContextSecurityError(`Review context refuses symbolic link: ${rel}`);
    }
    assertContainedNode(root, full, rel);
    if (stat.isFile()) {
      files.push(rel);
      return;
    }
    if (!stat.isDirectory()) {
      throw new ReviewContextSecurityError(
        `Review context refuses non-regular filesystem node: ${rel}`,
      );
    }
    for (const entry of readdirSync(full, { withFileTypes: true })) {
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      walk(childRel);
    }
  };
  for (const rel of REVIEW_CONTEXT_ROOTS) {
    if (existsSync(join(root.path, rel))) walk(rel);
  }
  return files;
}

function readContextFile(root: ContextRoot, rel: string): string {
  const full = join(root.path, rel);
  const before = lstatSync(full);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new ReviewContextSecurityError(
      `Review context file is not a regular non-symlink file: ${rel}`,
    );
  }
  assertContainedNode(root, full, rel);
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  let fd: number;
  try {
    fd = openSync(full, constants.O_RDONLY | noFollow);
  } catch (error) {
    throw new ReviewContextSecurityError(`Review context file could not be opened safely: ${rel}`, {
      cause: error,
    });
  }
  try {
    const after = fstatSync(fd);
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino) {
      throw new ReviewContextSecurityError(
        `Review context file changed while it was being admitted: ${rel}`,
      );
    }
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Select and truncate the bundle files the reviewer will see. Deterministic
 * given the bundle: fixed tiers, approved operations' schemas ahead of
 * unapproved ones, alphabetical within a group, head-truncation at fixed caps.
 */
export function assembleReviewContext(
  bundleDir: string,
  air: AirDocument,
  limits: { maxFileChars?: number; maxTotalChars?: number } = {},
): ReviewContextFile[] {
  const root = contextRoot(bundleDir);
  const maxFile = limits.maxFileChars ?? DEFAULT_MAX_FILE_CHARS;
  const maxTotal = limits.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS;
  const approved = new Set(
    air.operations.filter((op) => op.state === "approved").map((op) => op.id),
  );
  // Within the schemas tier, approved operations come first — they are the
  // exposed surface and must survive truncation on big bundles.
  const approvedRank = (file: string): number => {
    const m = /^schemas\/(.+)\.schema\.json$/.exec(file);
    return m?.[1] !== undefined && approved.has(m[1]) ? 0 : 1;
  };

  const candidates = walkFiles(root)
    .map((file) => ({ file, tier: contextTier(file) }))
    .filter((c): c is { file: string; tier: number } => c.tier !== undefined)
    .sort(
      (a, b) =>
        a.tier - b.tier ||
        approvedRank(a.file) - approvedRank(b.file) ||
        a.file.localeCompare(b.file),
    );

  const out: ReviewContextFile[] = [];
  let remaining = maxTotal;
  for (const { file } of candidates) {
    if (remaining <= 0) break;
    const raw = readContextFile(root, file);
    const allowed = Math.min(maxFile, remaining);
    const truncated = raw.length > allowed;
    const text = truncated ? `${raw.slice(0, allowed)}\n… [truncated by anvil review]\n` : raw;
    remaining -= Math.min(raw.length, allowed);
    out.push({ file, text, truncated });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Workspace materialization + the brief                                      */
/* -------------------------------------------------------------------------- */

/** The brief file the ClaudeCode driver reads as its prompt (CASE.md by seam contract). */
const BRIEF_FILE = "CASE.md";
const OUTPUT_FILE = "output/review.json";

function reviewBrief(air: AirDocument, context: ReviewContextFile[]): string {
  const listing = context
    .map((c) => `- context/${c.file}${c.truncated ? " (truncated)" : ""}`)
    .join("\n");
  return `# Artifact review — ${air.service.id} @ ${air.service.version}

You are performing Anvil's model-driven ARTIFACT REVIEW of a generated tool
bundle. The bundle's agent-facing files are excerpted under \`context/\`,
preserving their bundle-relative paths:

${listing}

Follow the SOP at \`sop/SKILL.md\` exactly — the read order, the four artifact
checklists under \`sop/reference/\`, the severity rubric and code mapping in
\`sop/reference/severity-and-codes.md\`, and the output contract in
\`sop/reference/output-contract.md\`.

Deliverable: STRICT JSON at \`${OUTPUT_FILE}\`. Cite evidence by bundle-relative
path (write \`catalog.json\`, not \`context/catalog.json\`) with verbatim
excerpts. Do not modify any other file.

NOTE: this is a review engagement, not a refinement case — if harness
boilerplate below mentions \`anvil case\` helpers or \`anvil case finalize\`,
it does not apply here. Writing \`${OUTPUT_FILE}\` completes the job.
`;
}

function materializeWorkspace(
  air: AirDocument,
  context: ReviewContextFile[],
  root?: string,
): string {
  const dir = root ? resolve(root) : mkdtempSync(join(tmpdir(), "anvil-review-"));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ReviewContextSecurityError(
      `Review workspace must be a real directory, not a symlink or special node: ${dir}`,
    );
  }
  mkdirSync(join(dir, "output"), { recursive: true });
  for (const [rel, text] of Object.entries(generateReviewSop())) {
    const full = join(dir, "sop", rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text, "utf8");
  }
  for (const c of context) {
    const full = join(dir, "context", c.file);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, c.text, "utf8");
  }
  writeFileSync(join(dir, BRIEF_FILE), reviewBrief(air, context), "utf8");
  return dir;
}

/** One repair pass: same brief plus what was wrong, demanding only the JSON. */
function writeRepairBrief(dir: string, air: AirDocument, ctx: ReviewContextFile[], why: string) {
  const brief = `${reviewBrief(air, ctx)}
## REPAIR REQUIRED
Your previous \`${OUTPUT_FILE}\` was rejected: ${why}
Rewrite \`${OUTPUT_FILE}\` as strict JSON matching
\`sop/reference/output-contract.md\` exactly. Emit ONLY the JSON document —
no fences, no prose, no extra fields.
`;
  writeFileSync(join(dir, BRIEF_FILE), brief, "utf8");
}

/* -------------------------------------------------------------------------- */
/* Parsing + mechanical grounding                                             */
/* -------------------------------------------------------------------------- */

type ParsedOutput = { ok: true; output: ReviewModelOutput } | { ok: false; error: string };

/** Fences are stripped mechanically; everything else must be strict JSON. */
function stripFences(raw: string): string {
  const m = /^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/.exec(raw);
  return m?.[1] ?? raw;
}

function readModelOutput(dir: string): ParsedOutput {
  const path = join(dir, OUTPUT_FILE);
  if (!existsSync(path)) return { ok: false, error: `no ${OUTPUT_FILE} was written` };
  let json: unknown;
  try {
    json = JSON.parse(stripFences(readFileSync(path, "utf8")));
  } catch (err) {
    return { ok: false, error: `not valid JSON (${(err as Error).message})` };
  }
  const parsed = ReviewModelOutput.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      error: `schema violation at ${issue?.path.join(".") || "(root)"}: ${issue?.message}`,
    };
  }
  return { ok: true, output: parsed.data };
}

function normalizeWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Enforce grounding mechanically, the same discipline as the effectiveness
 * battery: a finding may only cite a file the reviewer was actually shown, its
 * excerpt must appear (whitespace-normalized) in the *bundle's* copy of that
 * file, and an operation-scoped finding must name a real operation. Anything
 * else is dropped and counted — never silently kept.
 */
function groundFindings(
  _bundleDir: string,
  air: AirDocument,
  context: ReviewContextFile[],
  findings: ReviewFinding[],
): { kept: ReviewFinding[]; discarded: DiscardedFinding[] } {
  const shown = new Map(
    context.map((item) => [
      item.file,
      normalizeWs(item.text.replace(/\n… \[truncated by anvil review\]\n$/, "")),
    ]),
  );
  const opIds = new Set(air.operations.map((op) => op.id));
  const kept: ReviewFinding[] = [];
  const discarded: DiscardedFinding[] = [];
  for (const f of findings) {
    const text = shown.get(f.evidence.file);
    if (text === undefined) {
      discarded.push({ id: f.id, reason: `cites '${f.evidence.file}', not a reviewed file` });
      continue;
    }
    if (f.opId !== undefined && !opIds.has(f.opId)) {
      discarded.push({ id: f.id, reason: `names unknown operation '${f.opId}'` });
      continue;
    }
    if (!text.includes(normalizeWs(f.evidence.excerpt))) {
      discarded.push({ id: f.id, reason: `excerpt not found in '${f.evidence.file}'` });
      continue;
    }
    kept.push(f);
  }
  return { kept, discarded };
}

function summarize(findings: readonly ReviewFinding[]): ReviewSummary {
  const bySeverity: ReviewSummary["bySeverity"] = {};
  const byArtifact: ReviewSummary["byArtifact"] = {};
  for (const f of findings) {
    bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
    byArtifact[f.artifact] = (byArtifact[f.artifact] ?? 0) + 1;
  }
  return { bySeverity, byArtifact };
}

/* -------------------------------------------------------------------------- */
/* The review run                                                             */
/* -------------------------------------------------------------------------- */

async function runDriver(driver: AgentDriver, dir: string): Promise<void> {
  try {
    await driver.run(dir);
  } catch (err) {
    throw new ReviewDriverUnavailableError(
      `the review driver could not complete: ${(err as Error).message} ` +
        "Is the agent CLI installed, on PATH, and authenticated?",
      { cause: err },
    );
  }
}

/**
 * Review a generated bundle with a reviewer agent. Never mutates the bundle;
 * the caller decides where (and whether) to persist the report. Throws
 * `ReviewDriverUnavailableError` when the driver cannot run and
 * `ReviewOutputError` when the model never produced parseable output — a
 * failed review is a failure, never an empty pass.
 */
export async function runArtifactReview(
  bundleDir: string,
  driver: AgentDriver,
  options: ArtifactReviewOptions = {},
): Promise<ReviewReport> {
  const startedAt = (options.now ?? (() => new Date().toISOString()))();
  const root = contextRoot(bundleDir);
  const airPath = join(root.path, "air.json");
  if (!existsSync(airPath)) {
    throw new Error(`No air.json in ${bundleDir} — not a generated bundle. Run \`anvil compile\`.`);
  }
  const air = airFromJson(readContextFile(root, "air.json"));
  const context = assembleReviewContext(root.path, air, options);
  const dir = materializeWorkspace(air, context, options.workspaceRoot);
  const ownsWorkspace = options.workspaceRoot === undefined;

  try {
    await runDriver(driver, dir);
    let parsed = readModelOutput(dir);
    if (!parsed.ok) {
      // One repair pass: tell the model exactly what was wrong, then re-drive.
      writeRepairBrief(dir, air, context, parsed.error);
      rmSync(join(dir, OUTPUT_FILE), { force: true });
      await runDriver(driver, dir);
      parsed = readModelOutput(dir);
      if (!parsed.ok) {
        throw new ReviewOutputError(
          `reviewer output failed to parse after one repair attempt: ${parsed.error}`,
        );
      }
    }

    const { kept, discarded } = groundFindings(root.path, air, context, parsed.output.findings);
    const findings = kept
      .slice()
      .sort((a, b) => compareSeverity(a.severity, b.severity) || a.id.localeCompare(b.id));

    return ReviewReport.parse({
      schemaVersion: REVIEW_SCHEMA_VERSION,
      bundle: {
        dir: bundleDir,
        serviceId: air.service.id,
        serviceVersion: air.service.version,
      },
      model: options.model ?? driver.name,
      startedAt,
      findings,
      discarded,
      summary: summarize(findings),
      reviewerNotes: parsed.output.reviewerNotes,
    });
  } finally {
    if (ownsWorkspace) rmSync(dir, { recursive: true, force: true });
  }
}

/* -------------------------------------------------------------------------- */
/* Feeding the existing deficiency machinery                                  */
/* -------------------------------------------------------------------------- */

/**
 * Convert surviving findings into catalog deficiencies so readiness-style
 * consumers ingest them like any detector's output. The catalog stays the
 * single source of truth: category, skill, and readiness policy come from the
 * code, and `makeDeficiency` never lets the model *lower* a severity below the
 * catalog default. Review provenance rides in `facts`.
 */
export function reviewFindingsToDeficiencies(report: ReviewReport): Deficiency[] {
  return report.findings.map((f) =>
    makeDeficiency(
      f.code,
      f.opId !== undefined ? { kind: "operation", operationId: f.opId } : { kind: "service" },
      f.claim,
      {
        reviewFinding: f.id,
        artifact: f.artifact,
        evidenceFile: f.evidence.file,
        evidenceExcerpt: f.evidence.excerpt,
        ...(f.evidence.path !== undefined ? { evidencePath: f.evidence.path } : {}),
        ...(f.suggestion !== undefined ? { suggestion: f.suggestion } : {}),
        reviewModel: report.model,
      },
      f.severity,
    ),
  );
}

/* -------------------------------------------------------------------------- */
/* Default driver construction                                                */
/* -------------------------------------------------------------------------- */

export interface ReviewDriverOptions {
  /** The headless agent CLI (default `claude`). */
  command?: string;
  /** The reviewer model flag value (default `haiku` — the cheap class). */
  model?: string;
  /** Explicit consent to native execution without a filesystem sandbox. */
  allowDegradedNative?: boolean;
  /** Test seam; production uses the ordinary async process runner. */
  runner?: AgentProcessRunner;
}

/**
 * The default reviewer: the Claude Code CLI on a Haiku-class model. Native
 * execution is refused unless the operator explicitly accepts its missing
 * filesystem containment. Even then, HOME/XDG/TMPDIR are isolated inside the
 * disposable review workspace and only the named Claude credential variables
 * are inherited.
 */
export function haikuReviewDriver(options: ReviewDriverOptions = {}): ClaudeCodeAgentDriver {
  return new ClaudeCodeAgentDriver({
    command: options.command,
    // acceptEdits (not skip-permissions): the reviewer must be able to deposit
    // output/review.json headlessly, but gets no blanket execution consent.
    extraArgs: ["--model", options.model ?? "haiku", "--permission-mode", "acceptEdits"],
    policy: { ...defaultExecutionPolicy("claude-code"), home: "isolated" },
    allowDegradedNative: options.allowDegradedNative === true,
    runner: options.runner,
  });
}
