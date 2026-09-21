import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { fileURLToPath } from "node:url";
import { type Operation, Operation as OperationSchema } from "@anvil/air";
import { describe, expect, it, vi } from "vitest";
import { execute } from "./executor.js";
import { InMemoryObserver } from "./observability.js";
import { FetchTransport, type HttpRequest, MockTransport, TransportError } from "./transport.js";

const FIXTURES = fileURLToPath(new URL("../test-fixtures/tls/", import.meta.url));
const pem = (name: string) => readFileSync(`${FIXTURES}${name}`, "utf8");

/** A retry-safe read: the executor WOULD retry a transport failure on it. */
function readOp(): Operation {
  return OperationSchema.parse({
    id: "things.list",
    canonicalName: "list_things",
    displayName: "List things",
    sourceRef: { kind: "openapi", path: "/things", method: "get" },
    effect: { kind: "read", action: "list", resource: "thing", risk: "none" },
    input: { params: [] },
    idempotency: { mode: "natural", mechanism: "none" },
    retries: { mode: "safe", maxAttempts: 3, backoff: "none", retryOn: ["timeout"] },
    confirmation: { required: false },
    auth: { type: "none", scopes: [] },
    cli: { command: "things list" },
    mcp: { toolName: "list_things" },
    skill: { intentExamples: [] },
    state: "approved",
  });
}

function context(transport: MockTransport | FetchTransport, signal: AbortSignal) {
  const observer = new InMemoryObserver();
  return {
    ctx: {
      transport,
      serviceId: "test",
      baseUrl: "https://api.example.com",
      allowedHosts: ["api.example.com", "127.0.0.1"],
      env: "dev",
      signal,
      observer,
      sleep: async () => {},
    },
    observer,
  };
}

describe("execute() under a caller's abort signal", () => {
  it("refuses before the request is sent when the signal is already aborted", async () => {
    const transport = new MockTransport(() => ({ status: 200, headers: {}, body: "{}" }));
    const controller = new AbortController();
    controller.abort();
    const { ctx, observer } = context(transport, controller.signal);

    const result = await execute(readOp(), { input: {} }, ctx);

    expect(transport.requests).toHaveLength(0);
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.envelope.error.code).toBe("policy_denied");
    expect(result.envelope.error.details).toEqual({
      code: "request/cancelled",
      upstream_outcome: "not_sent",
    });
    expect(result.envelope.error.retryable).toBe(false);
    // Nothing left the process, so a later retry is exactly as safe as the read is.
    expect(result.envelope.error.safe_to_retry).toBe(true);
    expect(result.envelope.error.message).toContain("before the request was sent");
    expect(observer.records[0]?.errorCode).toBe("policy_denied");
    expect(observer.records[0]?.retryCount).toBe(0);
  });

  it("threads the signal onto the wire request and does not retry a mid-flight abort", async () => {
    const controller = new AbortController();
    const transport = new MockTransport((req: HttpRequest) => {
      expect(req.signal).toBe(controller.signal);
      // The client cancels while the attempt is in flight; the transport
      // surfaces it the way an aborted fetch does — as a timeout condition.
      controller.abort();
      return new TransportError("timeout", "aborted");
    });
    const { ctx } = context(transport, controller.signal);

    const result = await execute(readOp(), { input: {} }, ctx);

    // A retry-safe read on a retryable condition would ordinarily try again;
    // a cancelled one must not.
    expect(transport.requests).toHaveLength(1);
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.envelope.error.code).toBe("policy_denied");
    expect(result.envelope.error.details).toEqual({
      code: "request/cancelled",
      upstream_outcome: "unknown",
    });
    expect(result.envelope.error.retryable).toBe(false);
    expect(result.envelope.error.safe_to_retry).toBe(false);
    expect(result.envelope.error.message).toContain("outcome is unknown");
  });

  it("changes nothing when the signal is never tripped", async () => {
    const transport = new MockTransport((_req, attempt) =>
      attempt === 1
        ? new TransportError("timeout", "slow")
        : { status: 200, headers: {}, body: '{"ok":true}' },
    );
    const { ctx } = context(transport, new AbortController().signal);

    const result = await execute(readOp(), { input: {} }, ctx);

    expect(result.outcome).toBe("success");
    expect(transport.requests).toHaveLength(2);
  });

  it("never lets the signal leak into a dry-run plan", async () => {
    const transport = new MockTransport(() => ({ status: 200, headers: {}, body: "{}" }));
    const { ctx } = context(transport, new AbortController().signal);
    const result = await execute(readOp(), { input: {}, dryRun: true }, ctx);
    expect(result.outcome).toBe("dry_run");
    if (result.outcome !== "dry_run") return;
    expect(JSON.stringify(result.plan)).not.toContain("signal");
  });
});

describe("FetchTransport honours HttpRequest.signal", () => {
  it("aborts the in-flight fetch when the caller's signal trips", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        }),
    ) as typeof fetch;
    const pending = new FetchTransport(fetchImpl).send({
      method: "GET",
      url: "https://api.example.com/things",
      headers: {},
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "TransportError", condition: "timeout" });
  });

  it("refuses at once when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let observed: AbortSignal | null | undefined;
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      observed = init?.signal;
      if (init?.signal?.aborted) {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    await expect(
      new FetchTransport(fetchImpl).send({
        method: "GET",
        url: "https://api.example.com/things",
        headers: {},
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(TransportError);
    expect(observed?.aborted).toBe(true);
  });

  it("stops listening on the caller's signal once the request settles", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 })) as typeof fetch;
    const transport = new FetchTransport(fetchImpl);
    for (let i = 0; i < 25; i += 1) {
      await transport.send({
        method: "GET",
        url: "https://api.example.com/things",
        headers: {},
        signal: controller.signal,
      });
    }
    // Node warns past 10 listeners on one EventTarget; a leak would have hit it.
    const warn = vi.spyOn(process, "emitWarning");
    controller.abort();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("tears down the node:https (mTLS) path on abort exactly like the fetch path", async () => {
    const server: Server = createServer(
      {
        cert: pem("server-cert.pem"),
        key: pem("server-key.pem"),
        ca: pem("ca-cert.pem"),
        requestCert: true,
        rejectUnauthorized: true,
      },
      () => {
        // Never answer: only the caller's abort can end this request.
      },
    );
    const url = await new Promise<string>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const port = (server.address() as { port: number }).port;
        resolve(`https://127.0.0.1:${port}`);
      });
    });
    try {
      const controller = new AbortController();
      const pending = new FetchTransport().send({
        method: "GET",
        url: `${url}/slow`,
        headers: {},
        timeoutMs: 30_000,
        signal: controller.signal,
        tls: { cert: pem("client-cert.pem"), key: pem("client-key.pem"), ca: pem("ca-cert.pem") },
      });
      setTimeout(() => controller.abort(), 50);
      await expect(pending).rejects.toMatchObject({
        name: "TransportError",
        condition: "timeout",
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
