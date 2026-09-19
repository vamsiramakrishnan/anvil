import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "@anvil/compiler";
import { generateBundle, writeBundle } from "@anvil/generators";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, describe, expect, it } from "vitest";
import { ensureBundleNodeModules } from "./bundle-driver.js";

/**
 * Runtime extensions on the DEPLOYED artifact. This boots the exact prebuilt
 * Cloud Run server a bundle ships (`deploy/runtime/server.js`) with an
 * operator extension module configured through `ANVIL_EXTENSIONS` and the
 * `stdout` record exporter selected through `ANVIL_OTEL_EXPORTER`, then
 * proves over the real StreamableHTTP transport that: the extension is
 * reported on `/healthz`; its policy hook refuses a tool call with the
 * runtime's own `policy_denied` envelope; the refusal is counted on
 * `/metrics` in OpenMetrics form; and one structured JSON record line reaches
 * stdout, carrying no credential. No external network.
 */

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../../examples/${rel}`, import.meta.url)), "utf8");

const dirs: string[] = [];
const procs: ChildProcess[] = [];

afterAll(() => {
  for (const p of procs) p.kill("SIGKILL");
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const freePort = (): Promise<number> =>
  new Promise((res) => {
    const s = createServer();
    s.listen(0, () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => res(port));
    });
  });

async function buildBundle(): Promise<string> {
  const air = await compile({
    spec: read("payments/openapi.yaml"),
    manifest: read("payments/anvil.yaml"),
    serviceId: "payments",
  });
  const dir = mkdtempSync(join(tmpdir(), "anvil-ext-live-"));
  dirs.push(dir);
  writeBundle(dir, generateBundle(air));
  ensureBundleNodeModules(dir);
  return dir;
}

const EXTENSION = `
// An operator extension: refuses every mutation whose input names a blocked
// account, records a decision on every call, and mirrors records to its own sink.
// preAuth runs after the approval, confirmation, and idempotency gates and
// before any credential is acquired — a denial here never touches a secret.
export default (api) => ({
  name: "acme-guard",
  policy: {
    preAuth(ctx) {
      ctx.decide("acme_guard:checked");
      if (ctx.operation.effect.kind === "mutation" && ctx.input.payment_id === "pay_blocked") {
        api.denyPolicy(ctx, "pay_blocked is under review; refunds are frozen.");
      }
    },
  },
  observer: { onRecord() {} },
});
`;

interface Booted {
  base: string;
  stdout: () => string;
}

async function startRuntime(dir: string, extensionPath: string): Promise<Booted> {
  const port = await freePort();
  const child = spawn(process.execPath, [join(dir, "deploy", "runtime", "server.js")], {
    env: {
      ...process.env,
      PORT: String(port),
      ANVIL_ENV: "dev",
      // The egress allowlist gate runs before the policy hooks; the hook must
      // be what refuses, so the compiled upstream host is allowed (and never
      // reached, because the hook denies first).
      ANVIL_ALLOWED_HOSTS: "payments.internal.example.com",
      ANVIL_EXTENSIONS: extensionPath,
      ANVIL_OTEL_EXPORTER: "stdout",
      ANVIL_DEFAULT_TOKEN: "ext-live-secret",
      ANVIL_DEFAULT_API_KEY: "ext-live-secret",
      ANVIL_DEFAULT_USERNAME: "live",
      ANVIL_DEFAULT_PASSWORD: "ext-live-secret",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  procs.push(child);
  let out = "";
  child.stdout?.on("data", (c: Buffer) => {
    out += c.toString("utf8");
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return { base, stdout: () => out };
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("runtime server did not become ready");
}

describe("runtime extensions on the deployed Cloud Run artifact", () => {
  it("loads the operator module, enforces its policy over MCP, and exports records", async () => {
    const dir = await buildBundle();
    const extensionPath = join(dir, "acme-guard.mjs");
    writeFileSync(extensionPath, EXTENSION);
    const { base, stdout } = await startRuntime(dir, extensionPath);

    // /healthz names the module, what it contributed, and the exporter.
    const health = (await (await fetch(`${base}/healthz`)).json()) as {
      exporter: string;
      extensions: Array<{ name: string; contributes: string[]; sha256?: string }>;
    };
    expect(health.exporter).toBe("stdout");
    expect(health.extensions.map((e) => e.name)).toEqual(["acme-guard"]);
    expect(health.extensions[0]?.contributes).toEqual(["policy", "observer"]);
    expect(health.extensions[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);

    const client = new Client({ name: "anvil-ext-test", version: "0.1.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    try {
      const tools = await client.listTools();
      const refund = tools.tools.find((t) => t.name.includes("refund"));
      expect(refund, "the payments bundle exposes an approved refund tool").toBeDefined();
      const result = (await client.callTool({
        name: refund?.name ?? "",
        arguments: {
          payment_id: "pay_blocked",
          amount: 100,
          currency: "usd",
          reason: "duplicate_charge",
          confirm: true,
          idempotency_key: "ext-live-1",
        },
      })) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
      const text = result.content.map((c) => c.text ?? "").join("\n");
      expect(result.isError).toBe(true);
      expect(text).toContain("policy_denied");
      expect(text).toContain("refunds are frozen");
    } finally {
      await client.close();
    }

    // The refusal is a first-class OpenMetrics counter.
    const metrics = await fetch(`${base}/metrics?format=openmetrics`);
    expect(metrics.headers.get("content-type")).toContain("application/openmetrics-text");
    const exposition = await metrics.text();
    expect(exposition).toContain(
      'anvil_policy_denied_total{operation="payments.refunds.create"} 1',
    );
    expect(exposition).toContain('outcome="error",error_code="policy_denied"} 1');
    // …and the JSON shape every existing probe reads is unchanged.
    expect(await (await fetch(`${base}/metrics`)).json()).toEqual({ records: 1 });

    // One structured record line on stdout, with the hook's decision and no secret.
    const line = stdout()
      .split("\n")
      .find((l) => l.includes('"operationId":"payments.refunds.create"'));
    expect(line).toBeDefined();
    const record = JSON.parse(line ?? "{}") as Record<string, unknown>;
    expect(record.severity).toBe("WARNING");
    expect(record.errorCode).toBe("policy_denied");
    expect(record.policyDecisions).toEqual(["acme_guard:checked"]);
    expect(stdout()).not.toContain("ext-live-secret");
  }, 60_000);

  it("refuses to boot when the configured extension is missing", async () => {
    const dir = await buildBundle();
    const port = await freePort();
    const child = spawn(process.execPath, [join(dir, "deploy", "runtime", "server.js")], {
      env: {
        ...process.env,
        PORT: String(port),
        ANVIL_ENV: "dev",
        ANVIL_ALLOWED_HOSTS: "127.0.0.1",
        ANVIL_POLICY_BUNDLE: join(dir, "not-there.mjs"),
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    procs.push(child);
    let err = "";
    child.stderr?.on("data", (c: Buffer) => {
      err += c.toString("utf8");
    });
    const code = await new Promise<number | null>((res) => child.once("exit", (c) => res(c)));
    expect(code).not.toBe(0);
    expect(err).toContain("Refusing to serve");
    await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
  }, 60_000);
});
