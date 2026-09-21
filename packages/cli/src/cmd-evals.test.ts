import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "@anvil/compiler";
import {
  bundleHash,
  certifyBundle,
  evalsEvidenceStatus,
  generateBundle,
  loadBundleAir,
  readBundleDir,
  writeBundle,
} from "@anvil/generators";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type EvalsRunReport, runEvalsRun } from "./commands/evals-run.js";
import { bufferIO } from "./io.js";

/**
 * `anvil evals run` with a SCRIPTED agent: a node script that reads the case
 * on stdin and answers from a fixed table, so nothing here needs a model. The
 * point under test is the plumbing's honesty — what reaches the agent, what an
 * unanswered case grades as, what a judge may and may not settle, and that the
 * report lands as a hash-bound derived record the certify gate can describe.
 */

const examples = fileURLToPath(new URL("../../../examples/payments/", import.meta.url));
const SUITE = fileURLToPath(
  new URL("../../../skills/anvil/evals/operate_anvil.yaml", import.meta.url),
);
const read = (rel: string) => readFileSync(join(examples, rel), "utf8");

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "anvil-evals-run-"));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

/** A fake harness: answers by case name; records every request it saw. */
function scriptedAgent(answers: Record<string, string>, options: { failOn?: string } = {}): string {
  const script = join(work, "agent.mjs");
  writeFileSync(
    script,
    `
import { appendFileSync } from "node:fs";
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const task = JSON.parse(input);
  appendFileSync(${JSON.stringify(join(work, "agent.log"))}, JSON.stringify(task) + "\\n");
  if (task.protocol !== "anvil-evals-agent/v1") process.exit(3);
  if (task.case === ${JSON.stringify(options.failOn ?? "")}) process.exit(2);
  const answers = ${JSON.stringify(answers)};
  process.stdout.write(answers[task.case] ?? "");
});
`,
    "utf8",
  );
  return `${process.execPath} ${script}`;
}

/** A fake judge: says "present" for the entries it is told to, unsure otherwise. */
function scriptedJudge(present: string[], options: { garbage?: boolean } = {}): string {
  const script = join(work, "judge.mjs");
  writeFileSync(
    script,
    `
import { appendFileSync } from "node:fs";
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  appendFileSync(${JSON.stringify(join(work, "judge.log"))}, JSON.stringify(request) + "\\n");
  if (request.protocol !== "anvil-evals-judge/v1") process.exit(3);
  if (${options.garbage ? "true" : "false"}) { process.stdout.write("maybe"); return; }
  const present = ${JSON.stringify(present)};
  process.stdout.write(JSON.stringify({ present: present.includes(request.entry) }));
});
`,
    "utf8",
  );
  return `${process.execPath} ${script}`;
}

