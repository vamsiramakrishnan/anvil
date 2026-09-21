import { createServer, type Server } from "node:http";
import { type Operation, Operation as OperationSchema } from "@anvil/air";
import { afterEach, describe, expect, it } from "vitest";
import {
  describeBinaryResult,
  execute,
  FetchTransport,
  type HttpResponse,
  InMemoryLedger,
  isBinaryResult,
  isTextualContentType,
  MAX_UPSTREAM_RESPONSE_BYTES,
  MockTransport,
  TransportError,
} from "./index.js";

/**
 * Binary response bodies, driven through a real loopback server so the bytes
 * on the socket — not a mock's idea of them — are what reaches the assertion.
 */
const PDF = Buffer.concat([
  Buffer.from("%PDF-1.7\n%", "latin1"),
  Buffer.from([0xe2, 0xe3, 0xcf, 0xd3, 0x00, 0xff, 0xfe]),
  Buffer.from("\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n", "latin1"),
]);

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  return new Promise((resolve) => {
    const listener = createServer(handler);
    server = listener;
    listener.listen(0, "127.0.0.1", () => {
      const port = (listener.address() as { port: number }).port;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

function op(path = "/report"): Operation {
  return OperationSchema.parse({
    id: "reports.report.get",
    canonicalName: "get_report",
    displayName: "Get report",
    sourceRef: { kind: "openapi", path, method: "get" },
    effect: { kind: "read", resource: "report", risk: "low", reversible: true },
    input: { params: [] },
    idempotency: { mode: "natural", keyDerivation: "none" },
    retries: { mode: "none", maxAttempts: 1, backoff: "none", retryOn: [] },
    confirmation: { required: false },
    auth: { type: "none", scopes: [] },
    cli: { command: "reports report get" },
    mcp: { toolName: "reports_get_report" },
    skill: { intentExamples: [] },
    state: "approved",
  });
}

describe("content-type awareness", () => {
  it("treats text, json, xml, forms, javascript and any charset-declared type as text", () => {
    for (const ct of [
      undefined,
      "",
      "text/plain",
      "text/html; charset=utf-8",
      "application/json",
      "application/problem+json",
      "application/xml",
      "application/soap+xml",
      "application/x-www-form-urlencoded",
      "application/javascript",
      "application/octet-stream; charset=utf-8",
    ]) {
      expect(isTextualContentType(ct), String(ct)).toBe(true);
    }
    for (const ct of ["application/pdf", "image/png", "application/octet-stream", "audio/ogg"]) {
      expect(isTextualContentType(ct), ct).toBe(false);
    }
  });
});

describe("FetchTransport with a binary upstream", () => {
  it("carries a PDF as base64 with its metadata instead of mangled text", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/pdf", "content-length": PDF.length });
      res.end(PDF);
    });
    const res = await new FetchTransport().send({
      method: "GET",
      url: `${url}/report`,
      headers: {},
    });
    expect(res.status).toBe(200);
    expect(res.bodyEncoding).toBe("base64");
    expect(Buffer.from(res.body, "base64").equals(PDF)).toBe(true);
  });

  it("still decodes a textual upstream as before", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
    const res = await new FetchTransport().send({ method: "GET", url: `${url}/x`, headers: {} });
    expect(res.bodyEncoding).toBeUndefined();
    expect(res.body).toBe('{"ok":true}');
  });

  it("keeps the byte cap on binary bodies", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200, {
        "content-type": "application/pdf",
        "content-length": MAX_UPSTREAM_RESPONSE_BYTES + 1,
      });
      res.end();
    });
    await expect(
      new FetchTransport().send({ method: "GET", url: `${url}/big`, headers: {} }),
    ).rejects.toBeInstanceOf(TransportError);
  });
});

describe("the codec and executor with a binary result", () => {
  it("returns a structured value describing the bytes", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/pdf" });
      res.end(PDF);
    });
    const res = await execute(
      op(),
      { input: {} },
      {
        serviceId: "reports",
        baseUrl: url,
        allowedHosts: ["127.0.0.1"],
        env: "dev",
        sleep: async () => {},
        rng: () => 0.5,
        transport: new FetchTransport(),
        ledger: new InMemoryLedger(),
      },
    );
    expect(res.outcome).toBe("success");
    if (res.outcome !== "success") throw new Error("expected success");
    expect(isBinaryResult(res.data)).toBe(true);
    expect(res.data).toEqual({
      contentType: "application/pdf",
      encoding: "base64",
      data: PDF.toString("base64"),
      bytes: PDF.length,
    });
    expect(describeBinaryResult(res.data as never)).toContain("application/pdf");
    expect(describeBinaryResult(res.data as never)).toContain(`${PDF.length} bytes`);
  });

  it("does the same through an injected transport, so mocks and fetch agree", async () => {
    const png: HttpResponse = {
      status: 200,
      headers: { "content-type": "image/png" },
      body: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"),
      bodyEncoding: "base64",
    };
    const res = await execute(
      op(),
      { input: {} },
      {
        serviceId: "reports",
        baseUrl: "https://reports.example.com",
        allowedHosts: ["reports.example.com"],
        env: "dev",
        sleep: async () => {},
        rng: () => 0.5,
        transport: new MockTransport(() => png),
        ledger: new InMemoryLedger(),
      },
    );
    expect(res.outcome).toBe("success");
    if (res.outcome !== "success") throw new Error("expected success");
    expect(res.data).toMatchObject({ contentType: "image/png", encoding: "base64", bytes: 4 });
  });

  it("does not mistake an ordinary object for a binary result", () => {
    expect(isBinaryResult({ encoding: "base64", data: "x" })).toBe(false);
    expect(isBinaryResult({ contentType: "a", encoding: "utf8", data: "x", bytes: 1 })).toBe(false);
    expect(isBinaryResult("x")).toBe(false);
    expect(isBinaryResult(null)).toBe(false);
  });
});
