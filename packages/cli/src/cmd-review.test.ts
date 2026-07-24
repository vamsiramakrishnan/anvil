import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "@anvil/compiler";
import { generateBundle, writeBundle } from "@anvil/generators";
import { ScriptedAgentDriver } from "@anvil/refinement";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAnvilCli } from "./anvil-cli.js";
import { REVIEW_REPORT_FILE, runReview } from "./commands/review.js";
import { bufferIO } from "./io.js";

const examples = fileURLToPath(new URL("../../../examples/payments/", import.meta.url));
const read = (rel: string) => readFileSync(join(examples, rel), "utf8");

let dir: string;
beforeEach(async () => {
  const air = await compile({
    spec: read("openapi.yaml"),
    manifest: read("anvil.yaml"),
    serviceId: "payments",
  });
  dir = mkdtempSync(join(tmpdir(), "anvil-review-cli-"));
  writeBundle(dir, generateBundle(air));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A reviewer that files one grounded finding, citing real text from the bundle. */
function groundedDriver(): ScriptedAgentDriver {
  // The excerpt must exist verbatim in the bundle's catalog.json for grounding.
  const excerpt = readFileSync(join(dir, "catalog.json"), "utf8").slice(0, 60);
  return new ScriptedAgentDriver((caseDir) => {
    mkdirSync(join(caseDir, "output"), { recursive: true });
    writeFileSync(
      join(caseDir, "output", "review.json"),
      JSON.stringify({
        findings: [
          {
            id: "f1",
            artifact: "mcp",
            code: "missing_operation_description",
            severity: "medium",
            evidence: { file: "catalog.json", excerpt },
            claim: "Example grounded finding for the CLI plumbing test.",
          },
        ],
        reviewerNotes: "scripted",
      }),
      "utf8",
    );
  });
}

describe("anvil review", () => {
  it("writes review.report.json and prints a human summary", async () => {
    const io = bufferIO();
    const code = await runReview(dir, { model: "haiku" }, io, { driver: groundedDriver() });
    expect(code).toBe(0);
    const report = JSON.parse(readFileSync(join(dir, REVIEW_REPORT_FILE), "utf8"));
    expect(report.schemaVersion).toBe(1);
    expect(report.bundleHash).toMatch(/^[a-f0-9]{64}$/);
    expect(report.findings).toHaveLength(1);
    expect(report.model).toBe("haiku");
    expect(io.text()).toContain("Artifact review — payments");
    expect(io.text()).toContain("missing_operation_description");
    expect(io.text()).toContain(REVIEW_REPORT_FILE);
  });

  it("emits the full report with --json", async () => {
    const io = bufferIO();
    const code = await runReview(dir, { json: true }, io, { driver: groundedDriver() });
    expect(code).toBe(0);
    const printed = JSON.parse(io.stdout.join("\n"));
    expect(printed.findings[0].id).toBe("f1");
  });

  it("fails with review/driver_unavailable when the driver binary does not exist", async () => {
    const io = bufferIO();
    const code = await runReview(
      dir,
      {
        driverCommand: "/definitely/not/a/real/agent-binary",
        allowDegradedNative: true,
      },
      io,
      {},
    );
    expect(code).toBe(1);
    expect(io.stderr.join("\n")).toContain("review/driver_unavailable");
    expect(io.stderr.join("\n")).toContain("No report was written");
    // Never a fake pass: no report appears on failure.
    expect(existsSync(join(dir, REVIEW_REPORT_FILE))).toBe(false);
  });

  it("fails closed before launching the default native reviewer without explicit consent", async () => {
    const io = bufferIO();
    const code = await runReview(
      dir,
      { driverCommand: "/definitely/not/a/real/agent-binary" },
      io,
      {},
    );
    expect(code).toBe(1);
    expect(io.stderr.join("\n")).toContain("--allow-degraded-native");
    expect(io.stderr.join("\n")).toContain("isolated HOME");
    expect(existsSync(join(dir, REVIEW_REPORT_FILE))).toBe(false);
  });

  it("fails with review/invalid_output when the model never produces valid JSON", async () => {
    const io = bufferIO();
    const driver = new ScriptedAgentDriver((caseDir) => {
      mkdirSync(join(caseDir, "output"), { recursive: true });
      writeFileSync(join(caseDir, "output", "review.json"), "not json", "utf8");
    });
    const code = await runReview(dir, {}, io, { driver });
    expect(code).toBe(1);
    expect(io.stderr.join("\n")).toContain("review/invalid_output");
    expect(existsSync(join(dir, REVIEW_REPORT_FILE))).toBe(false);
  });

  it("registers in the command tree with its flags", async () => {
    const io = bufferIO();
    const code = await runAnvilCli(["review", "--help"], { io });
    expect(code).toBe(0);
    const help = io.text();
    expect(help).toContain("--model");
    expect(help).toContain("--driver-command");
    expect(help).toContain("--allow-degraded-native");
    expect(help).toContain("--json");
  });
});
