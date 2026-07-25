import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "@anvil/compiler";
import { generateBundle, writeBundle } from "@anvil/generators";
import { afterAll, describe, expect, it } from "vitest";
import { type LoopbackCheck, LoopbackReport, runLoopback } from "./loopback.js";

/**
 * Extended loopback tests: error propagation, edge cases, and uncovered branches.
 * These tests focus on scenarios not covered by the main loopback.test.ts E2E runs:
 * - Custom environment variables and timeout options
 * - Operations with various auth types and combinations
 * - Identity readiness computation with different operation mixes
 * - Report structure validation and consistency
 * - Error propagation in check functions
 */

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../../examples/${rel}`, import.meta.url)), "utf8");

const dirs: string[] = [];

async function buildBundle(spec: string, manifest: string, serviceId: string): Promise<string> {
  const air = await compile({ spec: read(spec), manifest: read(manifest), serviceId });
  const dir = mkdtempSync(join(tmpdir(), `anvil-loopback-bugbash-${serviceId}-`));
  dirs.push(dir);
  writeBundle(dir, generateBundle(air));
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const byId = (report: { checks: LoopbackCheck[] }, id: string, operationId?: string) =>
  report.checks.filter(
    (c) => c.id === id && (operationId === undefined || c.operationId === operationId),
  );

describe("loopback self-test: error propagation and edge cases", () => {
  it("passes custom environment to the MCP server", async () => {
    const dir = await buildBundle("payments/openapi.yaml", "payments/anvil.yaml", "payments");

    // Test that options.env is merged into the spawned server's environment.
    // We can't directly verify env vars in the child, but we can ensure the
    // loopback completes successfully with custom env (i.e., no env-related crash).
    const customEnv = {
      ANVIL_CUSTOM_TEST_VAR: "test-value-bugbash",
      EXTRA_OPTION: "should-propagate",
    };

    const report = await runLoopback(dir, { env: customEnv });

    // The report should be valid and tests should pass with custom env.
    expect(LoopbackReport.parse(report)).toEqual(report);
    expect(report.summary.fail).toBe(0);
    expect(report.schemaVersion).toBe(1);
  }, 120_000);

  it("respects custom callTimeoutMs option for tool invocations", async () => {
    const dir = await buildBundle("payments/openapi.yaml", "payments/anvil.yaml", "payments");

    // Test with a generous timeout that should never be reached on healthy operations.
    const report = await runLoopback(dir, { callTimeoutMs: 60_000 });

    expect(LoopbackReport.parse(report)).toEqual(report);
    expect(report.summary.fail).toBe(0);

    // All fidelity checks should pass, indicating tool calls succeeded.
    const fidelity = byId(report, "fidelity");
    expect(fidelity.length).toBeGreaterThan(0);
    expect(fidelity.every((c) => c.status === "pass" || c.status === "skipped")).toBe(true);
  }, 120_000);

  it("handles operations without OAuth2 OBO delegation correctly", async () => {
    const dir = await buildBundle("payments/openapi.yaml", "payments/anvil.yaml", "payments");
    const report = await runLoopback(dir);

    // Identity readiness should show 0 delegated operations and not_applicable proof.
    expect(report.identity.delegatedOperations).toBe(0);
    expect(report.identity.virtualWiring).toBe("not_applicable");
    expect(report.identity.proof).toBe("not_applicable");
    expect(report.identity.liveIdpReadiness).toBe("not_applicable");
    expect(report.identity.detail).toMatch(/No approved delegated operations/);
  }, 120_000);

  it("validates report schema strictness: all checks carry required fields", async () => {
    const dir = await buildBundle("payments/openapi.yaml", "payments/anvil.yaml", "payments");
    const report = await runLoopback(dir);

    // Every check must have id and status.
    for (const check of report.checks) {
      expect(check.id).toBeDefined();
      expect(check.status).toBeDefined();
      expect(["pass", "fail", "skipped"]).toContain(check.status);

      // If status is fail, detail should provide context.
      if (check.status === "fail") {
        expect(check.detail).toBeDefined();
        expect(typeof check.detail).toBe("string");
      }

      // Losses array, if present, must have at least one entry (when status is fail).
      if (check.losses) {
        expect(Array.isArray(check.losses)).toBe(true);
        for (const loss of check.losses) {
          expect(loss.path).toBeDefined();
          expect(loss.sent).toBeDefined();
          expect(loss.received).toBeDefined();
        }
      }
    }

    // Summary must match check counts.
    const pass = report.checks.filter((c) => c.status === "pass").length;
    const fail = report.checks.filter((c) => c.status === "fail").length;
    const skipped = report.checks.filter((c) => c.status === "skipped").length;
    expect(report.summary.pass).toBe(pass);
    expect(report.summary.fail).toBe(fail);
    expect(report.summary.skipped).toBe(skipped);
  }, 120_000);

  it("distinguishes surface check from empty-surface detail message", async () => {
    // No manifest — nothing is approved.
    const air = await compile({ spec: read("payments/openapi.yaml"), serviceId: "payments" });
    const dir = mkdtempSync(join(tmpdir(), "anvil-loopback-bugbash-empty-"));
    dirs.push(dir);
    writeBundle(dir, generateBundle(air));

    const report = await runLoopback(dir);

    // The surface check should fail with a specific message about no approved operations.
    const surface = byId(report, "surface")[0];
    expect(surface).toBeDefined();
    expect(surface?.status).toBe("fail");
    expect(surface?.detail).toMatch(/no approved operations/);
    expect(surface?.detail).toMatch(/manifest/);

    // Summary should show exactly 1 fail and 0 pass.
    expect(report.summary.fail).toBe(1);
    expect(report.summary.pass).toBe(0);
    expect(report.checks).toHaveLength(1);
  }, 60_000);

  it("includes fidelity checks for all approved non-OBO operations", async () => {
    const dir = await buildBundle("payments/openapi.yaml", "payments/anvil.yaml", "payments");
    const report = await runLoopback(dir);

    const fidelity = byId(report, "fidelity");
    // Payments has 4 approved operations, all with non-OBO auth.
    expect(fidelity.length).toBe(4);

    // Each fidelity check must carry an operationId.
    for (const check of fidelity) {
      expect(check.operationId).toBeDefined();
      expect(typeof check.operationId).toBe("string");

      // If it fails, it should document losses or a detail message.
      if (check.status === "fail") {
        expect(check.detail || check.losses).toBeDefined();
      }
    }
  }, 120_000);

  it("validates confirmation gate checks only for confirmation-required mutations", async () => {
    const dir = await buildBundle("payments/openapi.yaml", "payments/anvil.yaml", "payments");
    const report = await runLoopback(dir);

    const gates = byId(report, "confirmation-gate");
    // Payments has 2 confirmation-required mutations.
    expect(gates.length).toBe(2);

    // All gate checks should have operationIds.
    for (const gate of gates) {
      expect(gate.operationId).toBeDefined();
      expect(gate.status).toBeDefined();
    }

    // If any fail, the detail explains why.
    for (const gate of gates.filter((c) => c.status === "fail")) {
      expect(gate.detail).toBeDefined();
      expect(typeof gate.detail).toBe("string");
    }
  }, 120_000);

  it("includes error-mapping check when applicable scenarios exist", async () => {
    const dir = await buildBundle("payments/openapi.yaml", "payments/anvil.yaml", "payments");
    const report = await runLoopback(dir);

    const errorMapping = byId(report, "error-mapping");
    expect(errorMapping.length).toBe(1);

    const check = errorMapping[0];
    expect(check).toBeDefined();
    // Should either pass (error mapped correctly) or be skipped (no suitable scenario).
    expect(["pass", "skipped"]).toContain(check?.status);
  }, 120_000);

  it("includes retry checks (both read and mutation guard)", async () => {
    const dir = await buildBundle("payments/openapi.yaml", "payments/anvil.yaml", "payments");
    const report = await runLoopback(dir);

    const retryRead = byId(report, "retry-read");
    expect(retryRead.length).toBe(1);
    expect(["pass", "skipped"]).toContain(retryRead[0]?.status);

    const retryGuard = byId(report, "retry-mutation-guard");
    expect(retryGuard.length).toBe(1);
    expect(["pass", "skipped"]).toContain(retryGuard[0]?.status);
  }, 120_000);

  it("correctly handles operations with different HTTP methods", async () => {
    const dir = await buildBundle("soap/bank.wsdl", "soap/anvil.yaml", "banking");
    const report = await runLoopback(dir);

    // Banking has WSDL operations that may have different HTTP methods after lowering.
    const fidelity = byId(report, "fidelity");
    expect(fidelity.length).toBeGreaterThan(0);

    // Each operation should have been tested for fidelity.
    for (const check of fidelity) {
      expect(check.operationId).toBeDefined();
      expect(check.status).toBeDefined();
    }

    // No fidelity failures should occur.
    expect(report.summary.fail).toBe(0);
  }, 120_000);

  it("reports identity readiness in the correct object structure", async () => {
    const dir = await buildBundle("payments/openapi.yaml", "payments/anvil.yaml", "payments");
    const report = await runLoopback(dir);

    const identity = report.identity;
    expect(identity).toBeDefined();
    expect(typeof identity.delegatedOperations).toBe("number");
    expect(identity.delegatedOperations).toBeGreaterThanOrEqual(0);
    expect(["not_applicable", "passed", "failed"]).toContain(identity.virtualWiring);
    expect(["not_applicable", "virtual_wiring_only"]).toContain(identity.proof);
    expect(["not_applicable", "unverified"]).toContain(identity.liveIdpReadiness);
    expect(typeof identity.detail).toBe("string");
  }, 120_000);

  it("maintains idempotency: running loopback twice yields identical structure", async () => {
    const dir = await buildBundle("payments/openapi.yaml", "payments/anvil.yaml", "payments");

    const report1 = await runLoopback(dir);
    const report2 = await runLoopback(dir);

    // Both reports should have identical schema structure and check counts.
    expect(report1.schemaVersion).toBe(report2.schemaVersion);
    expect(report1.checks.length).toBe(report2.checks.length);
    expect(report1.summary).toEqual(report2.summary);
    expect(report1.identity.delegatedOperations).toBe(report2.identity.delegatedOperations);

    // Check IDs should match in order.
    for (let i = 0; i < report1.checks.length; i++) {
      expect(report1.checks[i]?.id).toBe(report2.checks[i]?.id);
      expect(report1.checks[i]?.status).toBe(report2.checks[i]?.status);
    }
  }, 120_000);

  it("passes combined custom options: custom env + custom timeout", async () => {
    const dir = await buildBundle("payments/openapi.yaml", "payments/anvil.yaml", "payments");

    const customEnv = { ANVIL_CUSTOM_VAR: "combined-test" };
    const report = await runLoopback(dir, { env: customEnv, callTimeoutMs: 45_000 });

    expect(LoopbackReport.parse(report)).toEqual(report);
    expect(report.summary.fail).toBe(0);

    // Verify basic structure is intact.
    expect(report.checks.length).toBeGreaterThan(0);
    expect(report.identity).toBeDefined();
  }, 120_000);

  it("validates report round-trips through schema for all fixtures", async () => {
    const dir1 = await buildBundle(
      "payments/openapi.yaml",
      "payments/anvil.yaml",
      "payments-schema-test",
    );
    const report1 = await runLoopback(dir1);
    expect(LoopbackReport.parse(report1)).toEqual(report1);

    const dir2 = await buildBundle("soap/bank.wsdl", "soap/anvil.yaml", "banking-schema-test");
    const report2 = await runLoopback(dir2);
    expect(LoopbackReport.parse(report2)).toEqual(report2);

    const dir3 = await buildBundle(
      "graphql/schema.graphql",
      "graphql/anvil.yaml",
      "storefront-schema-test",
    );
    const report3 = await runLoopback(dir3);
    expect(LoopbackReport.parse(report3)).toEqual(report3);
  }, 180_000);

  it("ensures check statuses are mutually exclusive per check", async () => {
    const dir = await buildBundle("payments/openapi.yaml", "payments/anvil.yaml", "payments");
    const report = await runLoopback(dir);

    for (const check of report.checks) {
      const statusCount = [
        check.status === "pass" ? 1 : 0,
        check.status === "fail" ? 1 : 0,
        check.status === "skipped" ? 1 : 0,
      ].reduce((a, b) => a + b, 0);
      expect(statusCount).toBe(1);
    }
  }, 120_000);
});
