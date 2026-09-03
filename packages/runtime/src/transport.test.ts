import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FetchTransport, MAX_UPSTREAM_RESPONSE_BYTES, TransportError } from "./transport.js";

const FIXTURES = fileURLToPath(new URL("../test-fixtures/tls/", import.meta.url));
const pem = (name: string) => readFileSync(`${FIXTURES}${name}`, "utf8");
const CA = pem("ca-cert.pem");
const SERVER_CERT = pem("server-cert.pem");
const SERVER_KEY = pem("server-key.pem");
const CLIENT_CERT = pem("client-cert.pem");
const CLIENT_KEY = pem("client-key.pem");

/** A real local mTLS server (requestCert + rejectUnauthorized): only a caller
 * presenting a certificate the test CA signed is let past the TLS handshake
 * at all — anonymous connections never reach `handler`. */
function withMtlsServer(
  handler: (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ) => void,
): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer(
      { cert: SERVER_CERT, key: SERVER_KEY, ca: CA, requestCert: true, rejectUnauthorized: true },
      handler,
    );
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ server, url: `https://127.0.0.1:${port}` });
    });
  });
}

describe("FetchTransport bounds", () => {
  it("always installs an upstream deadline even when the caller omits one", async () => {
    let signal: AbortSignal | null | undefined;
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      signal = init?.signal;
      return new Response('{"ok":true}', { status: 200 });
    }) as typeof fetch;

    await new FetchTransport(fetchImpl).send({
      method: "GET",
      url: "https://api.example.com/health",
      headers: {},
    });

    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("classifies an oversized response as post-response commit ambiguity", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response("not-read", {
        status: 201,
        headers: { "content-length": String(MAX_UPSTREAM_RESPONSE_BYTES + 1) },
      });
    }) as typeof fetch;

    const error = await new FetchTransport(fetchImpl)
      .send({
        method: "POST",
        url: "https://api.example.com/writes",
        headers: {},
        body: "{}",
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TransportError);
    expect(error).toMatchObject({
      condition: "connection_reset",
      phase: "after_response",
    });
  });

  it("refuses redirects without replaying a write or forwarding its carriers", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(null, {
        status: 307,
        headers: { location: "https://unapproved.example/steal" },
      });
    }) as typeof fetch;

    const error = await new FetchTransport(fetchImpl)
      .send({
        method: "POST",
        url: "https://approved.example/writes",
        headers: {
          authorization: "Bearer secret",
          "idempotency-key": "business-write-1",
        },
        body: "{}",
      })
      .catch((caught: unknown) => caught);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://approved.example/writes",
      expect.objectContaining({ redirect: "manual" }),
    );
    expect(error).toBeInstanceOf(TransportError);
    expect(error).toMatchObject({
      condition: "connection_reset",
      phase: "after_response",
    });
  });
});

describe("FetchTransport mTLS (node:https path, a real local TLS server)", () => {
  let server: Server | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  it("presents the client certificate and returns the server's response", async () => {
    const seen: { cn?: string } = {};
    const started = await withMtlsServer((req, res) => {
      const cert = (
        req.socket as unknown as { getPeerCertificate(): { subject?: { CN?: string } } }
      ).getPeerCertificate();
      seen.cn = cert.subject?.CN;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    server = started.server;

    const res = await new FetchTransport().send({
      method: "GET",
      url: `${started.url}/accounts`,
      headers: {},
      tls: { cert: CLIENT_CERT, key: CLIENT_KEY, ca: CA },
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    // Proof the cert was actually PRESENTED and verified by the server's own
    // TLS stack — not merely that the call happened to succeed some other way.
    expect(seen.cn).toBe("anvil-test-client");
  });

  it("fails closed (never falls back to plain fetch) when no client certificate is presented", async () => {
    const started = await withMtlsServer((_req, res) => {
      res.writeHead(200);
      res.end("unreachable");
    });
    server = started.server;

    const error = await new FetchTransport()
      .send({ method: "GET", url: `${started.url}/accounts`, headers: {} })
      .catch((caught: unknown) => caught);

    // No req.tls ⇒ this went over the untouched fetch path, which has no
    // client cert to offer this mTLS-only server, so the handshake itself
    // refuses the connection.
    expect(error).toBeInstanceOf(TransportError);
  });

  it("enforces the same byte cap over node:https as the fetch path", async () => {
    const oversized = "x".repeat(MAX_UPSTREAM_RESPONSE_BYTES + 1);
    const started = await withMtlsServer((_req, res) => {
      res.writeHead(200, { "content-length": String(oversized.length) });
      res.end(oversized);
    });
    server = started.server;

    const error = await new FetchTransport()
      .send({
        method: "GET",
        url: `${started.url}/dump`,
        headers: {},
        tls: { cert: CLIENT_CERT, key: CLIENT_KEY, ca: CA },
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TransportError);
    expect(error).toMatchObject({ condition: "connection_reset", phase: "after_response" });
  });

  it("refuses a redirect over node:https exactly like the fetch path", async () => {
    const started = await withMtlsServer((_req, res) => {
      res.writeHead(307, { location: "https://unapproved.example/steal" });
      res.end();
    });
    server = started.server;

    const error = await new FetchTransport()
      .send({
        method: "POST",
        url: `${started.url}/writes`,
        headers: { authorization: "Bearer secret" },
        body: "{}",
        tls: { cert: CLIENT_CERT, key: CLIENT_KEY, ca: CA },
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TransportError);
    expect(error).toMatchObject({ condition: "connection_reset", phase: "after_response" });
  });

  it("classifies a connection refusal on the mTLS path the same way as the fetch path", async () => {
    const error = await new FetchTransport()
      .send({
        method: "GET",
        // Nothing listens on this port; the connection itself must fail.
        url: "https://127.0.0.1:1/accounts",
        headers: {},
        tls: { cert: CLIENT_CERT, key: CLIENT_KEY, ca: CA },
        timeoutMs: 2000,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TransportError);
  });
});
