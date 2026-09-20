import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
 * Rate limits, spend caps and the principal directory on the DEPLOYED
 * artifact. `ANVIL_RATE_LIMIT_*`, `ANVIL_SPEND_*`, `ANVIL_PRINCIPALS` and
 * `ANVIL_PRINCIPAL` were parsed on every surface and enforced only by
 * `anvil serve mcp --fleet`; the prebuilt Cloud Run server ran with no limits
 * and every caller as the anonymous, every-scope principal. This boots the
 * exact `deploy/runtime/server.js` a bundle ships and proves, over the real
 * StreamableHTTP transport, that the gates now hold there too.
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
  const dir = mkdtempSync(join(tmpdir(), "anvil-limits-live-"));
  dirs.push(dir);
  writeBundle(dir, generateBundle(air));
  ensureBundleNodeModules(dir);
  return dir;
}

async function startRuntime(dir: string, extra: Record<string, string>): Promise<string> {
  const port = await freePort();
  const child = spawn(process.execPath, [join(dir, "deploy", "runtime", "server.js")], {
    env: {
      ...process.env,
      PORT: String(port),
      ANVIL_ENV: "dev",
      ANVIL_ALLOWED_HOSTS: "payments.internal.example.com",
      ANVIL_DEFAULT_TOKEN: "limits-live-secret",
      ANVIL_DEFAULT_API_KEY: "limits-live-secret",
      ...extra,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  procs.push(child);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return base;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("runtime server did not become ready");
}

async function callRefundDryRun(base: string, key: string) {
  const client = new Client({ name: "anvil-limits-test", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  try {
    const tools = await client.listTools();
    const refund = tools.tools.find((t) => t.name.includes("refund"));
    expect(refund, "the payments bundle exposes an approved refund tool").toBeDefined();
    const result = (await client.callTool({
      name: refund?.name ?? "",
      arguments: {
        payment_id: "pay_1",
        amount: 100,
        currency: "usd",
        reason: "duplicate_charge",
        confirm: true,
        idempotency_key: key,
        anvil_dry_run: true,
      },
    })) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
    return {
      isError: result.isError === true,
      text: result.content.map((c) => c.text ?? "").join("\n"),
    };
  } finally {
    await client.close();
  }
}

describe("caller gates on the deployed Cloud Run artifact", () => {
  it("enforces ANVIL_RATE_LIMIT_* on the deployed server", async () => {
    const dir = await buildBundle();
    const base = await startRuntime(dir, {
      ANVIL_RATE_LIMIT_CAPACITY: "1",
      ANVIL_RATE_LIMIT_REFILL_PER_SECOND: "0.0001",
    });
    const first = await callRefundDryRun(base, "limits-1");
    expect(first.isError, first.text).toBe(false);
    const second = await callRefundDryRun(base, "limits-2");
    expect(second.isError).toBe(true);
    expect(second.text).toContain("rate_limited");
  }, 60_000);

  it("refuses a caller the configured principal directory does not name, and honors scopes for one it does", async () => {
    const dir = await buildBundle();
    // Directory configured, session principal absent: fail closed.
    const unresolved = await startRuntime(dir, {
      ANVIL_PRINCIPALS: "tok_ops:ops:payments.read",
    });
    const refused = await callRefundDryRun(unresolved, "principal-1");
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("principal_unresolved");

    // Resolved, but the refund needs a scope this principal lacks.
    const scoped = await startRuntime(dir, {
      ANVIL_PRINCIPALS: "tok_ops:ops:payments.read",
      ANVIL_PRINCIPAL: "tok_ops",
    });
    const denied = await callRefundDryRun(scoped, "principal-2");
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain("scope_denied");

    // Every scope: the call proceeds to its dry-run plan.
    const allowed = await startRuntime(dir, {
      ANVIL_PRINCIPALS: "tok_ops:ops:*",
      ANVIL_PRINCIPAL: "tok_ops",
    });
    const ok = await callRefundDryRun(allowed, "principal-3");
    expect(ok.isError, ok.text).toBe(false);
  }, 90_000);
});
