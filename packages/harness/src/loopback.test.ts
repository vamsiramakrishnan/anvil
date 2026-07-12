import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "@anvil/compiler";
import { generateBundle, writeBundle } from "@anvil/generators";
import { afterAll, describe, expect, it } from "vitest";
import { type LoopbackCheck, LoopbackReport, runLoopback } from "./loopback.js";

/**
 * Full loopback runs against real generated bundles: the bundle's own mock
 * upstream and its own mcp/server.js (spawned as a stdio child, resolving the
 * built @anvil/* dist packages) — no network, no LLM. Requires `pnpm build`
 * to have produced dist/ for the runtime packages, which the turbo test task
 * guarantees.
 */

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../../examples/${rel}`, import.meta.url)), "utf8");

const dirs: string[] = [];

async function buildBundle(spec: string, manifest: string, serviceId: string): Promise<string> {
  const air = await compile({ spec: read(spec), manifest: read(manifest), serviceId });
  const dir = mkdtempSync(join(tmpdir(), `anvil-loopback-${serviceId}-`));
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

describe("loopback self-test (payments, OpenAPI)", () => {
  it("proves the generated bundle end-to-end: checks A-E pass", async () => {
    const dir = await buildBundle("payments/openapi.yaml", "payments/anvil.yaml", "payments");
    const report = await runLoopback(dir);

    // The report round-trips through its own schema.
    expect(LoopbackReport.parse(report)).toEqual(report);
    expect(report.schemaVersion).toBe(1);
    expect(report.bundle).toBe(dir);

    // A — surface.
    expect(byId(report, "surface")[0]?.status).toBe("pass");
    // B — fidelity for every approved operation, reads and mutations alike.
    const fidelity = byId(report, "fidelity");
    expect(fidelity).toHaveLength(4);
    expect(fidelity.every((c) => c.status === "pass")).toBe(true);
    // C — both confirmation-required mutations gate before any side effect.
    const gates = byId(report, "confirmation-gate");
    expect(gates.map((c) => c.operationId).sort()).toEqual([
      "payments.capture.create",
      "payments.refunds.create",
    ]);
    expect(gates.every((c) => c.status === "pass")).toBe(true);
    // D — a documented 404 surfaces as a structured envelope.
    expect(byId(report, "error-mapping")[0]?.status).toBe("pass");
    // E — a read survives an injected 503; payments has no non-idempotent
    // mutation, so the guard sub-check must be skipped, never silently passed.
    expect(byId(report, "retry-read")[0]?.status).toBe("pass");
    expect(byId(report, "retry-mutation-guard")[0]?.status).toBe("skipped");

    expect(report.summary.fail).toBe(0);
    expect(report.summary.pass).toBeGreaterThanOrEqual(9);
  }, 120_000);
});

describe("loopback self-test (banking, WSDL)", () => {
  it("surfaces the GET-with-body loss on WSDL-lowered reads and proves the mutations", async () => {
    const dir = await buildBundle("soap/bank.wsdl", "soap/anvil.yaml", "banking");
    const report = await runLoopback(dir);
    expect(LoopbackReport.parse(report)).toEqual(report);

    // A — the surface itself is aligned.
    expect(byId(report, "surface")[0]?.status).toBe("pass");

    // B — the POST-lowered mutations are lossless end-to-end (including the
    // whole-body projection of TransferFunds).
    expect(byId(report, "fidelity", "banking.transfer_funds.create")[0]?.status).toBe("pass");
    expect(byId(report, "fidelity", "banking.close_account.create")[0]?.status).toBe("pass");

    // B — the WSDL reads lower to GET yet still carry a required body; fetch
    // refuses to send that, so ZERO requests reach the wire. The self-test's
    // job is to surface that loss, not hide it.
    for (const opId of ["banking.get_account_balance.list", "banking.list_transactions.list"]) {
      const check = byId(report, "fidelity", opId)[0];
      expect(check?.status).toBe("fail");
      expect(check?.detail).toMatch(/0 wire request/);
    }

    // C — confirmation gates on both unsafe mutations.
    const gates = byId(report, "confirmation-gate");
    expect(gates.map((c) => c.operationId).sort()).toEqual([
      "banking.close_account.create",
      "banking.transfer_funds.create",
    ]);
    expect(gates.every((c) => c.status === "pass")).toBe(true);

    // D — the documented SOAP fault (500) surfaces as a structured envelope.
    expect(byId(report, "error-mapping")[0]?.status).toBe("pass");

    // E — no wire-executable read exists, so the read sub-check is skipped;
    // CloseAccount (idempotency: none) must execute exactly once on a 503.
    expect(byId(report, "retry-read")[0]?.status).toBe("skipped");
    const guard = byId(report, "retry-mutation-guard")[0];
    expect(guard?.status).toBe("pass");
    expect(guard?.operationId).toBe("banking.close_account.create");

    expect(report.summary.fail).toBe(2);
  }, 120_000);
});
