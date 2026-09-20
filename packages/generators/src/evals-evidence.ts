import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * The emitted eval suites, and the record `anvil evals run` writes about them.
 *
 * `runtime.evals-present` (certify.ts) has always checked that the suites exist
 * and parse. That is a statement about files, not about behaviour: a suite
 * nobody has run proves nothing about the harness it describes. The report a
 * run leaves behind is read here with the same freshness discipline every other
 * evidence lane gets — bound to the bundle digest it graded, so a report from
 * a previous build cannot read as current — and the gate's detail says which of
 * the three states holds: no run, a stale run, or a fresh one with its totals.
 * A missing or stale run is REPORTED, not failed: running the evals needs an
 * agent, and a bundle that has not been driven yet is unfinished rather than
 * broken.
 */

/** Where `anvil evals run` writes its report inside a bundle. */
export const EVALS_REPORT_FILE = "evals.report.json";

/** The emitted suites under `skill/evals/`. */
export function evalSuiteFiles(files: Record<string, string>): string[] {
  return Object.keys(files).filter(
    (rel) => rel.startsWith("skill/evals/") && rel.endsWith(".yaml"),
  );
}

/**
 * Why the emitted suites fail the presence gate, if they do. Suites that derive
 * zero cases are legitimately omitted (an empty file reads as phantom
 * coverage), but a bundle with NO suites must carry the README documenting the
 * omission, and every suite that is present must parse and name itself.
 */
export function evalSuiteFailures(files: Record<string, string>): string[] {
  const failures: string[] = [];
  const suites = evalSuiteFiles(files);
  if (suites.length === 0 && files["skill/evals/README.md"] === undefined) {
    failures.push(
      "no generated eval suites under skill/evals/ and no skill/evals/README.md documenting their omission",
    );
  }
  for (const rel of suites) {
    try {
      const doc = parseYaml(files[rel] ?? "") as { suite?: unknown };
      if (typeof doc?.suite !== "string") failures.push(`${rel} has no suite name`);
    } catch {
      failures.push(`${rel} is not valid YAML`);
    }
  }
  return failures;
}

/** The envelope this reader needs: digest binding plus the totals. */
const EvalsEvidenceReport = z.object({
  schemaVersion: z.literal(1),
  reportType: z.literal("anvil.evals-report"),
  bundleHash: z.string().optional(),
  totals: z.object({
    passed: z.number().int().min(0),
    failed: z.number().int().min(0),
    ungraded: z.number().int().min(0),
    total: z.number().int().min(0),
  }),
});
export type EvalsEvidenceTotals = z.infer<typeof EvalsEvidenceReport>["totals"];

export interface EvalsEvidenceStatus {
  file: typeof EVALS_REPORT_FILE;
  state: "fresh" | "missing" | "corrupt" | "stale";
  fresh: boolean;
  bundleHash: string | null;
  totals: EvalsEvidenceTotals | null;
  /** One line a gate can append verbatim. */
  detail: string;
}

/** The eval run's relationship to the bundle digest `currentBundleHash`. */
export function evalsEvidenceStatus(
  files: Record<string, string>,
  currentBundleHash: string,
): EvalsEvidenceStatus {
  const file = EVALS_REPORT_FILE;
  const raw = files[file];
  const absent = (state: "missing" | "corrupt", detail: string): EvalsEvidenceStatus => ({
    file,
    state,
    fresh: false,
    bundleHash: null,
    totals: null,
    detail,
  });
  if (raw === undefined) return absent("missing", `no ${file}: the suites have not been run`);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return absent("corrupt", `${file} is not valid JSON`);
  }
  const parsed = EvalsEvidenceReport.safeParse(value);
  if (!parsed.success) return absent("corrupt", `${file} does not match its report schema`);
  const report = parsed.data;
  const totals = report.totals;
  const summary = `${totals.passed}/${totals.total} passed, ${totals.failed} failed, ${totals.ungraded} ungraded`;
  if (report.bundleHash !== currentBundleHash) {
    return {
      file,
      state: "stale",
      fresh: false,
      bundleHash: report.bundleHash ?? null,
      totals,
      detail: `${file} is stale: graded ${(report.bundleHash ?? "an unbound").slice(0, 12)}… but the bundle now hashes to ${currentBundleHash.slice(0, 12)}…`,
    };
  }
  return {
    file,
    state: "fresh",
    fresh: true,
    bundleHash: report.bundleHash ?? null,
    totals,
    detail: `${file} is fresh for this bundle: ${summary}`,
  };
}
