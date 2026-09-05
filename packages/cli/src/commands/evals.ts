import { readFileSync } from "node:fs";
import { EVAL_VOCABULARY } from "@anvil/air";
import { type EvalSuite, gradeSuite, renderSuiteReport } from "@anvil/refinement";
import type { Command } from "commander";
import { parse as fromYaml } from "yaml";
import type { CliIO } from "../io.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";

/**
 * `anvil evals` — run the behaviour checks Anvil has always shipped.
 *
 * Every skill and every generated bundle carries `evals/*.yaml`: cases that say
 * which commands a harness must call, what its answer must contain, and what it
 * must never do. Those files were emitted for years and executed by nothing. The
 * only tests that touched them compared their text against the generator, which
 * catches drift and is silent about behaviour — so a bundle could ship a check
 * asserting "never approves an unproven mutation" without anyone ever having
 * asked a harness whether it does.
 *
 * The reason no runner existed is that the checks were unrunnable as written.
 * Their concept tokens — `manifest_idempotency_policy`, `not_exactly_once`,
 * `authority_from_similarity` — were bare identifiers defined nowhere, and you
 * cannot grade a word nobody has given a meaning. `EVAL_VOCABULARY` (in
 * `@anvil/air`) now defines them, a drift gate keeps that definition set equal
 * to what the emitters write, and this command is the half that finally runs.
 *
 * ## What it will not pretend to know
 *
 * A third of the vocabulary is `judgeOnly`: no wording reliably separates the
 * behaviour from its absence, usually because a compliant answer NAMES the thing
 * it is declining ("I will not retry immediately"). Those expectations are
 * reported UNGRADED and counted against the pass rate, never quietly passed.
 * That is the same discipline the checks themselves demand — a report that
 * scored its own undecidable checks green would be the defect this command
 * exists to remove, one level up.
 */

interface EvalsRunOptions {
  answers?: string;
  json?: boolean;
  check?: boolean;
}

/** Read one emitted suite file. */
function loadSuite(path: string): EvalSuite {
  const doc = fromYaml(readFileSync(path, "utf8")) as EvalSuite;
  if (!doc?.suite || !Array.isArray(doc.cases)) {
    throw new Error(`${path} is not an eval suite (expected 'suite' and 'cases')`);
  }
  return doc;
}

/**
 * Answers are supplied as JSON mapping a case name to what the harness said.
 * Keeping the harness OUT of this command is deliberate: grading and producing
 * are different jobs, and a grader that also drove the agent could not be run
 * against a transcript captured somewhere else — including from a harness that
 * is not a Claude one.
 */
function loadAnswers(path: string | undefined, io: CliIO): Record<string, string> {
  if (!path) return {};
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    io.err("--answers must be a JSON object mapping case name to the harness's answer.");
    return {};
  }
  const answers: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "string") answers[name] = value;
  }
  return answers;
}

function runGrade(suitePath: string, opts: EvalsRunOptions, io: CliIO): number {
  const suite = loadSuite(suitePath);
  const report = gradeSuite(suite, loadAnswers(opts.answers, io));
  if (opts.json === true) {
    io.out(JSON.stringify(report, null, 2));
  } else {
    io.out(renderSuiteReport(report));
  }
  // `--check` gates on failures only. An UNGRADED expectation is not a pass, but
  // it is also not a demonstrated violation — gating on it would make supplying
  // a judge mandatory to ever go green, and the honest state of a judge-only
  // check with no judge is "nobody has decided", not "broken".
  if (opts.check === true && report.totals.failed > 0) return 1;
  return 0;
}

function runVocabulary(opts: { json?: boolean }, io: CliIO): number {
  const terms = Object.entries(EVAL_VOCABULARY).sort(([a], [b]) => a.localeCompare(b));
  if (opts.json === true) {
    // The operator envelope, like every other --json surface: a consumer that
    // pipes this into `jq` must be able to tell what document it received.
    io.out(
      JSON.stringify(
        {
          schemaVersion: 1,
          reportType: "anvil.eval-vocabulary",
          terms: Object.fromEntries(terms),
        },
        null,
        2,
      ),
    );
    return 0;
  }
  const judged = terms.filter(([, t]) => t.judgeOnly).length;
  io.out(
    `${terms.length} terms — ${terms.length - judged} decidable from wording, ` +
      `${judged} need a judge.`,
  );
  for (const [token, term] of terms) {
    io.out("");
    io.out(`${token}${term.judgeOnly ? "  (judge only)" : ""}`);
    io.out(`  ${term.check}`);
    io.out(`  satisfied: ${term.satisfiedBy}`);
    io.out(`  violated:  ${term.violatedBy}`);
    if (term.signals?.length) io.out(`  signals:   ${term.signals.join("  ")}`);
  }
  return 0;
}

export function registerEvals(parent: Command, ctx: CommandContext): void {
  const evals = parent
    .command("evals")
    .summary("Grade a harness against the behaviour checks a skill or bundle ships.");

  annotate(
    evals
      .command("grade")
      .summary("Grade harness answers against one emitted eval suite.")
      .description(
        "Read-only. Grades a harness's answers against the cases in an emitted `evals/*.yaml` — the behaviour checks every skill and every generated bundle already ships. " +
          "Literal expectations (a command, a flag, a value the document supplied) are matched directly. Concept tokens are decided by `EVAL_VOCABULARY`, whose signals are treated as necessary evidence rather than sufficient: absence under `must_include` and presence under `must_not` are demonstrated failures. " +
          "An expectation no wording can decide is reported UNGRADED and counted against the pass rate — never passed silently. " +
          "Exits 0 unless `--check` is given and some expectation actually failed.",
      )
      .argument("<suite>", "path to an emitted evals/*.yaml")
      .option("--answers <file>", "JSON object mapping case name to the harness's answer")
      .option("--check", "gate: exit non-zero when an expectation failed")
      .option("--json", "emit the full grading report as JSON")
      .action((suite: string, opts: EvalsRunOptions) => {
        ctx.code = runGrade(suite, opts, ctx.io);
      }),
    { mutates: false },
  );

  annotate(
    evals
      .command("vocabulary")
      .summary("Print what each concept token in a behaviour check means.")
      .description(
        "Read-only. Prints the defined vocabulary the checks are written in: for each token, what an answer must show, a concrete shape that satisfies it, one that violates it, and the signals that decide it. " +
          "Tokens marked judge-only have no wording that separates the behaviour from its absence — commonly because a compliant answer names the thing it is declining — and are reported ungraded rather than guessed at.",
      )
      .option("--json", "emit the vocabulary as JSON")
      .action((opts: { json?: boolean }) => {
        ctx.code = runVocabulary(opts, ctx.io);
      }),
    { mutates: false },
  );
}
