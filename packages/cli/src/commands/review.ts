import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentDriver,
  haikuReviewDriver,
  ReviewContextSecurityError,
  ReviewDriverUnavailableError,
  ReviewOutputError,
  type ReviewReport,
  runArtifactReview,
  SEVERITIES,
} from "@anvil/refinement";
import type { Command } from "commander";
import type { CliIO } from "../io.js";
import { resolveBundleDir } from "./certify.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";

/** Where the review report is written inside a bundle. */
export const REVIEW_REPORT_FILE = "review.report.json";

/**
 * `anvil review <bundle-dir>` — the model-driven semantic review. Deterministic
 * gates (`anvil certify`) judge structure; this drives a cheap reviewer model
 * with a rigorous SOP over the layer only a reader can judge: are the tool
 * descriptions truthful to AIR, is the CLI surface honest, does the skill teach
 * the safety posture, do the surfaces agree. Findings are evidence-grounded
 * (mechanically re-verified) and feed the deficiency catalog. When the driver
 * cannot run, the command fails with a structured `review/driver_unavailable`
 * error — never a crash, never a fake pass.
 */
export function registerReview(parent: Command, ctx: CommandContext): void {
  annotate(
    parent
      .command("review")
      .summary("Model-driven semantic review of a bundle's agent surfaces (MCP/CLI/skill).")
      .description(
        "Drives a cheap reviewer model (default Haiku via the `claude` CLI) through Anvil's artifact-review SOP over a generated bundle: MCP tool descriptions must be truthful to each operation's effect/risk, the CLI surface must teach confirm/idempotency/dry-run on mutating commands, the skill doc must teach the safety posture and document no phantom operations, and all three surfaces must agree. Every finding must cite verbatim evidence from the bundle; ungrounded findings are discarded mechanically. Native execution is unsandboxed and therefore fails closed unless --allow-degraded-native is supplied; its HOME is isolated and credentials are delivered only through the Claude credential profile. Writes review.report.json into the bundle.",
      )
      .argument("<dir>", "generated bundle directory (or its air.yaml/air.json)")
      .option("--model <model>", "reviewer model passed to the driver", "haiku")
      .option("--driver-command <bin>", "headless agent CLI to drive", "claude")
      .option(
        "--allow-degraded-native",
        "explicitly allow the unsandboxed native reviewer (isolated HOME; host files remain reachable)",
      )
      .option("--json", "emit the full review report as JSON")
      .action(async (dir: string, opts: ReviewOptions) => {
        ctx.code = await runReview(dir, opts, ctx.io, { driver: ctx.deps.reviewDriver });
      }),
    { mutates: true },
  );
}

export interface ReviewOptions {
  model?: string;
  driverCommand?: string;
  allowDegradedNative?: boolean;
  json?: boolean;
}

/** The review action, with an injectable driver so tests never spawn an agent. */
export async function runReview(
  path: string,
  opts: ReviewOptions,
  io: CliIO,
  deps: { driver?: AgentDriver } = {},
): Promise<number> {
  const dir = resolveBundleDir(path);
  const driver =
    deps.driver ??
    haikuReviewDriver({
      command: opts.driverCommand,
      model: opts.model,
      allowDegradedNative: opts.allowDegradedNative,
    });

  if (!deps.driver && opts.allowDegradedNative === true) {
    io.err(
      "WARNING: native model review has host network and cannot enforce a workspace-only filesystem. HOME is isolated and only the Claude credential profile is inherited.",
    );
  }

  let report: ReviewReport;
  try {
    report = await runArtifactReview(dir, driver, { model: opts.model });
  } catch (err) {
    if (err instanceof ReviewDriverUnavailableError) {
      io.err(`anvil: error ${err.code} — ${err.message}`);
      io.err("  The review needs a headless agent CLI. Check:");
      io.err(`  - \`${opts.driverCommand ?? "claude"}\` is installed and on PATH`);
      io.err(
        "  - ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN is exported (review uses an isolated HOME)",
      );
      io.err("  - or point --driver-command at another headless agent CLI");
      io.err("  - native execution also requires --allow-degraded-native; omit it to fail closed");
      io.err("  No report was written; this is not a pass.");
      return 1;
    }
    if (err instanceof ReviewContextSecurityError) {
      io.err(`anvil: error ${err.code} — ${err.message}`);
      io.err("  No model was invoked and no report was written.");
      return 1;
    }
    if (err instanceof ReviewOutputError) {
      io.err(`anvil: error ${err.code} — ${err.message}`);
      io.err("  The driver ran but never produced valid review JSON. No report was written.");
      return 1;
    }
    throw err;
  }

  writeFileSync(join(dir, REVIEW_REPORT_FILE), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (opts.json === true) {
    io.out(JSON.stringify(report, null, 2));
  } else {
    io.out(renderReviewSummary(report, join(dir, REVIEW_REPORT_FILE)));
  }
  return 0;
}

/** The human triage: counts, then findings worst-first with their evidence. */
export function renderReviewSummary(report: ReviewReport, reportPath: string): string {
  const lines: string[] = [];
  lines.push(
    `Artifact review — ${report.bundle.serviceId} @ ${report.bundle.serviceVersion}  (model ${report.model})`,
  );
  const sev = [...SEVERITIES]
    .reverse()
    .map((s) => `${s} ${report.summary.bySeverity[s] ?? 0}`)
    .join("  ·  ");
  lines.push(`  Findings   ${report.findings.length}   (${sev})`);
  lines.push(`  Discarded  ${report.discarded.length} (evidence failed mechanical grounding)`);
  for (const f of report.findings) {
    lines.push("");
    lines.push(
      `  [${f.severity.padEnd(8)}] ${f.code}  (${f.artifact}${f.opId ? ` · ${f.opId}` : ""})`,
    );
    lines.push(`    ${f.claim}`);
    lines.push(`    evidence: ${f.evidence.file}${f.evidence.path ? ` @ ${f.evidence.path}` : ""}`);
    lines.push(
      `      "${f.evidence.excerpt.length > 120 ? `${f.evidence.excerpt.slice(0, 120)}…` : f.evidence.excerpt}"`,
    );
    if (f.suggestion) lines.push(`    suggestion: ${f.suggestion}`);
  }
  if (report.reviewerNotes) {
    lines.push("");
    lines.push(`  Reviewer notes: ${report.reviewerNotes}`);
  }
  lines.push("");
  lines.push(`Wrote ${reportPath}.`);
  lines.push(
    report.findings.length === 0
      ? "No grounded findings. The semantic layer reads clean to this reviewer."
      : "Findings map to catalog deficiencies — triage with the severity rubric; blocking/high first.",
  );
  return lines.join("\n");
}
