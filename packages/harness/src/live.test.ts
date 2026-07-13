import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "@anvil/compiler";
import { generateBundle, writeBundle } from "@anvil/generators";
import { afterAll, describe, expect, it } from "vitest";
import { ensureBundleNodeModules } from "./bundle-driver.js";
import { LiveReport, runLiveConformance } from "./live.js";

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

async function buildBundle(): Promise<string> {
  const air = await compile({
    spec: read("payments/openapi.yaml"),
    manifest: read("payments/anvil.yaml"),
    serviceId: "payments",
  });
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

/** Boot the generated Cloud Run server (runtime/server.js) and wait for /healthz. */
async function startRuntime(dir: string, mockBase: string): Promise<string> {
  const port = await freePort();
  const child = spawn(process.execPath, [join(dir, "runtime", "server.js")], {
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
    expect(report.summary.fail).toBe(0);

    // The deployed server serves exactly the certified surface.
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
    expect(report.checks[0]?.detail).toMatch(/could not connect/);
  }, 60_000);
});
