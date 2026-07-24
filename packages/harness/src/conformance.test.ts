import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "@anvil/compiler";
import { generateBundle, writeBundle } from "@anvil/generators";
import { afterAll, describe, expect, it } from "vitest";
import {
  type CliProcessResult,
  type ConformanceCheck,
  ConformanceReport,
  isTransientWorkspaceModuleFailure,
  parseCliErrorCode,
  retryTransientCliLaunch,
  runConformance,
  safeCliProcessContext,
} from "./conformance.js";

/**
 * Tri-surface conformance runs against real generated bundles: the bundle's own
 * mock upstream, its mcp/server.js, AND its cli/<svc>.mjs, all spawned as
 * children resolving the built @anvil/* dist packages — no network, no LLM.
 * Requires `pnpm build` (guaranteed by the turbo test task's ^build).
 */

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../../examples/${rel}`, import.meta.url)), "utf8");

// The harness must not depend on @anvil/cli (it would cycle), so the CLI-driving
// tests pass the sibling package directory explicitly, exactly as the
// `anvil conformance` command resolves its own root at runtime.
const CLI_PACKAGE_DIR = fileURLToPath(new URL("../../cli", import.meta.url));

const dirs: string[] = [];

async function buildBundle(spec: string, manifest: string, serviceId: string): Promise<string> {
  const air = await compile({ spec: read(spec), manifest: read(manifest), serviceId });
  const dir = mkdtempSync(join(tmpdir(), `anvil-conformance-${serviceId}-`));
  dirs.push(dir);
  writeBundle(dir, generateBundle(air));
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const byId = (report: { checks: ConformanceCheck[] }, id: string, operationId?: string) =>
  report.checks.filter(
    (c) => c.id === id && (operationId === undefined || c.operationId === operationId),
  );

const cliProcessResult = (overrides: Partial<CliProcessResult> = {}): CliProcessResult => ({
  exitCode: 1,
  signal: null,
  stdout: "",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  ...overrides,
});

describe("generated CLI child capture", () => {
  it("retries only the transient linked-workspace dist replacement race", async () => {
    const transient = cliProcessResult({
      stderr:
        "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/tmp/bundle/node_modules/@anvil/cli/dist/index.js' imported from /tmp/bundle/cli/payments.mjs",
    });
    const success = cliProcessResult({ exitCode: 0, stdout: '{"ok":true}' });
    let runs = 0;
    const waits: number[] = [];
    const result = await retryTransientCliLaunch(
      async () => {
        runs++;
        return runs < 3 ? transient : success;
      },
      async (ms) => {
        waits.push(ms);
      },
    );

    expect(isTransientWorkspaceModuleFailure(transient)).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.attempts).toBe(3);
    expect(waits).toEqual([50, 100]);

    runs = 0;
    const ordinary = cliProcessResult({ stderr: "validation failed" });
    const notRetried = await retryTransientCliLaunch(async () => {
      runs++;
      return ordinary;
    });
    expect(isTransientWorkspaceModuleFailure(ordinary)).toBe(false);
    expect(notRetried.attempts).toBe(1);
    expect(runs).toBe(1);

    expect(
      isTransientWorkspaceModuleFailure(
        cliProcessResult({
          stderr:
            "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/tmp/bundle/node_modules/@anvil/runtime/dist/index.js' imported from /tmp/bundle/cli/payments.mjs",
        }),
      ),
    ).toBe(false);
    expect(
      isTransientWorkspaceModuleFailure(
        cliProcessResult({
          stdout: '{"error":{"code":"runtime_failure"}}',
          stderr:
            "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/tmp/bundle/node_modules/@anvil/cli/dist/index.js' imported from /tmp/bundle/cli/payments.mjs",
        }),
      ),
    ).toBe(false);
  });

  it("finds a structured refusal in either stream even when diagnostics precede it", () => {
    expect(
      parseCliErrorCode(
        cliProcessResult({
          stderr: "ExperimentalWarning: diagnostic only",
          stdout: '{"error":{"code":"confirmation_required"}}',
        }),
      ),
    ).toBe("confirmation_required");
    expect(
      parseCliErrorCode(
        cliProcessResult({
          stderr: 'warning before JSON\n{"error":{"code":"confirmation_required"}}\n',
        }),
      ),
    ).toBe("confirmation_required");
  });

  it("bounds and redacts child output before persisting failure context", () => {
    const context = safeCliProcessContext({
      ...cliProcessResult({
        stdout: `token=top-secret {"access_token":"json-secret"} ${"x".repeat(2_000)}`,
        stderr:
          "Authorization: Bearer bearer-secret\nclient_secret=client-secret\nANVIL_PROD_CLIENT_SECRET=env-secret",
        stdoutTruncated: true,
      }),
      attempts: 5,
    });
    expect(context).toContain("exit=1");
    expect(context).toContain("attempts=5");
    expect(context).toContain("[REDACTED]");
    expect(context).toContain("[capture-truncated]");
    expect(context).not.toContain("top-secret");
    expect(context).not.toContain("bearer-secret");
    expect(context).not.toContain("client-secret");
    expect(context).not.toContain("json-secret");
    expect(context).not.toContain("env-secret");
    expect(context.length).toBeLessThan(800);
  });
});

describe("tri-surface conformance (payments, OpenAPI)", () => {
  it("proves the CLI, MCP, and skill surfaces agree end-to-end", async () => {
    const dir = await buildBundle("payments/openapi.yaml", "payments/anvil.yaml", "payments");
    const report = await runConformance(dir, { cliPackageDir: CLI_PACKAGE_DIR });

    // The report round-trips through its own schema.
    expect(ConformanceReport.parse(report)).toEqual(report);
    expect(report.surfaces).toEqual(["mcp", "cli", "skill"]);

    // The three surfaces name the same operations with the same public handles.
    expect(byId(report, "surface-agreement")[0]?.status).toBe("pass");

    // The skill documents the enforced posture for every approved operation.
    const claims = byId(report, "skill-claim");
    expect(claims).toHaveLength(4);
    expect(claims.every((c) => c.status === "pass")).toBe(true);

    // The same input reaches the wire identically on MCP and CLI, for every op.
    const wire = byId(report, "wire-agreement");
    expect(wire).toHaveLength(4);
    expect(wire.every((c) => c.status === "pass")).toBe(true);

    // Both gated financial mutations refuse without confirm on BOTH surfaces.
    const gates = byId(report, "gate-agreement");
    expect(gates.map((c) => c.operationId).sort()).toEqual([
      "payments.capture.create",
      "payments.refunds.create",
    ]);
    expect(gates.every((c) => c.status === "pass")).toBe(true);

    expect(report.summary.fail).toBe(0);
  }, 120_000);

  it("catches a skill that under-states the safety contract", async () => {
    const dir = await buildBundle("payments/openapi.yaml", "payments/anvil.yaml", "payments");
    // Make the generated skill LIE: strip the confirmation + idempotency gate
    // that the runtime actually enforces on the refund mutation.
    const opsPath = join(dir, "skill", "reference", "operations.md");
    const doc = readFileSync(opsPath, "utf8").replace(
      /(payments.refunds.create[\s\S]*?- Semantics: )mutation, financial, confirm-required, idempotency-key-required, retry-safe/,
      "$1mutation, financial, retry-safe",
    );
    writeFileSync(opsPath, doc, "utf8");

    const report = await runConformance(dir, { cliPackageDir: CLI_PACKAGE_DIR });
    const claim = byId(report, "skill-claim", "payments.refunds.create")[0];
    expect(claim?.status).toBe("fail");
    expect((claim?.divergences ?? []).map((d) => d.path)).toEqual(
      expect.arrayContaining(["confirm-required", "idempotency-key-required"]),
    );
    expect(report.summary.fail).toBeGreaterThan(0);
  }, 120_000);

  it("runs MCP↔skill only, skipping cross-surface checks, when the CLI is not linked", async () => {
    const dir = await buildBundle("payments/openapi.yaml", "payments/anvil.yaml", "payments");
    const report = await runConformance(dir); // no cliPackageDir

    expect(report.surfaces).toEqual(["mcp", "skill"]);
    // Static agreement still runs; cross-surface behavioural checks are skipped
    // (an MCP-only run cannot prove agreement), never silently passed.
    expect(byId(report, "surface-agreement")[0]?.status).toBe("pass");
    expect(byId(report, "wire-agreement").every((c) => c.status === "skipped")).toBe(true);
  }, 120_000);
});

describe("tri-surface conformance (delegated identity)", () => {
  it("reports virtual wiring separately from live IdP readiness", async () => {
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
      serviceId: "payments_obo_conformance",
    });
    const dir = mkdtempSync(join(tmpdir(), "anvil-conformance-obo-"));
    dirs.push(dir);
    writeBundle(dir, generateBundle(air));

    const report = await runConformance(dir);
    expect(byId(report, "auth-obo-token-exchange")[0]?.status).toBe("pass");
    expect(byId(report, "wire-agreement")[0]?.status).toBe("skipped");
    expect(report.identity).toMatchObject({
      delegatedOperations: 1,
      virtualWiring: "passed",
      proof: "virtual_wiring_only",
      liveIdpReadiness: "unverified",
    });
    expect(report.summary.fail, JSON.stringify(report.checks, null, 2)).toBe(0);
  }, 60_000);
});

describe("tri-surface conformance (banking, WSDL)", () => {
  it("proves WSDL-lowered surfaces agree across CLI, MCP, and skill", async () => {
    const dir = await buildBundle("soap/bank.wsdl", "soap/anvil.yaml", "banking");
    const report = await runConformance(dir, { cliPackageDir: CLI_PACKAGE_DIR });
    expect(ConformanceReport.parse(report)).toEqual(report);
    expect(byId(report, "surface-agreement")[0]?.status).toBe("pass");
    expect(byId(report, "wire-agreement").every((c) => c.status === "pass")).toBe(true);
    expect(report.summary.fail).toBe(0);
  }, 120_000);
});

describe("tri-surface conformance (enterprise vendors)", () => {
  it("Salesforce (REST) — every surface agrees, gates and all", async () => {
    const dir = await buildBundle("salesforce/openapi.yaml", "salesforce/anvil.yaml", "salesforce");
    const report = await runConformance(dir, { cliPackageDir: CLI_PACKAGE_DIR });
    expect(report.summary.fail).toBe(0);
    // The destructive delete and non-idempotent creates gate on both surfaces.
    const gates = byId(report, "gate-agreement").map((c) => c.operationId);
    expect(gates).toEqual(
      expect.arrayContaining([
        "salesforce.account.delete",
        "salesforce.account.create",
        "salesforce.contact.create",
      ]),
    );
    expect(byId(report, "gate-agreement").every((c) => c.status === "pass")).toBe(true);
    // Larger fixtures spawn a CLI child per operation; the whole suite runs once
    // per workspace package concurrently, so give the process-heavy vendor runs
    // generous wall-clock headroom (they finish in seconds uncontended).
  }, 240_000);

  it("SAP S/4HANA (OData) — OData $filter and composite keys reach the wire identically", async () => {
    const dir = await buildBundle("sap/metadata.edmx", "sap/anvil.yaml", "sap_bp");
    const report = await runConformance(dir, { cliPackageDir: CLI_PACKAGE_DIR });
    expect(report.summary.fail).toBe(0);
    // The OData `$filter`/`$top` query options and quoted composite keys survive
    // both surfaces byte-identically.
    expect(byId(report, "wire-agreement").every((c) => c.status === "pass")).toBe(true);
    expect(byId(report, "surface-agreement")[0]?.status).toBe("pass");
  }, 300_000);
});
