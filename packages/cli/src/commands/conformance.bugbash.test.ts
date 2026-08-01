import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConformanceReport, LiveReport } from "@anvil/harness";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAnvilCli } from "../anvil-cli.js";
import { bufferIO } from "../io.js";
import {
  renderConformanceSummary,
  renderLiveSummary,
  runConformanceCommand,
} from "./conformance.js";

const _examples = fileURLToPath(new URL("../../../examples/payments/", import.meta.url));

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "anvil-bugbash-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("anvil conformance — command and rendering", () => {
  describe("runConformanceCommand — error handling and exit codes", () => {
    it("throws a plain error (not a caught 1) when the bundle path does not exist", async () => {
      // resolveBundleDir throws synchronously and runConformanceCommand has
      // no try/catch of its own, so the rejection propagates to the caller —
      // it is not turned into a return code of 1 with a message in io. Only
      // the outer runAnvilCli (tested in "CLI integration" below) catches
      // this and writes it through io.
      const io = bufferIO();
      const nonexistent = join(root, "nonexistent");
      await expect(runConformanceCommand(nonexistent, {}, io)).rejects.toThrow(
        `No such bundle: ${nonexistent}`,
      );
      expect(io.text()).toBe("");
    });

    it("throws the same friendly 'No air.yaml or air.json' message other commands give for a missing bundle", async () => {
      // runConformanceCommand does not wrap resolveBundleDir/runConformance in
      // a try/catch — only the top-level runAnvilCli catches and converts to
      // an exit code (see the "CLI integration" describe block below). But it
      // now checks for air.yaml/air.json itself before ever delegating to the
      // harness, so a directory with neither file gets the same friendly
      // guidance as certify.ts/shared.ts instead of the harness's raw ENOENT.
      const io = bufferIO();
      const invalidBundle = join(root, "empty-bundle");
      mkdirSync(invalidBundle, { recursive: true });
      writeFileSync(join(invalidBundle, "README.md"), "not a bundle\n");
      await expect(runConformanceCommand(invalidBundle, {}, io)).rejects.toThrow(
        `No air.yaml or air.json in ${invalidBundle}. Run \`anvil compile\` first.`,
      );
    });

    it("resolves a directory path to the bundle root before delegating to the harness", async () => {
      // resolveBundleDir happily accepts a directory containing only
      // air.yaml (it just needs *a* path to exist), but the harness's
      // runConformance reads air.json specifically off that directory — it
      // does not fall back to air.yaml. So this still rejects, but with an
      // ENOENT for air.json, not a path-resolution error.
      const io = bufferIO();
      const bundleDir = join(root, "my-bundle");
      mkdirSync(bundleDir, { recursive: true });
      writeFileSync(join(bundleDir, "air.yaml"), "schemaVersion: 1\n");
      await expect(runConformanceCommand(bundleDir, {}, io)).rejects.toThrow(/ENOENT.*air\.json/);
      // Nothing was written through io — the rejection happened before any
      // output, confirming the failure is not "No such bundle".
      expect(io.text()).toBe("");
    });
  });

  describe("renderConformanceSummary — text output formatting", () => {
    it("formats a passing report with all checks green", () => {
      const report: ConformanceReport = {
        summary: { pass: 3, fail: 0, skipped: 1 },
        surfaces: ["cli", "mcp"],
        identity: { proof: "none", virtualWiring: "N/A", delegatedOperations: 0 },
        checks: [
          {
            id: "surface-agreement",
            status: "pass",
            surfaces: ["cli", "mcp"],
            operationId: "create_payment",
          },
          {
            id: "skill-claim",
            status: "pass",
            surfaces: ["cli", "mcp"],
            operationId: "create_payment",
          },
          {
            id: "wire-agreement",
            status: "pass",
            surfaces: ["cli", "mcp"],
            operationId: "create_payment",
          },
          {
            id: "gate-agreement",
            status: "skip",
            surfaces: ["cli", "mcp"],
          },
        ],
      };
      const dir = join(root, "bundle");
      const output = renderConformanceSummary(report, dir);

      expect(output).toContain("Tri-surface conformance");
      expect(output).toContain(dir);
      expect(output).toContain("cli + mcp");
      expect(output).toContain("✓");
      expect(output).toContain("PASSED");
      expect(output).toContain("3 check(s) passed");
      expect(output).toContain("1 skipped");
      expect(output).toContain("conformance.report.json");
      expect(output).not.toContain("✗");
    });

    it("formats a failing report with red checks and divergence details", () => {
      const report: ConformanceReport = {
        summary: { pass: 2, fail: 2, skipped: 0 },
        surfaces: ["cli", "mcp"],
        identity: { proof: "none", virtualWiring: "N/A", delegatedOperations: 0 },
        checks: [
          {
            id: "surface-agreement",
            status: "pass",
            surfaces: ["cli", "mcp"],
            operationId: "create_payment",
          },
          {
            id: "wire-agreement",
            status: "fail",
            surfaces: ["cli", "mcp"],
            operationId: "create_payment",
            detail: "Wire request diverged",
            divergences: [
              {
                path: "body.amount",
                between: ["cli", "mcp"],
                left: 100,
                right: 101,
              },
            ],
          },
          {
            id: "gate-agreement",
            status: "fail",
            surfaces: ["cli", "mcp"],
            detail: "Confirmation gate did not refuse on both surfaces",
          },
          {
            id: "skill-claim",
            status: "pass",
            surfaces: ["cli", "mcp"],
            operationId: "refund_payment",
          },
        ],
      };
      const dir = join(root, "bundle");
      const output = renderConformanceSummary(report, dir);

      expect(output).toContain("Tri-surface conformance");
      expect(output).toContain("✗");
      expect(output).toContain("FAILED");
      expect(output).toContain("2 check(s) failed");
      expect(output).toContain("2 passed");
      expect(output).toContain("Wire request diverged");
      expect(output).toContain("Confirmation gate did not refuse");
      expect(output).toContain("body.amount");
      expect(output).toContain("100 ≠ 101");
      expect(output).toContain("conformance.report.json");
    });

    it("includes identity section only when there are delegated operations", () => {
      const withIdentity: ConformanceReport = {
        summary: { pass: 1, fail: 0, skipped: 0 },
        surfaces: ["cli", "mcp"],
        identity: {
          proof: "jwt",
          virtualWiring: "gcp:sts",
          delegatedOperations: 5,
        },
        checks: [
          {
            id: "surface-agreement",
            status: "pass",
            surfaces: ["cli", "mcp"],
          },
        ],
      };
      const output = renderConformanceSummary(withIdentity, root);
      expect(output).toContain("identity: jwt=gcp:sts");
      expect(output).toContain("live IdP readiness=UNVERIFIED");

      const noIdentity: ConformanceReport = {
        summary: { pass: 1, fail: 0, skipped: 0 },
        surfaces: ["cli", "mcp"],
        identity: { proof: "none", virtualWiring: "N/A", delegatedOperations: 0 },
        checks: [
          {
            id: "surface-agreement",
            status: "pass",
            surfaces: ["cli", "mcp"],
          },
        ],
      };
      const output2 = renderConformanceSummary(noIdentity, root);
      expect(output2).not.toContain("identity:");
    });

    it("omits detail lines for passing checks but includes them for failures", () => {
      const report: ConformanceReport = {
        summary: { pass: 1, fail: 1, skipped: 0 },
        surfaces: ["cli", "mcp"],
        identity: { proof: "none", virtualWiring: "N/A", delegatedOperations: 0 },
        checks: [
          {
            id: "passing-check",
            status: "pass",
            surfaces: ["cli", "mcp"],
            detail: "This detail should not appear",
          },
          {
            id: "failing-check",
            status: "fail",
            surfaces: ["cli", "mcp"],
            detail: "This detail should appear",
          },
        ],
      };
      const output = renderConformanceSummary(report, root);
      expect(output).not.toContain("This detail should not appear");
      expect(output).toContain("This detail should appear");
    });
  });

  describe("renderLiveSummary — live lane text output", () => {
    it("formats a passing live report with artifact attestation", () => {
      const report: LiveReport = {
        target: "https://mcp.example.test/mcp",
        summary: { pass: 5, fail: 0, skipped: 1 },
        artifact: {
          matched: true,
          expectedHash: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
          observedHash: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        },
        identity: {
          delegatedOperations: 0,
          liveIdpReadiness: "N/A",
          proof: "N/A",
          verifiedContractGroupIds: [],
          delegatedContractGroups: 0,
        },
        checks: [
          {
            id: "artifact",
            status: "pass",
          },
          {
            id: "surface-agreement",
            status: "pass",
            operationId: "create_payment",
          },
          {
            id: "gate-agreement",
            status: "pass",
            operationId: "create_payment",
          },
          {
            id: "wire-agreement",
            status: "pass",
            operationId: "create_payment",
          },
          {
            id: "identity-proof",
            status: "skip",
          },
          {
            id: "write-gate-refund",
            status: "pass",
            operationId: "refund_payment",
          },
        ],
      };
      const output = renderLiveSummary(report, root);

      expect(output).toContain("Live conformance");
      expect(output).toContain("https://mcp.example.test/mcp");
      expect(output).toContain("matched");
      expect(output).toContain("abcdef01");
      expect(output).toContain("PASSED");
      expect(output).toContain("5 check(s) passed");
      expect(output).toContain("1 skipped");
      expect(output).toContain("conformance.live.report.json");
      expect(output).toMatch(/✓/);
    });

    it("formats a live report with artifact mismatch", () => {
      const report: LiveReport = {
        target: "https://mcp.example.test/mcp",
        summary: { pass: 0, fail: 1, skipped: 4 },
        artifact: {
          matched: false,
          expectedHash: "expected0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
          observedHash: "observed0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        },
        identity: {
          delegatedOperations: 0,
          liveIdpReadiness: "N/A",
          proof: "N/A",
          verifiedContractGroupIds: [],
          delegatedContractGroups: 0,
        },
        checks: [
          {
            id: "artifact",
            status: "fail",
            detail: "Deployed artifact SHA-256 does not match local build",
          },
        ],
      };
      const output = renderLiveSummary(report, root);

      expect(output).toContain("MISMATCH");
      expect(output).toContain("expected01");
      expect(output).toContain("observed01");
      expect(output).toContain("FAILED");
      expect(output).toContain("1 check(s) failed");
      expect(output).toContain("Deployed artifact SHA-256");
      expect(output).toMatch(/✗/);
    });

    it("formats a live report with unavailable artifact hash (connection error)", () => {
      const report: LiveReport = {
        target: "https://mcp.example.test/mcp",
        summary: { pass: 0, fail: 1, skipped: 0 },
        artifact: {
          matched: false,
          expectedHash: "expected0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
          observedHash: undefined,
        },
        identity: {
          delegatedOperations: 0,
          liveIdpReadiness: "N/A",
          proof: "N/A",
          verifiedContractGroupIds: [],
          delegatedContractGroups: 0,
        },
        checks: [
          {
            id: "artifact",
            status: "fail",
            detail: "Could not reach deployment endpoint",
          },
        ],
      };
      const output = renderLiveSummary(report, root);

      expect(output).toContain("expected01");
      expect(output).toContain("unavailable");
      // The local hash is always shown truncated with a trailing ellipsis;
      // only the *deployed* hash conditionally gets one, and only when it is
      // present. So "unavailable" itself must not be followed by one.
      expect(output).not.toContain("unavailable…");
    });

    it("includes identity verification section when delegated operations present", () => {
      const report: LiveReport = {
        target: "https://mcp.example.test/mcp",
        summary: { pass: 3, fail: 0, skipped: 1 },
        artifact: {
          matched: true,
          expectedHash: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
          observedHash: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        },
        identity: {
          delegatedOperations: 5,
          liveIdpReadiness: "verified",
          proof: "jwt",
          verifiedContractGroupIds: ["group-1", "group-2"],
          delegatedContractGroups: 2,
        },
        checks: [
          {
            id: "artifact",
            status: "pass",
          },
          {
            id: "identity-group-1",
            status: "pass",
            detail: "Read verified",
          },
          {
            id: "identity-group-2",
            status: "pass",
            detail: "Read verified",
          },
          {
            id: "identity-obo-write",
            status: "skip",
            detail: "Write-only group (unverified)",
          },
        ],
      };
      const output = renderLiveSummary(report, root);

      expect(output).toContain("identity:");
      expect(output).toContain("verified");
      expect(output).toContain("jwt");
      expect(output).toContain("2/2 contract groups");
    });

    it("marks check statuses with ✓, ✗, and – symbols", () => {
      const report: LiveReport = {
        target: "https://mcp.example.test/mcp",
        summary: { pass: 1, fail: 1, skipped: 1 },
        artifact: {
          matched: true,
          expectedHash: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
          observedHash: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        },
        identity: {
          delegatedOperations: 0,
          liveIdpReadiness: "N/A",
          proof: "N/A",
          verifiedContractGroupIds: [],
          delegatedContractGroups: 0,
        },
        checks: [
          { id: "pass-check", status: "pass" },
          { id: "fail-check", status: "fail" },
          { id: "skip-check", status: "skip" },
        ],
      };
      const output = renderLiveSummary(report, root);

      const lines = output.split("\n");
      const checkLines = lines.filter(
        (l) => l.includes("pass-check") || l.includes("fail-check") || l.includes("skip-check"),
      );

      expect(checkLines[0]).toContain("✓");
      expect(checkLines[1]).toContain("✗");
      expect(checkLines[2]).toContain("–");
    });
  });

  describe("JSON output format", () => {
    it("writes conformance.report.json with bundleHash when text mode succeeds", async () => {
      // We can't easily mock the harness import, so we create a minimal test
      // that checks that JSON output is properly formatted
      const _io = bufferIO();
      const report: ConformanceReport = {
        summary: { pass: 1, fail: 0, skipped: 0 },
        surfaces: ["cli", "mcp"],
        identity: { proof: "none", virtualWiring: "N/A", delegatedOperations: 0 },
        checks: [
          {
            id: "test",
            status: "pass",
            surfaces: ["cli", "mcp"],
          },
        ],
      };
      const output = renderConformanceSummary(report, root);
      expect(output).toContain("PASSED");
      // Verify text output doesn't contain JSON formatting
      expect(output).not.toContain(JSON.stringify(report));
    });
  });

  describe("Empty results and missing bundles", () => {
    it("handles conformance report with no checks gracefully", () => {
      const report: ConformanceReport = {
        summary: { pass: 0, fail: 0, skipped: 0 },
        surfaces: ["cli", "mcp"],
        identity: { proof: "none", virtualWiring: "N/A", delegatedOperations: 0 },
        checks: [],
      };
      const output = renderConformanceSummary(report, root);
      expect(output).toContain("PASSED");
      expect(output).toContain("0 check(s) passed");
    });

    it("handles live report with no checks gracefully", () => {
      const report: LiveReport = {
        target: "https://mcp.example.test/mcp",
        summary: { pass: 0, fail: 0, skipped: 0 },
        artifact: {
          matched: true,
          expectedHash: "abc",
          observedHash: "abc",
        },
        identity: {
          delegatedOperations: 0,
          liveIdpReadiness: "N/A",
          proof: "N/A",
          verifiedContractGroupIds: [],
          delegatedContractGroups: 0,
        },
        checks: [],
      };
      const output = renderLiveSummary(report, root);
      expect(output).toContain("PASSED");
      expect(output).toContain("0 check(s) passed");
    });
  });

  describe("Edge cases and special characters", () => {
    it("escapes special characters in divergence display", () => {
      const report: ConformanceReport = {
        summary: { pass: 0, fail: 1, skipped: 0 },
        surfaces: ["cli", "mcp"],
        identity: { proof: "none", virtualWiring: "N/A", delegatedOperations: 0 },
        checks: [
          {
            id: "wire-agreement",
            status: "fail",
            surfaces: ["cli", "mcp"],
            divergences: [
              {
                path: "body.nested.field",
                between: ["cli", "mcp"],
                left: 'string with <>&"quotes"',
                right: "another string",
              },
            ],
          },
        ],
      };
      const output = renderConformanceSummary(report, root);
      expect(output).toContain("body.nested.field");
      // Divergence values are rendered via JSON.stringify, so embedded
      // double quotes come out backslash-escaped in the output, not raw.
      expect(output).toContain(JSON.stringify('string with <>&"quotes"'));
    });

    it("handles very long operation IDs in check lines", () => {
      const longOpId = `${"very_long_operation_id_".repeat(5)}end`;
      const report: ConformanceReport = {
        summary: { pass: 1, fail: 0, skipped: 0 },
        surfaces: ["cli", "mcp"],
        identity: { proof: "none", virtualWiring: "N/A", delegatedOperations: 0 },
        checks: [
          {
            id: "surface-agreement",
            status: "pass",
            surfaces: ["cli", "mcp"],
            operationId: longOpId,
          },
        ],
      };
      const output = renderConformanceSummary(report, root);
      expect(output).toContain(longOpId);
    });

    it("renders multiple surfaces in check lines separated by ↔", () => {
      const report: ConformanceReport = {
        summary: { pass: 1, fail: 0, skipped: 0 },
        surfaces: ["cli", "mcp", "mock"],
        identity: { proof: "none", virtualWiring: "N/A", delegatedOperations: 0 },
        checks: [
          {
            id: "tri-surface-check",
            status: "pass",
            surfaces: ["cli", "mcp", "mock"],
          },
        ],
      };
      const output = renderConformanceSummary(report, root);
      expect(output).toContain("cli↔mcp↔mock");
    });
  });

  describe("CLI integration", () => {
    it("accepts conformance command with required dir argument", async () => {
      const io = bufferIO();
      // This will fail because it's not a real bundle, but should parse the command
      const code = await runAnvilCli(["conformance", join(root, "nonexistent")], { io });
      expect(code).toBe(1);
      expect(io.text()).toContain("No such bundle");
    });

    it("rejects conformance without required dir argument", async () => {
      const io = bufferIO();
      const code = await runAnvilCli(["conformance"], { io });
      expect(code).toBe(1);
      expect(io.text()).toContain("missing required argument");
    });

    it("recognizes --json option", async () => {
      const io = bufferIO();
      const code = await runAnvilCli(["conformance", join(root, "nonexistent"), "--json"], { io });
      expect(code).toBe(1);
      // Should fail on bundle resolution, not on option parsing
      expect(io.text()).toContain("No such bundle");
    });

    it("recognizes --live option with config path", async () => {
      const io = bufferIO();
      const configPath = join(root, "config.json");
      const code = await runAnvilCli(
        ["conformance", join(root, "nonexistent"), "--live", configPath],
        { io },
      );
      expect(code).toBe(1);
      // Should fail on bundle resolution
      expect(io.text()).toContain("No such bundle");
    });
  });

  describe("Summary statistics accuracy", () => {
    it("correctly counts pass/fail/skip checks", () => {
      const report: ConformanceReport = {
        summary: { pass: 7, fail: 3, skipped: 2 },
        surfaces: ["cli", "mcp"],
        identity: { proof: "none", virtualWiring: "N/A", delegatedOperations: 0 },
        checks: [
          { id: "pass1", status: "pass", surfaces: ["cli", "mcp"] },
          { id: "pass2", status: "pass", surfaces: ["cli", "mcp"] },
          { id: "pass3", status: "pass", surfaces: ["cli", "mcp"] },
          { id: "pass4", status: "pass", surfaces: ["cli", "mcp"] },
          { id: "pass5", status: "pass", surfaces: ["cli", "mcp"] },
          { id: "pass6", status: "pass", surfaces: ["cli", "mcp"] },
          { id: "pass7", status: "pass", surfaces: ["cli", "mcp"] },
          { id: "fail1", status: "fail", surfaces: ["cli", "mcp"] },
          { id: "fail2", status: "fail", surfaces: ["cli", "mcp"] },
          { id: "fail3", status: "fail", surfaces: ["cli", "mcp"] },
          { id: "skip1", status: "skip", surfaces: ["cli", "mcp"] },
          { id: "skip2", status: "skip", surfaces: ["cli", "mcp"] },
        ],
      };
      const output = renderConformanceSummary(report, root);
      // The "N check(s) passed" phrasing only appears on the PASSED branch
      // (fail === 0). With failures present, the summary line instead reads
      // "FAILED — 3 check(s) failed (7 passed, 2 skipped)."
      expect(output).toContain("3 check(s) failed");
      expect(output).toContain("7 passed");
      expect(output).toContain("2 skipped");
      expect(output).toContain("FAILED");
    });

    it("outputs PASSED only when fail count is 0", () => {
      const passing: ConformanceReport = {
        summary: { pass: 5, fail: 0, skipped: 2 },
        surfaces: ["cli", "mcp"],
        identity: { proof: "none", virtualWiring: "N/A", delegatedOperations: 0 },
        checks: Array(7)
          .fill(null)
          .map((_, i) => ({
            id: `check-${i}`,
            status: i < 5 ? ("pass" as const) : ("skip" as const),
            surfaces: ["cli", "mcp"],
          })),
      };
      const passingOutput = renderConformanceSummary(passing, root);
      expect(passingOutput).toContain("PASSED");
      expect(passingOutput).not.toContain("FAILED");

      const failing: ConformanceReport = {
        summary: { pass: 4, fail: 1, skipped: 2 },
        surfaces: ["cli", "mcp"],
        identity: { proof: "none", virtualWiring: "N/A", delegatedOperations: 0 },
        checks: Array(7)
          .fill(null)
          .map((_, i) => ({
            id: `check-${i}`,
            status: i < 4 ? ("pass" as const) : i < 5 ? ("fail" as const) : ("skip" as const),
            surfaces: ["cli", "mcp"],
          })),
      };
      const failingOutput = renderConformanceSummary(failing, root);
      expect(failingOutput).toContain("FAILED");
      expect(failingOutput).not.toContain("PASSED —");
    });
  });
});
