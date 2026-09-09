import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { processEnvironment } from "@anvil/fuzz";
import { generateBundle, writeBundle } from "@anvil/generators";
import type { BusinessResult, HttpRequest } from "@anvil/runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, it } from "vitest";
import { businessFixtureContract, OwnedBusinessBackend } from "./fixture.js";

it("serves HTTP and MCP through the prebuilt private runtime, including approval and replay", async () => {
  const { air, plan } = businessFixtureContract();
  const backend = new OwnedBusinessBackend();
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const reply = await backend.send({
      method: req.method as HttpRequest["method"],
      url: `http://127.0.0.1${req.url}`,
      headers: Object.fromEntries(
        Object.entries(req.headers).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
      body: Buffer.concat(chunks).toString(),
    });
    res.writeHead(reply.status, reply.headers);
    res.end(reply.body);
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as AddressInfo).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const root = mkdtempSync(join(tmpdir(), "anvil-business-serving-"));
  writeBundle(root, generateBundle(air, { businessPlan: plan }));
  const approvalFile = join(root, "approvals.json");
  writeFileSync(approvalFile, "[]");
  let child: ChildProcess | undefined;
  let client: Client | undefined;
  let stderr = "";
  try {
    child = spawn(process.execPath, [join(root, "runtime/server.js")], {
      env: processEnvironment({
        PORT: String(port),
        ANVIL_ENV: "dev",
        ANVIL_INBOUND_AUTH_MODE: "none",
        ANVIL_BUSINESS_CONTEXT: JSON.stringify({
          tenant: "tenant-a",
          principal: "owned-user",
          policyVersion: "owned-v1",
          scopes: ["*"],
        }),
        ANVIL_BUSINESS_SOURCES: JSON.stringify(
          Object.fromEntries(
            Object.keys(plan.sources).map((name) => [name, { baseUrl: upstreamUrl }]),
          ),
        ),
        ANVIL_BUSINESS_APPROVAL_FILE: approvalFile,
      }),
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempts = 0; attempts < 100; attempts++) {
      if (child.exitCode !== null) throw new Error(`Runtime exited: ${stderr}`);
      try {
        ready = (await fetch(`${base}/healthz`)).ok;
      } catch {
        /* Wait for listen. */
      }
      if (ready) break;
      await pause(30);
    }
    expect(ready, stderr).toBe(true);
    const post = async (action: string, input: unknown, key: string) =>
      (
        await fetch(`${base}/business/${action}`, {
          method: "POST",
          headers: { "content-type": "application/json", "Idempotency-Key": key },
          body: JSON.stringify(input),
        })
      ).json();
    const first = await post(
      "complete_return",
      { order_ref: "order-1", refund_amount: 4200 },
      "return",
    );
    expect(first).toMatchObject({
      status: "completed",
      result: { return_ref: "refund-1", support_ref: "case-1" },
    });
    expect(
      await post("complete_return", { order_ref: "order-1", refund_amount: 4200 }, "return"),
    ).toEqual(first);
    client = new Client({ name: "owned-business-test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["complete_return", "amend_order", "grant_account_access"]),
    );
    expect(JSON.stringify(tools)).not.toContain("raw_order_lookup");
    const denied = (await post(
      "grant_account_access",
      { account_ref: "alice", role: "viewer" },
      "grant",
    )) as BusinessResult;
    expect(denied.status).toBe("approval_required");
    writeFileSync(
      approvalFile,
      JSON.stringify([
        {
          digest: denied.approval_digest,
          approvedBy: "owned-human-review",
          expiresAt: Date.now() + 60_000,
        },
      ]),
    );
    const response = await client.callTool({
      name: "grant_account_access",
      arguments: { account_ref: "alice", role: "viewer", confirm: true, idempotency_key: "grant" },
    });
    expect(response.isError).not.toBe(true);
    expect(JSON.stringify(response)).toContain("grant-1");
    expect(backend.state).toMatchObject({ refunds: 1, cases: 1, grants: 1 });
    const resources = await client.listResources();
    expect(JSON.stringify(resources)).not.toContain("business.plan.json");
    expect(
      (
        await fetch(`${base}/business/raw_refund_write`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(404);
  } finally {
    await client?.close();
    child?.kill("SIGKILL");
    if (child && child.exitCode === null && child.signalCode === null)
      await new Promise<void>((resolve) => child!.once("exit", () => resolve()));
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
