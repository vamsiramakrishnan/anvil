import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { type EvalTerm, evalTerm } from "@anvil/air";
import { bundleHash, EVALS_REPORT_FILE, readBundleDir, resolveBundleDir } from "@anvil/generators";
import {
  type AgentProcessRunner,
  allowlistedEnv,
  type EvalCase,
  type EvalJudge,
  type EvalSuite,
  type ExpectationKind,
  gradeSuite,
  NodeAgentProcessRunner,
  renderSuiteReport,
  type SuiteReport,
} from "@anvil/refinement";
import { parse as fromYaml } from "yaml";
import type { CliIO } from "../io.js";

/**
 * `anvil evals run` — produce the answers `anvil evals grade` has always been
 * able to grade, and grade them.
 *
 * Grading and producing stay different jobs (see evals.ts): this command owns
 * the producing half and then hands the answers to the same `gradeSuite` a
 * transcript captured anywhere else would go through. It drives ONE agent
 * process per case over stdin/stdout — the same shape `anvil benchmark --agent`
 * uses — so any harness that can read a prompt and print an answer can be
 * measured, Claude or not, and never sees the case's expectations.
 *
 * ## Protocols (both one JSON document on stdin, plain output on stdout)
 *
 * Agent — `{"protocol":"anvil-evals-agent/v1","suite","case","prompt"?,
 * "upstream"?}`; stdout is the answer, verbatim. A non-zero exit, a timeout,
 * or empty output leaves the case unanswered, which grades as UNGRADED on every
 * expectation — a run that never reached a case cannot shrink the denominator.
 *
 * Judge (optional, `--judge`) — `{"protocol":"anvil-evals-judge/v1","kind",
 * "entry","term":{check,satisfiedBy,violatedBy},"answer"}`; stdout is
 * `{"present": true|false}`. Anything else (including `null`, a non-zero exit,
 * or a timeout) leaves the expectation ungraded, which is what an unsure judge
 * should do. Without `--judge`, judge-only expectations stay UNGRADED exactly
 * as `evals grade` reports them today.
 *
 * ## `--check`
 *
 * Gates on demonstrated failures only. UNGRADED is not a pass and counts
 * against the rate, but it is not a violation either — gating on it would make
 * a judge mandatory to ever go green.
 */

export interface EvalsRunOptions {
  agent?: string;
  judge?: string;
  json?: boolean;
  check?: boolean;
  out?: string;
  timeout?: string;
}

/** One graded suite plus the answers it was graded on. */
export interface EvalsRunSuite extends SuiteReport {
  file: string;
  answers: Record<string, string>;
  /** Cases whose agent process failed, with why — they graded as unanswered. */
  unanswered: Array<{ case: string; reason: string }>;
}

export interface EvalsRunReport {
  schemaVersion: 1;
  reportType: "anvil.evals-report";
  /** Present when the target was a bundle: the digest the grading is about. */
  bundleHash?: string;
  agent: string;
  judge?: string;
  suites: EvalsRunSuite[];
  totals: { passed: number; failed: number; ungraded: number; total: number };
  passRate: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** `--agent "node fake.mjs"` → command + args; a bare command is the common case. */
function splitCommand(value: string): { command: string; args: string[] } {
  const [command = "", ...args] = value.trim().split(/\s+/);
  return { command, args };
}

function loadSuite(path: string): EvalSuite {
  const doc = fromYaml(readFileSync(path, "utf8")) as EvalSuite;
  if (!doc?.suite || !Array.isArray(doc.cases)) {
    throw new Error(`${path} is not an eval suite (expected 'suite' and 'cases')`);
  }
  return doc;
}

/** The suites a target names: every `skill/evals/*.yaml` of a bundle, or one file. */
function resolveTarget(target: string): {
  dir?: string;
  files?: Record<string, string>;
  suites: string[];
} {
  const isBundle =
    existsSync(target) &&
    (statSync(target).isDirectory() || basename(target) === "air.yaml" || target.endsWith(".json"));
  if (!isBundle) return { suites: [target] };
  const dir = resolveBundleDir(target);
  const files = readBundleDir(dir);
  const suites = Object.keys(files)
    .filter((rel) => rel.startsWith("skill/evals/") && rel.endsWith(".yaml"))
    .sort()
    .map((rel) => join(dir, rel));
  return { dir, files, suites };
}

async function askAgent(
  runner: AgentProcessRunner,
  agent: { command: string; args: string[] },
  input: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ output?: string; reason?: string }> {
  try {
    const result = await runner.run({
      ...agent,
      cwd: process.cwd(),
      input: `${JSON.stringify(input)}\n`,
      env: allowlistedEnv([]),
      timeoutMs,
    });
    if (result.timedOut) return { reason: `timed out after ${timeoutMs}ms` };
    if (result.canceled) return { reason: "canceled" };
    if (result.exitCode !== 0) return { reason: `exited ${result.exitCode}` };
    return { output: result.stdout };
  } catch (err) {
    return { reason: err instanceof Error ? err.message : String(err) };
  }
}

interface JudgeRequest {
  kind: ExpectationKind;
  entry: string;
  answer: string;
  term: EvalTerm;
}

/**
 * Every judge-only expectation a first, judge-less grading pass left UNGRADED
 * on an answered case — keyed by (kind, entry, answer) because that is all a
 * judge is told. An entry the vocabulary does not define stays ungraded: there
 * is no term to hand a judge, and asking one anyway would be grading a word
 * nobody has given a meaning.
 */
function judgeRequests(suite: EvalSuite, answers: Record<string, string>): JudgeRequest[] {
  const first = gradeSuite(suite, answers);
  const seen = new Set<string>();
  const out: JudgeRequest[] = [];
  for (const c of first.cases) {
    const answer = answers[c.case];
    if (!answer) continue;
    for (const e of c.expectations) {
      if (e.outcome !== "ungraded" || e.method !== "judge_required") continue;
      const term = evalTerm(e.entry);
      if (!term) continue;
      const key = JSON.stringify([e.kind, e.entry, answer]);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: e.kind, entry: e.entry, answer, term });
    }
  }
  return out;
}

