import { writeFileSync } from "node:fs";
import { join } from "node:path";

const cell = (value) => String(value ?? "—").replaceAll("|", "\\|").replaceAll(/\s+/g, " ");
export function summarize(report) {
  const totals = {};
  for (const row of report.results) totals[row.status] = (totals[row.status] ?? 0) + 1;
  const operations = report.results.reduce((sum, row) => sum + (row.metrics?.operations ?? 0), 0);
  const lines = [
    "# Enterprise API conversion corpus", "",
    `Run: ${report.startedAt}. Base Git tree: \`${report.gitTree}\`. Uncommitted changes: ${report.worktreeDirty}.`, "",
    `Implementation SHA-256: \`${report.implementationSha256}\`.`, "",
    `${report.results.length} contracts selected; ${operations} operations in generated bundles.`, "",
    Object.entries(totals).map(([status, count]) => `${status}: **${count}**`).join(" · "), "",
    "These results test downloaded contract conversion and generated artifacts. They do not certify a vendor tenant, production credentials, business semantics, or deployed Gemini Enterprise registration. No vendor API operations are invoked.", "",
    "| Contract | Publisher / scope | Result | Operations | Approved / review / blocked | Checks failing |",
    "|---|---|---|---:|---:|---|",
  ];
  for (const row of report.results) lines.push(`| ${cell(row.name)} | ${cell(row.provenance)} | ${row.status} | ${row.metrics?.operations ?? "—"} | ${row.metrics ? `${row.metrics.approved} / ${row.metrics.reviewRequired} / ${row.metrics.blocked ?? "—"}` : "—"} | ${cell(row.checks?.filter((c) => !c.ok).map((c) => c.name).join(", ") || row.detail || "—")} |`);
  lines.push("", "## Source provenance", "", "| Contract | SHA-256 | Bytes | Source |", "|---|---|---:|---|");
  for (const row of report.results) lines.push(`| ${row.id} | ${row.source?.sha256 ? `\`${row.source.sha256}\`` : "—"} | ${row.source?.bytes ?? "—"} | [source](${row.url}) |`);
  lines.push("", "## Findings", "");
  for (const row of report.results) {
    const failed = row.checks?.filter((c) => !c.ok) ?? [];
    if (row.detail || failed.length) {
      lines.push(`### ${row.name}`, "");
      if (row.detail) lines.push(cell(row.detail), "");
      for (const finding of failed) lines.push(`- **${finding.name}:** ${cell(finding.detail)}`);
      lines.push("");
    }
  }
  return `${lines.join("\n")}\n`;
}

export function writeReport(report, directory) {
  writeFileSync(join(directory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(directory, "summary.md"), summarize(report));
}
