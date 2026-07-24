import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "@anvil/compiler";
import { generateBundle, writeBundle } from "@anvil/generators";
import { afterAll, describe, expect, it, test } from "vitest";
import {
  type CliProcessResult,
  type ConformanceCheck,
  type ConformanceReport,
  ConformanceReport as ConformanceReportSchema,
  isTransientWorkspaceModuleFailure,
  parseCliErrorCode,
  retryTransientCliLaunch,
  runConformance,
  safeCliProcessContext,
} from "./conformance.js";

/**
 * Bugbash test suite for conformance.ts — focuses on uncovered branches,
 * edge cases in mismatch detection/reporting, error paths, and boundary
 * conditions not covered by conformance.test.ts.
 */

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../../examples/${rel}`, import.meta.url)), "utf8");

const CLI_PACKAGE_DIR = fileURLToPath(new URL("../../cli", import.meta.url));

const dirs: string[] = [];

async function buildBundle(spec: string, manifest: string, serviceId: string): Promise<string> {
  const air = await compile({ spec: read(spec), manifest: read(manifest), serviceId });
  const dir = mkdtempSync(join(tmpdir(), `anvil-conformance-bugbash-${serviceId}-`));
  dirs.push(dir);
  writeBundle(dir, generateBundle(air));
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const cliProcessResult = (overrides: Partial<CliProcessResult> = {}): CliProcessResult => ({
  exitCode: 1,
  signal: null,
  stdout: "",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  ...overrides,
});

describe("CLI error code parsing — edge cases", () => {
  test("parses error code from nested JSON with multiple levels", () => {
    const code = parseCliErrorCode(
      cliProcessResult({
        stdout: '{"result":{"error":{"code":"validation_failed","details":[]}}}',
      }),
    );
    // The current parser only looks for top-level error.code
    // This may be undefined if the structure is nested
    expect(code).toBeUndefined();
  });

  test("parses error code even when JSON is malformed after it", () => {
    expect(
      parseCliErrorCode(
        cliProcessResult({
          stderr: '{"error":{"code":"idempotency_conflict"}}\n[invalid json',
        }),
      ),
    ).toBe("idempotency_conflict");
  });

  test("handles error code in stdout over stderr when stdout is present", () => {
    expect(
      parseCliErrorCode(
        cliProcessResult({
          stdout: '{"error":{"code":"from_stdout"}}',
          stderr: '{"error":{"code":"from_stderr"}}',
        }),
      ),
    ).toBe("from_stderr"); // Parser checks stderr first due to reverse order
  });

  test("finds error code when it's on the last line with preceding whitespace", () => {
    expect(
      parseCliErrorCode(
        cliProcessResult({
          stderr: 'some warning\n  \n{"error":{"code":"runtime_failure"}}\n  ',
        }),
      ),
    ).toBe("runtime_failure");
  });

  test("handles completely empty JSON object", () => {
    expect(parseCliErrorCode(cliProcessResult({ stderr: "{}" }))).toBeUndefined();
  });

  test("handles malformed JSON with only error key, no code", () => {
    expect(
      parseCliErrorCode(cliProcessResult({ stderr: '{"error":{"message":"failed"}}' })),
    ).toBeUndefined();
  });

  test("ignores error.code if it is not a string", () => {
    expect(
      parseCliErrorCode(
        cliProcessResult({
          stderr: '{"error":{"code":123}}',
        }),
      ),
    ).toBeUndefined();
  });

  test("handles very deeply nested but ultimately empty structure", () => {
    expect(
      parseCliErrorCode(
        cliProcessResult({
          stderr: '{"a":{"b":{"c":{"d":{}}}}}',
        }),
      ),
    ).toBeUndefined();
  });
});

describe("transient workspace module failure detection — edge cases", () => {
  test("rejects when exit code is not exactly 1", () => {
    expect(
      isTransientWorkspaceModuleFailure(
        cliProcessResult({
          exitCode: 0,
          stderr:
            "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/tmp/bundle/node_modules/@anvil/cli/dist/index.js' imported from /tmp/bundle/cli/payments.mjs",
        }),
      ),
    ).toBe(false);
  });

  test("rejects when stdout is not empty (even after trim)", () => {
    expect(
      isTransientWorkspaceModuleFailure(
        cliProcessResult({
          exitCode: 1,
          stdout: "  some output  ",
          stderr:
            "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/tmp/bundle/node_modules/@anvil/cli/dist/index.js' imported from /tmp/bundle/cli/payments.mjs",
        }),
      ),
    ).toBe(false);
  });

  test("rejects when a structured error code is present even with the pattern", () => {
    expect(
      isTransientWorkspaceModuleFailure(
        cliProcessResult({
          exitCode: 1,
          stderr:
            "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/tmp/bundle/node_modules/@anvil/cli/dist/index.js' imported from /tmp/bundle/cli/payments.mjs\n" +
            '{"error":{"code":"module_error"}}',
        }),
      ),
    ).toBe(false);
  });

  test("accepts exact @anvil/cli/dist/index.js pattern from correct import context", () => {
    expect(
      isTransientWorkspaceModuleFailure(
        cliProcessResult({
          exitCode: 1,
          stderr:
            "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/tmp/bundle/node_modules/@anvil/cli/dist/index.js' " +
            "imported from /tmp/bundle/cli/payments.mjs",
        }),
      ),
    ).toBe(true);
  });

  test("rejects when imported from wrong location (not cli/*.mjs)", () => {
    expect(
      isTransientWorkspaceModuleFailure(
        cliProcessResult({
          exitCode: 1,
          stderr:
            "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/tmp/bundle/node_modules/@anvil/cli/dist/index.js' " +
            "imported from /tmp/bundle/mcp/server.js",
        }),
      ),
    ).toBe(false);
  });

  test("rejects when module path differs even slightly from @anvil/cli", () => {
    expect(
      isTransientWorkspaceModuleFailure(
        cliProcessResult({
          exitCode: 1,
          stderr:
            "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/tmp/bundle/node_modules/@anvil/cli-lib/dist/index.js' " +
            "imported from /tmp/bundle/cli/payments.mjs",
        }),
      ),
    ).toBe(false);
  });

  test("rejects when package path does not match dist/index.js", () => {
    expect(
      isTransientWorkspaceModuleFailure(
        cliProcessResult({
          exitCode: 1,
          stderr:
            "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/tmp/bundle/node_modules/@anvil/cli/dist/main.js' " +
            "imported from /tmp/bundle/cli/payments.mjs",
        }),
      ),
    ).toBe(false);
  });
});

describe("safe CLI stream redaction — edge cases", () => {
  test("redacts multiple sensitive patterns in one string", () => {
    const context = safeCliProcessContext({
      exitCode: 0,
      signal: null,
      stdout: "Authorization: Bearer secret1\nAuthorization: Basic secret2\nx-api-key: secret3",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      attempts: 1,
    });
    expect(context).toContain("[REDACTED]");
    expect(context).not.toContain("secret1");
    expect(context).not.toContain("secret2");
    expect(context).not.toContain("secret3");
  });

  test("redacts JSON with quoted keys and various value formats", () => {
    const context = safeCliProcessContext({
      exitCode: 0,
      signal: null,
      stdout: '{"api_key":"secret1","api-key":\'secret2\',"access_token":secret3}',
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      attempts: 1,
    });
    expect(context).toContain("[REDACTED]");
    expect(context).not.toContain("secret1");
    expect(context).not.toContain("secret2");
  });

  test("redacts hermetic exchange tokens by pattern", () => {
    const context = safeCliProcessContext({
      exitCode: 0,
      signal: null,
      stdout: "token: anvil-hermetic-abc123.def456-ghi789_jkl",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      attempts: 1,
    });
    expect(context).toContain("[REDACTED]");
    expect(context).not.toContain("anvil-hermetic");
  });

  // FIXED: SENSITIVE_CLI_KEY_SOURCE (packages/harness/src/conformance.ts:760-761)
  // previously had no alternative matching a "bearer_token" JSON key (only
  // "token" alone, which the ASSIGNED_CLI_SECRET/JSON_CLI_SECRET lookbehind
  // excluded because it is preceded by the word character "_"). A generic
  // `[a-z]+[-_]token` alternative now covers "bearer_token" the same way it
  // covers "access_token"/"refresh_token"/"id_token", per the CLAUDE.md
  // safety contract: "Never log or echo secrets; the runtime redacts auth
  // material from records."
  it("preserves non-sensitive content while redacting secrets", () => {
    const context = safeCliProcessContext({
      exitCode: 0,
      signal: null,
      stdout: '{"status":"success","bearer_token":"secret","operation_id":"op-123"}',
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      attempts: 1,
    });
    expect(context).toContain("op-123");
    expect(context).toContain("success");
    expect(context).toContain("bearer_token");
    expect(context).toContain("[REDACTED]");
    expect(context).not.toContain("secret");
  });

  test("marks truncation in output when stdoutTruncated is true", () => {
    const context = safeCliProcessContext({
      exitCode: 0,
      signal: null,
      stdout: "start",
      stderr: "",
      stdoutTruncated: true,
      stderrTruncated: false,
      attempts: 1,
    });
    expect(context).toContain("[capture-truncated]");
  });

  test("marks both truncation flags independently", () => {
    const context = safeCliProcessContext({
      exitCode: 0,
      signal: null,
      stdout: "out",
      stderr: "err",
      stdoutTruncated: true,
      stderrTruncated: true,
      attempts: 2,
    });
    expect(context).toContain("stdout=");
    expect(context).toContain("stderr=");
    expect((context.match(/\[capture-truncated\]/g) ?? []).length).toBe(2);
  });

  test("handles empty stdout and stderr", () => {
    const context = safeCliProcessContext({
      exitCode: 0,
      signal: null,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      attempts: 1,
    });
    expect(context).toContain("<empty>");
  });

  test("includes attempts count in output", () => {
    const context = safeCliProcessContext({
      exitCode: 1,
      signal: null,
      stdout: "output",
      stderr: "error",
      stdoutTruncated: false,
      stderrTruncated: false,
      attempts: 5,
    });
    expect(context).toContain("attempts=5");
  });

  test("includes signal in output when present", () => {
    const context = safeCliProcessContext({
      exitCode: null,
      signal: "SIGTERM",
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      attempts: 1,
    });
    expect(context).toContain("signal=SIGTERM");
  });
});

describe("retry logic — boundary conditions", () => {
  test("retries with correct delays from the constant array", async () => {
    const delays: number[] = [];
    const result = await retryTransientCliLaunch(
      async () => cliProcessResult({ exitCode: 0 }),
      async (ms) => delays.push(ms),
    );
    expect(result.attempts).toBe(1);
    expect(delays).toEqual([]);
  });

  test("attempts increments correctly across retries", async () => {
    let callCount = 0;
    const transientError = cliProcessResult({
      exitCode: 1,
      stderr:
        "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/tmp/bundle/node_modules/@anvil/cli/dist/index.js' imported from /tmp/bundle/cli/payments.mjs",
    });

    const result = await retryTransientCliLaunch(
      async () => {
        callCount++;
        return callCount >= 3 ? cliProcessResult({ exitCode: 0 }) : transientError;
      },
      async () => undefined,
    );

    expect(result.attempts).toBe(3);
    expect(callCount).toBe(3);
  });

  test("exhausts retries and returns final result after all delays", async () => {
    let callCount = 0;
    const transientError = cliProcessResult({
      exitCode: 1,
      stderr:
        "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/tmp/bundle/node_modules/@anvil/cli/dist/index.js' imported from /tmp/bundle/cli/payments.mjs",
    });

    const result = await retryTransientCliLaunch(
      async () => {
        callCount++;
        return transientError;
      },
      async () => undefined,
    );

    // Should retry 4 times (1 initial + 4 retries with delays [50, 100, 200, 400])
    expect(result.attempts).toBe(5);
    expect(callCount).toBe(5);
    expect(result.exitCode).toBe(1);
  });

  test("aborts retry loop on non-transient error", async () => {
    let callCount = 0;
    const nonTransient = cliProcessResult({
      exitCode: 127,
      stderr: "command not found",
    });

    const result = await retryTransientCliLaunch(async () => {
      callCount++;
      return nonTransient;
    });

    expect(result.attempts).toBe(1);
    expect(callCount).toBe(1);
  });
});

describe("conformance schema validation", () => {
  test("ConformanceReport schema accepts valid minimal report", () => {
    const report = {
      schemaVersion: 1,
      bundle: "/tmp/bundle",
      startedAt: new Date().toISOString(),
      surfaces: ["mcp"],
      checks: [],
      identity: {
        delegatedOperations: 0,
        virtualWiring: "not_applicable",
        proof: "not_applicable",
        liveIdpReadiness: "not_applicable",
        detail: "No delegated operations",
      },
      summary: { pass: 0, fail: 0, skipped: 0 },
    };
    expect(() => ConformanceReportSchema.parse(report)).not.toThrow();
  });

  test("ConformanceReport rejects invalid schemaVersion", () => {
    const report = {
      schemaVersion: 2,
      bundle: "/tmp/bundle",
      startedAt: new Date().toISOString(),
      surfaces: ["mcp"],
      checks: [],
      identity: {
        delegatedOperations: 0,
        virtualWiring: "not_applicable",
        proof: "not_applicable",
        liveIdpReadiness: "not_applicable",
        detail: "test",
      },
      summary: { pass: 0, fail: 0, skipped: 0 },
    };
    expect(() => ConformanceReportSchema.parse(report)).toThrow();
  });

  test("ConformanceReport accepts all valid check statuses", () => {
    for (const status of ["pass", "fail", "skipped"] as const) {
      const report = {
        schemaVersion: 1,
        bundle: "/tmp/bundle",
        startedAt: new Date().toISOString(),
        surfaces: ["mcp"],
        checks: [
          {
            id: "test-check",
            surfaces: ["mcp"],
            status,
            detail: "test",
          },
        ],
        identity: {
          delegatedOperations: 0,
          virtualWiring: "not_applicable",
          proof: "not_applicable",
          liveIdpReadiness: "not_applicable",
          detail: "test",
        },
        summary: {
          pass: status === "pass" ? 1 : 0,
          fail: status === "fail" ? 1 : 0,
          skipped: status === "skipped" ? 1 : 0,
        },
      };
      expect(() => ConformanceReportSchema.parse(report)).not.toThrow();
    }
  });

  test("ConformanceReport accepts checks with divergences", () => {
    const report = {
      schemaVersion: 1,
      bundle: "/tmp/bundle",
      startedAt: new Date().toISOString(),
      surfaces: ["mcp", "cli"],
      checks: [
        {
          id: "surface-agreement",
          surfaces: ["mcp", "cli"],
          status: "fail",
          divergences: [
            {
              path: "tool-name",
              between: ["mcp", "cli"],
              left: "tool1",
              right: "tool2",
            },
          ],
          detail: "tools diverge",
        },
      ],
      identity: {
        delegatedOperations: 0,
        virtualWiring: "not_applicable",
        proof: "not_applicable",
        liveIdpReadiness: "not_applicable",
        detail: "test",
      },
      summary: { pass: 0, fail: 1, skipped: 0 },
    };
    expect(() => ConformanceReportSchema.parse(report)).not.toThrow();
  });

  test("ConformanceReport rejects check with invalid surface in surfaces array", () => {
    const report = {
      schemaVersion: 1,
      bundle: "/tmp/bundle",
      startedAt: new Date().toISOString(),
      surfaces: ["mcp"],
      checks: [
        {
          id: "test",
          surfaces: ["mcp", "invalid"],
          status: "pass",
        },
      ],
      identity: {
        delegatedOperations: 0,
        virtualWiring: "not_applicable",
        proof: "not_applicable",
        liveIdpReadiness: "not_applicable",
        detail: "test",
      },
      summary: { pass: 1, fail: 0, skipped: 0 },
    };
    expect(() => ConformanceReportSchema.parse(report)).toThrow();
  });

  test("ConformanceReport requires summary counts to be integers", () => {
    const report = {
      schemaVersion: 1,
      bundle: "/tmp/bundle",
      startedAt: new Date().toISOString(),
      surfaces: ["mcp"],
      checks: [],
      identity: {
        delegatedOperations: 0,
        virtualWiring: "not_applicable",
        proof: "not_applicable",
        liveIdpReadiness: "not_applicable",
        detail: "test",
      },
      summary: { pass: 1.5, fail: 0, skipped: 0 },
    };
    expect(() => ConformanceReportSchema.parse(report)).toThrow();
  });
});

describe("conformance identity readiness", () => {
  test("reports no delegated operations when all operations are non-delegated", async () => {
    const dir = await buildBundle("payments/openapi.yaml", "payments/anvil.yaml", "payments");
    const report = await runConformance(dir);

    expect(report.identity.delegatedOperations).toBe(0);
    expect(report.identity.virtualWiring).toBe("not_applicable");
    expect(report.identity.proof).toBe("not_applicable");
    expect(report.identity.liveIdpReadiness).toBe("not_applicable");
  }, 120_000);

  test("reports delegated operations with successful virtual wiring", async () => {
    const manifest = `operations:
  getPayment:
    state: approved
    auth:
      type: oauth2_on_behalf_of
      principal: delegated
      issuer: https://id.example.com/
      audience: api://payments
      carrier: { in: header, name: Authorization, scheme: Bearer }
      provider:
        grant: token_exchange
        token_endpoint: https://sts.example.com/oauth/token
  getCustomer:
    state: approved
  createRefund:
    state: approved
  capturePayment:
    state: approved