export async function runEvalsRun(
  target: string,
  opts: EvalsRunOptions,
  io: CliIO,
  deps: { runner?: AgentProcessRunner } = {},
): Promise<number> {
  if (!opts.agent) {
    io.err(
      "--agent <command> is required: the command that reads a case on stdin and prints its answer.",
    );
    return 1;
  }
  const timeoutMs = opts.timeout === undefined ? DEFAULT_TIMEOUT_MS : Number(opts.timeout);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    io.err(`Invalid --timeout '${opts.timeout}': expected a positive number of milliseconds.`);
    return 1;
  }
  const runner = deps.runner ?? new NodeAgentProcessRunner();
  const agent = splitCommand(opts.agent);
  const judge = opts.judge ? splitCommand(opts.judge) : undefined;

  const resolved = resolveTarget(target);
  if (resolved.suites.length === 0) {
    io.err(`No eval suites under ${join(resolved.dir ?? target, "skill/evals/")}.`);
    return 1;
  }

  const suites: EvalsRunSuite[] = [];
  for (const path of resolved.suites) {
    const suite = loadSuite(path);
    const answers: Record<string, string> = {};
    const unanswered: EvalsRunSuite["unanswered"] = [];
    for (const c of suite.cases as EvalCase[]) {
      const asked = await askAgent(
        runner,
        agent,
        {
          protocol: "anvil-evals-agent/v1",
          suite: suite.suite,
          case: c.case,
          ...(c.prompt !== undefined ? { prompt: c.prompt } : {}),
          ...(c.upstream !== undefined ? { upstream: c.upstream } : {}),
        },
        timeoutMs,
      );
      const answer = asked.output?.trim() ?? "";
      if (answer.length > 0) answers[c.case] = answer;
      else unanswered.push({ case: c.case, reason: asked.reason ?? "empty answer" });
    }

    let evalJudge: EvalJudge | undefined;
    if (judge) {
      const verdicts = new Map<string, boolean>();
      for (const request of judgeRequests(suite, answers)) {
        const asked = await askAgent(
          runner,
          judge,
          {
            protocol: "anvil-evals-judge/v1",
            kind: request.kind,
            entry: request.entry,
            term: {
              check: request.term.check,
              satisfiedBy: request.term.satisfiedBy,
              violatedBy: request.term.violatedBy,
            },
            answer: request.answer,
          },
          timeoutMs,
        );
        const verdict = parseVerdict(asked.output);
        if (verdict !== undefined) {
          verdicts.set(JSON.stringify([request.kind, request.entry, request.answer]), verdict);
        }
      }
      evalJudge = (input) => verdicts.get(JSON.stringify([input.kind, input.entry, input.answer]));
    }

    const report = gradeSuite(suite, answers, evalJudge);
    suites.push({ ...report, file: path, answers, unanswered });
  }

  const totals = suites.reduce(
    (acc, s) => ({
      passed: acc.passed + s.totals.passed,
      failed: acc.failed + s.totals.failed,
      ungraded: acc.ungraded + s.totals.ungraded,
      total: acc.total + s.totals.total,
    }),
    { passed: 0, failed: 0, ungraded: 0, total: 0 },
  );
  const report: EvalsRunReport = {
    schemaVersion: 1,
    reportType: "anvil.evals-report",
    ...(resolved.files ? { bundleHash: bundleHash(resolved.files) } : {}),
    agent: opts.agent,
    ...(opts.judge ? { judge: opts.judge } : {}),
    suites,
    totals,
    passRate: totals.total === 0 ? 0 : Math.round((totals.passed / totals.total) * 1000) / 10,
  };

  const out = opts.out ?? (resolved.dir ? join(resolved.dir, EVALS_REPORT_FILE) : undefined);
  if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  if (opts.json === true) {
    io.out(JSON.stringify(report, null, 2));
  } else {
    for (const s of suites) {
      io.out(renderSuiteReport(s));
      for (const u of s.unanswered) io.out(`  ${u.case} · unanswered: ${u.reason}`);
    }
    io.out("");
    io.out(
      `${suites.length} suite(s), agent ${opts.agent}${opts.judge ? `, judge ${opts.judge}` : ", no judge"}: ` +
        `${totals.passed}/${totals.total} passed (${report.passRate}%), ${totals.failed} failed, ${totals.ungraded} ungraded.` +
        (out
          ? ` Wrote ${out}.`
          : ` No report written (pass --out <file> to keep one for a bare suite).`),
    );
  }
  // Same rule as `evals grade --check`: failures gate, UNGRADED does not.
  if (opts.check === true && totals.failed > 0) return 1;
  return 0;
}

/** `{"present": true|false}` and nothing else decides; the rest is "unsure". */
function parseVerdict(output: string | undefined): boolean | undefined {
  if (!output) return undefined;
  try {
    const parsed: unknown = JSON.parse(output.trim());
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const present = (parsed as { present?: unknown }).present;
      if (typeof present === "boolean") return present;
    }
  } catch {
    // not a verdict
  }
  return undefined;
}