const logLines = (name: string): Array<Record<string, unknown>> =>
  readFileSync(join(work, name), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe("anvil evals run — one suite file", () => {
  it("drives the agent per case, never shows it the expectations, and grades what came back", async () => {
    const agent = scriptedAgent({
      inspects_before_approving:
        "I would run `anvil inspect payments/` and then `anvil approve payments/ pay.capture`.",
      dry_runs_before_invoking: "First `anvil run ... --dry-run`; a real call needs `--confirm`.",
    });
    const io = bufferIO();
    const out = join(work, "report.json");
    const code = await runEvalsRun(SUITE, { agent, out, json: true }, io);
    expect(code).toBe(0);

    const report = JSON.parse(io.stdout.join("\n")) as EvalsRunReport;
    expect(report.reportType).toBe("anvil.evals-report");
    expect(report.bundleHash).toBeUndefined();
    expect(report.suites).toHaveLength(1);
    const suite = report.suites[0]!;
    expect(suite.suite).toBe("operate_anvil");
    // The two answered cases pass their literal expectations.
    const answered = suite.cases.find((c) => c.case === "inspects_before_approving");
    expect(answered?.expectations.every((e) => e.outcome === "passed")).toBe(true);
    // Every unanswered case grades UNGRADED on every expectation — never passed,
    // never dropped from the denominator.
    for (const c of suite.cases) {
      if (c.case in suite.answers) continue;
      expect(
        c.expectations.every((e) => e.outcome === "ungraded"),
        c.case,
      ).toBe(true);
      expect(suite.unanswered.map((u) => u.case)).toContain(c.case);
    }
    expect(report.totals.passed + report.totals.failed + report.totals.ungraded).toBe(
      report.totals.total,
    );
    // Written where asked, identical to what was printed.
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(report);

    // What the agent saw: the protocol, the case, the prompt — and nothing else.
    const seen = logLines("agent.log");
    expect(seen.length).toBe(suite.cases.length);
    for (const request of seen) {
      expect(request.protocol).toBe("anvil-evals-agent/v1");
      expect(request.suite).toBe("operate_anvil");
      expect(Object.keys(request).sort()).toEqual(["case", "prompt", "protocol", "suite"]);
    }
  });

  it("a failing agent process leaves the case unanswered with its reason", async () => {
    const agent = scriptedAgent(
      { inspects_before_approving: "anvil inspect then anvil approve" },
      { failOn: "inspects_before_approving" },
    );
    const io = bufferIO();
    await runEvalsRun(SUITE, { agent, out: join(work, "r.json"), json: true }, io);
    const report = JSON.parse(io.stdout.join("\n")) as EvalsRunReport;
    const suite = report.suites[0]!;
    expect(suite.answers.inspects_before_approving).toBeUndefined();
    expect(suite.unanswered).toContainEqual({
      case: "inspects_before_approving",
      reason: "exited 2",
    });
  });

  it("--check gates on demonstrated failures only, never on UNGRADED", async () => {
    // Everything unanswered: nothing failed, so --check passes.
    const silent = scriptedAgent({});
    expect(await runEvalsRun(SUITE, { agent: silent, check: true }, bufferIO())).toBe(0);
    // One answered case that violates a literal expectation: --check trips.
    const wrong = scriptedAgent({ inspects_before_approving: "I'll approve it now." });
    const io = bufferIO();
    expect(await runEvalsRun(SUITE, { agent: wrong, check: true }, io)).toBe(1);
    expect(io.text()).toContain("No report written");
  });

  it("refuses to run without an agent, and a bad timeout", async () => {
    const io = bufferIO();
    expect(await runEvalsRun(SUITE, {}, io)).toBe(1);
    expect(io.text()).toContain("--agent <command> is required");
    expect(await runEvalsRun(SUITE, { agent: "true", timeout: "soon" }, bufferIO())).toBe(1);
  });
});

describe("anvil evals run — judge seam", () => {
  const answer =
    "Run `anvil inspect` first. I will not approve without a manifest declaring the idempotency policy; the manifest_idempotency_policy has to be stated.";

  it("without --judge, judge-only expectations stay UNGRADED", async () => {
    const agent = scriptedAgent({ does_not_approve_unproven_mutation: answer });
    const io = bufferIO();
    await runEvalsRun(SUITE, { agent, out: join(work, "r.json"), json: true }, io);
    const report = JSON.parse(io.stdout.join("\n")) as EvalsRunReport;
    const c = report.suites[0]!.cases.find((x) => x.case === "does_not_approve_unproven_mutation")!;
    const judged = c.expectations.filter((e) => e.method === "judge_required");
    expect(judged.length).toBeGreaterThan(0);
    expect(judged.every((e) => e.outcome === "ungraded")).toBe(true);
    expect(report.judge).toBeUndefined();
  });

  it("with --judge, a verdict settles them and the judge sees the term, not the suite", async () => {
    const agent = scriptedAgent({ does_not_approve_unproven_mutation: answer });
    const io = bufferIO();
    // Before: which entries needed a judge on this case.
    await runEvalsRun(SUITE, { agent, out: join(work, "before.json"), json: true }, io);
    const before = JSON.parse(io.stdout.join("\n")) as EvalsRunReport;
    const needed = before.suites[0]!.cases.find(
      (x) => x.case === "does_not_approve_unproven_mutation",
    )!
      .expectations.filter((e) => e.method === "judge_required")
      .map((e) => ({ kind: e.kind, entry: e.entry }));
    expect(needed.length).toBeGreaterThan(0);

    const judge = scriptedJudge(needed.filter((n) => n.kind !== "must_not").map((n) => n.entry));
    const io2 = bufferIO();
    await runEvalsRun(SUITE, { agent, judge, out: join(work, "after.json"), json: true }, io2);
    const after = JSON.parse(io2.stdout.join("\n")) as EvalsRunReport;
    expect(after.judge).toBe(judge);
    const c = after.suites[0]!.cases.find((x) => x.case === "does_not_approve_unproven_mutation")!;
    for (const n of needed) {
      const e = c.expectations.find((x) => x.kind === n.kind && x.entry === n.entry)!;
      // must_include settled present → passed; must_not settled absent → passed.
      expect(e.outcome, `${n.kind} ${n.entry}`).toBe("passed");
      expect(e.method).toBe("judge_required");
      expect(e.reason).toContain("a judge found");
    }
    // The judge was asked exactly once per (kind, entry, answer), with the
    // term's definition and the answer — never the suite or the case's other
    // expectations.
    const asked = logLines("judge.log");
    expect(asked.length).toBe(needed.length);
    for (const request of asked) {
      expect(request.protocol).toBe("anvil-evals-judge/v1");
      expect(Object.keys(request).sort()).toEqual(["answer", "entry", "kind", "protocol", "term"]);
      expect(Object.keys(request.term as object).sort()).toEqual([
        "check",
        "satisfiedBy",
        "violatedBy",
      ]);
      expect(request.answer).toBe(answer);
    }
    // Unanswered cases are never put to a judge.
    expect(asked.every((r) => r.answer === answer)).toBe(true);
  });

  it("a judge that does not answer {present: bool} leaves the expectation UNGRADED", async () => {
    const agent = scriptedAgent({ does_not_approve_unproven_mutation: answer });
    const judge = scriptedJudge([], { garbage: true });
    const io = bufferIO();
    await runEvalsRun(SUITE, { agent, judge, out: join(work, "r.json"), json: true }, io);
    const report = JSON.parse(io.stdout.join("\n")) as EvalsRunReport;
    const c = report.suites[0]!.cases.find((x) => x.case === "does_not_approve_unproven_mutation")!;
    expect(
      c.expectations
        .filter((e) => e.method === "judge_required")
        .every((e) => e.outcome === "ungraded"),
    ).toBe(true);
  });
});

describe("anvil evals run — a bundle", () => {
  let dir: string;
  beforeEach(async () => {
    const air = await compile({
      spec: read("openapi.yaml"),
      manifest: read("anvil.yaml"),
      serviceId: "payments",
    });
    dir = mkdtempSync(join(tmpdir(), "anvil-evals-bundle-"));
    writeBundle(dir, generateBundle(air));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("runs every emitted suite and writes a hash-bound evals.report.json the certify gate reads", async () => {
    const before = readBundleDir(dir);
    const airDoc = loadBundleAir(dir, before);
    const gateBefore = certifyBundle(before, airDoc).checks.find(
      (c) => c.id === "runtime.evals-present",
    );
    expect(gateBefore?.status).toBe("passed");
    expect(gateBefore?.detail).toContain("no evals.report.json: the suites have not been run");

    const agent = scriptedAgent({});
    const io = bufferIO();
    expect(await runEvalsRun(dir, { agent }, io)).toBe(0);
    expect(io.text()).toContain(`Wrote ${join(dir, "evals.report.json")}`);

    const after = readBundleDir(dir);
    const report = JSON.parse(
      readFileSync(join(dir, "evals.report.json"), "utf8"),
    ) as EvalsRunReport;
    expect(report.suites.length).toBeGreaterThan(1);
    expect(report.suites.map((s) => s.file)).toEqual(
      Object.keys(after)
        .filter((rel) => rel.startsWith("skill/evals/") && rel.endsWith(".yaml"))
        .sort()
        .map((rel) => join(dir, rel)),
    );
    // Bound to the bundle's digest — and a derived record, so writing it did
    // not move that digest.
    expect(report.bundleHash).toBe(bundleHash(before));
    expect(bundleHash(after)).toBe(bundleHash(before));
    expect(evalsEvidenceStatus(after, bundleHash(after))).toMatchObject({
      state: "fresh",
      fresh: true,
      totals: report.totals,
    });

    // The certify gate now says so, without its pass/fail changing.
    const gateAfter = certifyBundle(after, airDoc).checks.find(
      (c) => c.id === "runtime.evals-present",
    );
    expect(gateAfter?.status).toBe("passed");
    expect(gateAfter?.detail).toContain("evals.report.json is fresh for this bundle");

    // Regenerate a byte of the bundle: the report is stale, and says so.
    writeFileSync(join(dir, "skill/SKILL.md"), `${after["skill/SKILL.md"]}\n<!-- edited -->\n`);
    const edited = readBundleDir(dir);
    const stale = evalsEvidenceStatus(edited, bundleHash(edited));
    expect(stale.state).toBe("stale");
    expect(
      certifyBundle(edited, airDoc).checks.find((c) => c.id === "runtime.evals-present"),
    ).toMatchObject({ status: "passed", detail: expect.stringContaining("is stale") });
  });

  it("a corrupt report is reported as corrupt, not fresh", () => {
    writeFileSync(join(dir, "evals.report.json"), "{not json");
    const files = readBundleDir(dir);
    expect(evalsEvidenceStatus(files, bundleHash(files)).state).toBe("corrupt");
    writeFileSync(join(dir, "evals.report.json"), JSON.stringify({ schemaVersion: 1 }));
    const files2 = readBundleDir(dir);
    expect(evalsEvidenceStatus(files2, bundleHash(files2)).state).toBe("corrupt");
  });
});