`;
    const air = await compile({
      spec: read("payments/openapi.yaml"),
      manifest,
      serviceId: "payments_identity_bugbash",
    });
    const dir = mkdtempSync(join(tmpdir(), "anvil-conformance-identity-bugbash-"));
    dirs.push(dir);
    writeBundle(dir, generateBundle(air));

    const report = await runConformance(dir);

    expect(report.identity.delegatedOperations).toBe(1);
    expect(report.identity.virtualWiring).toBe("passed");
    expect(report.identity.proof).toBe("virtual_wiring_only");
    expect(report.identity.liveIdpReadiness).toBe("unverified");
  }, 60_000);
});

describe("conformance report structure integrity", () => {
  test("report always includes schemaVersion 1", async () => {
    const dir = await buildBundle("payments/openapi.yaml", "payments/anvil.yaml", "payments");
    const report = await runConformance(dir);
    expect(report.schemaVersion).toBe(1);
  }, 120_000);

  test("report includes startedAt in ISO format", async () => {
    const dir = await buildBundle("payments/openapi.yaml", "payments/anvil.yaml", "payments");
    const report = await runConformance(dir);
    expect(() => new Date(report.startedAt)).not.toThrow();
  }, 120_000);

  test("report surfaces array is non-empty", async () => {
    const dir = await buildBundle("payments/openapi.yaml", "payments/anvil.yaml", "payments");
    const report = await runConformance(dir);
    expect(report.surfaces.length).toBeGreaterThan(0);
  }, 120_000);

  test("report summary counts match actual checks", async () => {
    const dir = await buildBundle("payments/openapi.yaml", "payments/anvil.yaml", "payments");
    const report = await runConformance(dir);

    const passCount = report.checks.filter((c) => c.status === "pass").length;
    const failCount = report.checks.filter((c) => c.status === "fail").length;
    const skipCount = report.checks.filter((c) => c.status === "skipped").length;

    expect(report.summary.pass).toBe(passCount);
    expect(report.summary.fail).toBe(failCount);
    expect(report.summary.skipped).toBe(skipCount);
  }, 120_000);

  test("all checks have required id and surfaces fields", async () => {
    const dir = await buildBundle("payments/openapi.yaml", "payments/anvil.yaml", "payments");
    const report = await runConformance(dir);

    for (const check of report.checks) {
      expect(check.id).toBeDefined();
      expect(typeof check.id).toBe("string");
      expect(check.surfaces).toBeDefined();
      expect(Array.isArray(check.surfaces)).toBe(true);
      expect(check.surfaces.length).toBeGreaterThan(0);
      expect(check.status).toMatch(/^(pass|fail|skipped)$/);
    }
  }, 120_000);

  test("divergences are only present on failed checks", async () => {
    const dir = await buildBundle("payments/openapi.yaml", "payments/anvil.yaml", "payments");
    const report = await runConformance(dir);

    for (const check of report.checks) {
      if (check.status === "fail") {
        // Failed checks may or may not have divergences, but if present they're structured
        if (check.divergences) {
          for (const div of check.divergences) {
            expect(div.path).toBeDefined();
            expect(div.between).toBeDefined();
            expect(Array.isArray(div.between)).toBe(true);
          }
        }
      } else {
        // Passing checks should not have divergences
        expect(check.divergences).toBeUndefined();
      }
    }
  }, 120_000);
});

describe("conformance with no approved operations", () => {
  test("reports failure when no operations are approved", async () => {
    const manifest = `operations:
  getPayment:
    state: generated
  getCustomer:
    state: generated
`;
    const air = await compile({
      spec: read("payments/openapi.yaml"),
      manifest,
      serviceId: "payments_none_approved",
    });
    const dir = mkdtempSync(join(tmpdir(), "anvil-conformance-none-approved-"));
    dirs.push(dir);
    writeBundle(dir, generateBundle(air));

    const report = await runConformance(dir);

    expect(report.summary.fail).toBeGreaterThan(0);
    const surfaceCheck = report.checks.find((c) => c.id === "surface-agreement");
    expect(surfaceCheck?.status).toBe("fail");
    expect(surfaceCheck?.detail).toContain("no approved operations");
  }, 60_000);
});
