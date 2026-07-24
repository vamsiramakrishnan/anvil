import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Operation } from "@anvil/air";
import { compile } from "@anvil/compiler";
import {
  deploymentArtifactHash,
  generateBundle,
  readBundleDir,
  writeBundle,
} from "@anvil/generators";
import { afterAll, describe, expect, it } from "vitest";
import { ensureBundleNodeModules } from "./bundle-driver.js";
import { LiveReport, liveIdentityGate, liveIdentityReadiness, runLiveConformance } from "./live.js";

/**
 * The live lane runs against a REAL HTTP MCP endpoint. In production that is a
 * deployed Cloud Run URL; here we stand up the bundle's OWN generated Cloud Run
 * server (runtime/server.js) pointed at its own mock upstream — the exact
 * artifact that gets deployed — so the test exercises the real serving path, not
 * a stand-in. No external network.
 */

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../../examples/${rel}`, import.meta.url)), "utf8");

const dirs: string[] = [];
const procs: ChildProcess[] = [];

afterAll(() => {
  for (const p of procs) p.kill("SIGKILL");
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

async function buildBundle(variant?: string): Promise<string> {
  const air = await compile({
    spec: read("payments/openapi.yaml"),
    manifest: read("payments/anvil.yaml"),
    serviceId: "payments",
  });
  if (variant) {
    const operation = air.operations[0];
    if (operation) operation.description = `${operation.description} ${variant}`;
  }
  const dir = mkdtempSync(join(tmpdir(), "anvil-live-"));
  dirs.push(dir);
  writeBundle(dir, generateBundle(air));
  ensureBundleNodeModules(dir);
  return dir;
}

const freePort = (): Promise<number> =>
  new Promise((res) => {
    const s = createServer();
    s.listen(0, () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => res(port));
    });
  });

function startMock(dir: string): Promise<string> {
  const child = spawn(process.execPath, [join(dir, "mock", "server.mjs")], {
    env: { ...process.env, PORT: "0", ANVIL_MOCK_SCENARIO: "" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  procs.push(child);
  return new Promise((res, rej) => {
    let buf = "";
    const t = setTimeout(() => rej(new Error("mock timeout")), 10_000);
    child.stderr?.on("data", (c: Buffer) => {
      buf += c.toString("utf8");
      for (const line of buf.split("\n")) {
        try {
          const e = JSON.parse(line);
          if (e.event === "listening") {
            clearTimeout(t);
            res(`http://127.0.0.1:${e.port}`);
          }
        } catch {}
      }
    });
  });
}

