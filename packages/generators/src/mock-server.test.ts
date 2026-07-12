import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AirDocument } from "@anvil/air";
import { compile } from "@anvil/compiler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateBundle, writeBundle } from "./bundle.js";

/**
 * The emitted mock server must behave like a contract-checking upstream, not a
 * canned replayer: route by method+path, validate against the operation's input
 * contract, capture every request (auth material redacted), and expose the
 * /__anvil control surface. These tests boot the generated .mjs for real.
 */

const read = (rel: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../../examples/payments/${rel}`, import.meta.url)),
    "utf8",
  );

let air: AirDocument;
let dir: string;
let child: ChildProcess;
let base: string;

/** Boot mock/server.mjs on an ephemeral port and wait for its ready line. */
function startMock(bundleDir: string): Promise<{ port: number; child: ChildProcess }> {
  const proc = spawn(process.execPath, [join(bundleDir, "mock", "server.mjs")], {
    env: { ...process.env, PORT: "0", ANVIL_MOCK_SCENARIO: "" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("mock did not report listening")), 15_000);
    proc.stderr?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (const line of buffer.split("\n")) {
        try {
          const event = JSON.parse(line) as { event?: string; port?: number };
          if (event.event === "listening" && typeof event.port === "number") {
            clearTimeout(timer);
            resolve({ port: event.port, child: proc });
            return;
          }
        } catch {
          // not a complete JSON line yet
        }
      }
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`mock exited before listening (code ${code})`));
    });
  });
}

interface CaptureView {
  matchedOpId: string | null;
  matchedCandidates: string[];
  pathParams: Record<string, string> | null;
  query: Record<string, string>;
  headers: Record<string, string>;
}

const capture = async (): Promise<CaptureView[]> => {
  const res = await fetch(`${base}/__anvil/capture`);
  return ((await res.json()) as { requests: CaptureView[] }).requests;
};
const reset = () => fetch(`${base}/__anvil/reset`, { method: "POST" });

beforeAll(async () => {
  air = await compile({
    spec: read("openapi.yaml"),
    manifest: read("anvil.yaml"),
    serviceId: "payments",
  });
  dir = mkdtempSync(join(tmpdir(), "anvil-mock-test-"));
  writeBundle(dir, generateBundle(air));
  const started = await startMock(dir);
  child = started.child;
  base = `http://127.0.0.1:${started.port}`;
}, 60_000);

afterAll(() => {
  child?.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
});

describe("generated mock server", () => {
  it("routes by method + path template and replays the operation's success scenario", async () => {
    await reset();
    const res = await fetch(`${base}/customers/c_123`);
    expect(res.status).toBe(200);
    const scenarios = JSON.parse(readFileSync(join(dir, "mock", "scenarios.json"), "utf8"));
    const success = scenarios.find((s: { name: string }) => s.name === "get_customer_success");
    expect(await res.json()).toEqual(success.body);
  });

  it("routes a POST to the mutation, not the sibling read", async () => {
    await reset();
    const res = await fetch(`${base}/payments/p_1/refunds`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: 100, currency: "USD" }),
    });
    expect(res.status).toBe(201);
    const [req] = await capture();
    expect(req.matchedOpId).toBe("payments.refunds.create");
    expect(req.pathParams).toEqual({ payment_id: "p_1" });
  });

  it("rejects a request missing required body fields with a structured 400", async () => {
    const res = await fetch(`${base}/payments/p_1/refunds`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: 100 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; missing: string[] } };
    expect(body.error.code).toBe("mock_validation_failed");
    expect(body.error.missing).toContain("body.currency");
  });

  it("rejects an unparseable JSON body as invalid", async () => {
    const res = await fetch(`${base}/payments/p_1/refunds`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { invalid: string[] } };
    expect(body.error.invalid.join(" ")).toMatch(/not valid JSON/);
  });

  it("404s an unmatched route and names the nearest candidates", async () => {
    const res = await fetch(`${base}/payments/p_1/nonsense`, { method: "POST" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error: { code: string; candidates: Array<{ operationId: string }> };
    };
    expect(body.error.code).toBe("mock_no_route");
    expect(body.error.candidates.length).toBeGreaterThan(0);
    expect(body.error.candidates[0]?.operationId).toMatch(/^payments\./);
  });

  it("captures requests with auth material redacted — never stored", async () => {
    await reset();
    await fetch(`${base}/customers/c_9?verbose=1`, {
      headers: { authorization: "Bearer super-secret", "x-api-key": "also-secret" },
    });
    const [req] = await capture();
    expect(req.matchedOpId).toBe("payments.customers.get");
    expect(req.query).toEqual({ verbose: "1" });
    expect(req.headers.authorization).toBe("***");
    expect(req.headers["x-api-key"]).toBe("***");
    expect(JSON.stringify(req)).not.toContain("secret");
  });

  it("clears the capture buffer on reset", async () => {
    await fetch(`${base}/customers/c_9`);
    expect((await capture()).length).toBeGreaterThan(0);
    await reset();
    expect(await capture()).toEqual([]);
  });

  it("serves an activated error scenario via the control endpoint", async () => {
    await reset();
    await fetch(`${base}/__anvil/scenario`, {
      method: "POST",
      body: JSON.stringify({ name: "get_customer_not_found" }),
    });
    const res = await fetch(`${base}/customers/c_missing`);
    expect(res.status).toBe(404);
    await fetch(`${base}/__anvil/scenario`, {
      method: "POST",
      body: JSON.stringify({ name: null }),
    });
    expect((await fetch(`${base}/customers/c_ok`)).status).toBe(200);
  });

  it("rejects activating a scenario that does not exist", async () => {
    const res = await fetch(`${base}/__anvil/scenario`, {
      method: "POST",
      body: JSON.stringify({ name: "no_such_scenario" }),
    });
    expect(res.status).toBe(400);
  });

  it("injects a fault for exactly N matched requests, then recovers", async () => {
    await reset();
    await fetch(`${base}/__anvil/fault`, {
      method: "POST",
      body: JSON.stringify({ opId: "payments.customers.get", status: 503, times: 1 }),
    });
    expect((await fetch(`${base}/customers/c_1`)).status).toBe(503);
    expect((await fetch(`${base}/customers/c_1`)).status).toBe(200);
    // The fault only hits its own operation.
    await fetch(`${base}/__anvil/fault`, {
      method: "POST",
      body: JSON.stringify({ opId: "payments.customers.get", status: 503, times: 1 }),
    });
    expect((await fetch(`${base}/payments/p_1`)).status).toBe(200);
  });

  it("records every candidate operation for ambiguous routes", async () => {
    await reset();
    await fetch(`${base}/customers/c_1`);
    const [req] = await capture();
    expect(req.matchedCandidates).toEqual(["payments.customers.get"]);
  });
});
