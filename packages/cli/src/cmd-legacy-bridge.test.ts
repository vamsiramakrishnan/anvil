import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finalizeLegacyCapabilityBindingRecord } from "@anvil/compiler/legacy";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAnvilCli } from "./anvil-cli.js";
import { bufferIO } from "./io.js";

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "anvil-legacy-bridge-"));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

async function anvil(...argv: string[]) {
  const io = bufferIO();
  const code = await runAnvilCli(argv, { io });
  return { code, out: io.stdout.join("\n"), err: io.stderr.join("\n") };
}

function writeBinding(): string {
  const binding = finalizeLegacyCapabilityBindingRecord({
    schemaVersion: 1,
    inventoryId: `li_${"1".repeat(64)}`,
    inventoryContentHash: `sha256:${"2".repeat(64)}`,
    candidateId: `lc_${"3".repeat(64)}`,
    candidateHash: `sha256:${"4".repeat(64)}`,
    taskId: `lrt_${"5".repeat(64)}`,
    taskHash: `sha256:${"6".repeat(64)}`,
    proposalId: `lrp_${"7".repeat(64)}`,
    proposalHash: `sha256:${"8".repeat(64)}`,
    receiptId: `lrr_${"9".repeat(64)}`,
    receiptHash: `sha256:${"a".repeat(64)}`,
    operation: {
      name: "refunds.submit_refund",
      summary: "Submit a refund",
      description: "Submit one refund request.",
      effect: "create",
      exposure: "mcp_tool",
      inputSchema: { type: "object", properties: { refundId: { type: "string" } } },
      outputSchema: { type: "object", properties: { accepted: { type: "boolean" } } },
      errors: [],
    },
    transport: {
      kind: "message",
      protocol: "jms",
      target: "jms/RefundRequests",
      direction: "produce",
      payloadEncoding: "json",
      reply: { mode: "none" },
    },
    semantics: {
      completion: "transport_accepted",
      timeoutMs: 15_000,
      authorization: { mode: "bridge_identity", scopes: [] },
      idempotency: { mode: "none" },
      retry: { mode: "never", maxAttempts: 1 },
    },
    runtime: { placement: "deployment_local_bridge", status: "not_implemented" },
  });
  const path = join(work, "binding.json");
  writeFileSync(path, `${JSON.stringify(binding)}\n`);
  return path;
}

describe("anvil legacy bridge plan", () => {
  it("emits a deterministic non-executable plan", async () => {
    const binding = writeBinding();
    const output = join(work, "bridge-plan.json");
    const first = await anvil("legacy", "bridge", "plan", binding, "--out", output, "--json");
    const second = await anvil("legacy", "bridge", "plan", binding, "--out", output, "--json");

    expect(first.code, first.err).toBe(0);
    expect(second).toEqual(first);
    const report = JSON.parse(first.out);
    expect(report).toMatchObject({
      reportType: "anvil.legacy-bridge-plan",
      plan: { executionAllowed: false, operationName: "refunds.submit_refund" },
    });
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(report);
  });

  it("fails closed when a driver lacks required capabilities", async () => {
    const descriptor = join(work, "driver.json");
    writeFileSync(
      descriptor,
      JSON.stringify({
        schemaVersion: 1,
        id: "thin-jms",
        version: "1.0.0",
        transports: [{ kind: "message", protocols: ["jms"] }],
        capabilities: ["transport_client"],
        deterministicGeneration: true,
        liveDiscovery: false,
        acceptsSecrets: false,
      }),
    );
    const result = await anvil(
      "legacy",
      "bridge",
      "plan",
      writeBinding(),
      "--driver",
      descriptor,
      "--json",
    );

    expect(result.code).toBe(1);
    expect(JSON.parse(result.out).driverAssessment).toMatchObject({
      driverId: "thin-jms",
      supported: false,
      missingCapabilities: expect.arrayContaining(["authorization", "recorded_conformance"]),
    });
  });
});