/** Boot the exact bundled Cloud Run artifact and wait for /healthz. */
async function startRuntime(dir: string, mockBase: string): Promise<string> {
  const port = await freePort();
  const child = spawn(process.execPath, [join(dir, "deploy", "runtime", "server.js")], {
    env: {
      ...process.env,
      PORT: String(port),
      ANVIL_BASE_URL: mockBase,
      ANVIL_ENV: "dev",
      ANVIL_ALLOWED_HOSTS: "127.0.0.1",
      ANVIL_DEFAULT_TOKEN: "live-test",
      ANVIL_DEFAULT_API_KEY: "live-test",
      ANVIL_DEFAULT_USERNAME: "live",
      ANVIL_DEFAULT_PASSWORD: "live-test",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  procs.push(child);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return base;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("runtime server did not become ready");
}

describe("live conformance (against the generated Cloud Run server)", () => {
  it("upgrades only a successful explicitly evidenced delegated read", async () => {
    const air = await compile({
      spec: read("payments/openapi.yaml"),
      manifest: `operations:
  getPayment:
    state: approved
    auth:
      type: oauth2_on_behalf_of
      principal: delegated
      provider: { grant: token_exchange }
`,
      serviceId: "payments_live_obo",
    });
    const delegated = air.operations.filter((operation) => operation.state === "approved");
    const operationId = delegated[0]?.id;
    if (!operationId) throw new Error("fixture: no delegated operation");
    const artifactCheck = {
      id: "artifact-live",
      status: "pass" as const,
      expectedArtifactHash: "a".repeat(64),
      observedArtifactHash: "a".repeat(64),
    };

    const structuredError = liveIdentityReadiness(delegated, [
      artifactCheck,
      {
        id: "read-live",
        operationId,
        status: "pass",
        outcome: "structured_error",
        detail: "auth_required",
      },
    ]);
    expect(structuredError.liveIdpReadiness).toBe("unverified");
    expect(structuredError.verifiedOperationIds).toEqual([]);
    expect(
      liveIdentityGate(delegated, [
        artifactCheck,
        {
          id: "read-live",
          operationId,
          status: "pass",
          outcome: "structured_error",
        },
      ]),
    ).toMatchObject({ id: "identity-live", status: "fail" });

    const success = liveIdentityReadiness(delegated, [
      artifactCheck,
      {
        id: "read-live",
        operationId,
        status: "pass",
        outcome: "success",
        identityProof: "real_inbound_jwt_sts_upstream",
      },
    ]);
    expect(success).toMatchObject({
      liveIdpReadiness: "verified_for_opted_in_reads",
      proof: "real_inbound_jwt_sts_upstream",
      verifiedOperationIds: [operationId],
      unverifiedOperationIds: [],
    });
    expect(
      liveIdentityGate(delegated, [
        artifactCheck,
        {
          id: "read-live",
          operationId,
          status: "pass",
          outcome: "success",
          identityProof: "real_inbound_jwt_sts_upstream",
        },
      ]),
    ).toMatchObject({ id: "identity-live", status: "pass" });
  });

  it("requires one successful safe read per distinct delegated identity contract group", async () => {
    const air = await compile({
      spec: read("payments/openapi.yaml"),
      manifest: `operations:
  getPayment:
    state: approved
    auth:
      type: oauth2_on_behalf_of
      principal: delegated
      issuer: https://identity.example.com/
      audience: api://payments-a
      credential_profile: payments_a
      provider: { grant: token_exchange, token_endpoint: https://sts.example.com/token }
`,
      serviceId: "payments_live_groups",
    });
    const seed = air.operations.find((operation) => operation.state === "approved");
    if (!seed) throw new Error("fixture: no delegated operation");
    const clone = (id: string): Operation => ({ ...structuredClone(seed), id });
    const groupARead = clone("payments.group_a.read");
    const groupAWrite = clone("payments.group_a.write");
    groupAWrite.effect = { ...groupAWrite.effect, kind: "mutation" };
    const groupBRead = clone("payments.group_b.read");
    groupBRead.auth = {
      ...groupBRead.auth,
      issuer: "https://other-identity.example.com/",
      audience: "api://payments-b",
      credentialProfile: "payments_b",
      scopes: ["payments.b"],
    };
    const groupCWrite = clone("payments.group_c.write");
    groupCWrite.effect = { ...groupCWrite.effect, kind: "mutation" };
    groupCWrite.auth = {
      ...groupCWrite.auth,
      audience: "api://payments-c",
      credentialProfile: "payments_c",
      scopes: ["payments.c"],
    };
    const artifactCheck = {
      id: "artifact-live",
      status: "pass" as const,
      expectedArtifactHash: "b".repeat(64),
      observedArtifactHash: "b".repeat(64),
    };
    const proof = (operationId: string) => ({
      id: "read-live",
      operationId,
      status: "pass" as const,
      outcome: "success" as const,
      identityProof: "real_inbound_jwt_sts_upstream" as const,
    });
    const operations = [groupARead, groupAWrite, groupBRead, groupCWrite];
    const partialChecks = [artifactCheck, proof(groupARead.id), proof(groupBRead.id)];
    const partial = liveIdentityReadiness(operations, partialChecks);
    expect(partial).toMatchObject({
      delegatedOperations: 4,
      delegatedContractGroups: 3,
      liveIdpReadiness: "unverified",
      verifiedOperationIds: [groupARead.id, groupBRead.id],
      unverifiedOperationIds: [groupCWrite.id],
    });
    expect(partial.verifiedContractGroupIds).toHaveLength(2);
    expect(partial.unverifiedContractGroupIds).toHaveLength(1);
    expect(liveIdentityGate(operations, partialChecks)).toMatchObject({
      id: "identity-live",
      status: "fail",
      detail: expect.stringMatching(/no approved read/i),
    });

    const groupCRead = clone("payments.group_c.read");
    groupCRead.auth = structuredClone(groupCWrite.auth);
    const coveredOperations = [...operations, groupCRead];
    const coveredChecks = [...partialChecks, proof(groupCRead.id)];
    expect(liveIdentityReadiness(coveredOperations, coveredChecks)).toMatchObject({
      delegatedOperations: 5,
      delegatedContractGroups: 3,
      liveIdpReadiness: "verified_for_opted_in_reads",
      unverifiedOperationIds: [],
      unverifiedContractGroupIds: [],
    });
    expect(liveIdentityGate(coveredOperations, coveredChecks)).toMatchObject({
      id: "identity-live",
      status: "pass",
    });
  });

  it("verifies surface parity, the production confirmation gate, and an opt-in read", async () => {
    const dir = await buildBundle();
    const mockBase = await startMock(dir);
    const base = await startRuntime(dir, mockBase);

    const report = await runLiveConformance(dir, {
      mcpUrl: `${base}/mcp`,
      headers: {},
      probeReads: ["payments.customers.get"],
      inputs: { "payments.customers.get": { customer_id: "cus_live" } },
    });

    expect(LiveReport.parse(report)).toEqual(report);
    expect(report.schemaVersion).toBe(2);
    expect(report.summary.fail).toBe(0);
    expect(report.artifact).toEqual({
      algorithm: "sha256",
      expectedHash: deploymentArtifactHash(readBundleDir(dir)),
      observedHash: deploymentArtifactHash(readBundleDir(dir)),
      matched: true,
    });
    expect(report.identity).toEqual({
      delegatedOperations: 0,
      delegatedContractGroups: 0,
      verifiedContractGroupIds: [],
      unverifiedContractGroupIds: [],
      contractGroups: [],
      liveIdpReadiness: "not_applicable",
      proof: "not_applicable",
      verifiedOperationIds: [],
      unverifiedOperationIds: [],
      detail: "No approved delegated operations.",
    });

    // The deployed server serves exactly the certified surface.
    expect(report.checks.find((c) => c.id === "artifact-live")?.status).toBe("pass");
    expect(report.checks.find((c) => c.id === "surface-live")?.status).toBe("pass");

    // Both financial mutations refuse without confirm — in production.
    const gates = report.checks.filter((c) => c.id === "gate-live");
    expect(gates.map((c) => c.operationId).sort()).toEqual([
      "payments.capture.create",
      "payments.refunds.create",
    ]);
    expect(gates.every((c) => c.status === "pass")).toBe(true);

    // The opted-in read round-trips through the real serving path.
    expect(report.checks.find((c) => c.id === "read-live")?.status).toBe("pass");
  }, 120_000);

  it("rejects a stale deployment even when it serves the same tool names", async () => {
    const deployed = await buildBundle("deployed revision");
    const local = await buildBundle("new local revision with the same operation names");
    const mockBase = await startMock(deployed);
    const base = await startRuntime(deployed, mockBase);

    const report = await runLiveConformance(local, {
      mcpUrl: `${base}/mcp`,
      headers: {},
      probeReads: ["payments.customers.get"],
      inputs: { "payments.customers.get": { customer_id: "cus_live" } },
    });

    expect(report.artifact.matched).toBe(false);
    expect(report.artifact.expectedHash).not.toBe(report.artifact.observedHash);
    expect(report.checks).toEqual([
      expect.objectContaining({
        id: "artifact-live",
        status: "fail",
        detail: expect.stringMatching(/stale or different deployment/i),
      }),
    ]);
    expect(report.summary.fail).toBe(1);
  }, 120_000);

  it("fails closed when the endpoint is unreachable", async () => {
    const dir = await buildBundle();
    const unused = await freePort();
    const report = await runLiveConformance(dir, {
      mcpUrl: `http://127.0.0.1:${unused}/mcp`,
      headers: {},
      probeReads: [],
      inputs: {},
    });
    expect(report.summary.fail).toBeGreaterThan(0);
    expect(report.checks[0]).toMatchObject({ id: "artifact-live", status: "fail" });
    expect(report.checks[0]?.detail).toMatch(/could not attest/);
    expect(report.identity.liveIdpReadiness).toBe("not_applicable");
  }, 60_000);
});
