import { type Operation, Operation as OperationSchema, type RequestBody } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { execute, type HttpResponse, InMemoryLedger, MockTransport } from "./index.js";

/**
 * Request bodies on the wire, asserted against the bytes a real server would
 * parse rather than against anything recomputed from AIR.
 *
 * The load-bearing assertion for every refusal is that the credential resolver
 * was never consulted: a body the runtime cannot encode is refused before the
 * secret it would have been sent with is read.
 */
function op(body: Partial<RequestBody> & { contentType: string }, overrides: Record<string, unknown> = {}): Operation {
  return OperationSchema.parse({
    id: "files.upload.create",
    canonicalName: "create_upload",
    displayName: "Upload",
    sourceRef: { kind: "openapi", path: "/uploads", method: "post" },
    effect: { kind: "mutation", resource: "upload", risk: "low", reversible: true },
    input: {
      params: [],
      body: { required: true, schema: { type: "object" }, projection: "whole", fields: [], ...body },
    },
    idempotency: { mode: "natural", keyDerivation: "none" },
    retries: { mode: "none", maxAttempts: 1, backoff: "none", retryOn: [] },
    confirmation: { required: false },
    auth: { type: "api_key", scopes: [] },
    cli: { command: "files upload create" },
    mcp: { toolName: "files_create_upload" },
    skill: { intentExamples: [] },
    state: "approved",
    ...overrides,
  });
}

const ok = (body: unknown): HttpResponse => ({ status: 200, headers: {}, body: JSON.stringify(body) });

function ctx(transport: MockTransport) {
  let credentialReads = 0;
  const credentials = {
    async resolve() {
      credentialReads += 1;
      return { headers: { authorization: "Bearer s3cret" } };
    },
  };
  return {
    context: {
      serviceId: "files",
      baseUrl: "https://files.example.com",
      allowedHosts: ["files.example.com"],
      env: "dev",
      sleep: async () => {},
      rng: () => 0.5,
      transport,
      ledger: new InMemoryLedger(),
      credentials,
    },
    reads: () => credentialReads,
  };
}

describe("form-urlencoded bodies", () => {
  it("encodes fields with URLSearchParams semantics, arrays repeated", async () => {
    const transport = new MockTransport(() => ok({ ok: true }));
    const { context } = ctx(transport);
    const res = await execute(
      op({
        contentType: "application/x-www-form-urlencoded",
        projection: "fields",
        schema: {
          type: "object",
          properties: {
            email: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            count: { type: "integer" },
          },
        },
        fields: [
          { name: "email", required: true, schema: { type: "string" } },
          { name: "tags", required: false, schema: { type: "array", items: { type: "string" } } },
          { name: "count", required: false, schema: { type: "integer" } },
        ],
      }),
      { input: { email: "a b@x.io", tags: ["x", "y&z"], count: 3 } },
      context,
    );
    expect(res.outcome).toBe("success");
    const sent = transport.requests[0];
    expect(sent?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(sent?.body).toBe("email=a+b%40x.io&tags=x&tags=y%26z&count=3");
  });

  it("refuses a nested object before any credential is read", async () => {
    const transport = new MockTransport(() => ok({ ok: true }));
    const { context, reads } = ctx(transport);
    const res = await execute(
      op({ contentType: "application/x-www-form-urlencoded" }),
      { input: { body: { address: { city: "Oslo" } } } },
      context,
    );
    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") throw new Error("expected a refusal");
    expect(res.envelope.error.code).toBe("unsupported_operation");
    expect(res.envelope.error.message).toContain("address");
    expect(res.envelope.error.details).toMatchObject({ field: "address" });
    expect(transport.requests).toHaveLength(0);
    expect(reads()).toBe(0);
  });
});

describe("multipart bodies", () => {
  const upload = () =>
    op({
      contentType: "multipart/form-data",
      schema: {
        type: "object",
        properties: {
          file: { type: "string", format: "binary", contentMediaType: "application/pdf" },
          note: { type: "string" },
          pages: { type: "integer" },
          public: { type: "boolean" },
          meta: { type: "object" },
        },
      },
    });

  it("sends real multipart with a random boundary, text parts and a decoded file part", async () => {
    const transport = new MockTransport(() => ok({ id: "u1" }));
    const { context } = ctx(transport);
    const pdf = Buffer.from("%PDF-1.4\n\x00\x01binary\xff", "latin1");
    const res = await execute(
      upload(),
      {
        input: {
          body: { file: pdf.toString("base64"), note: "hi", pages: 2, public: true, meta: { k: "v" } },
        },
      },
      context,
    );
    expect(res.outcome).toBe("success");
    const sent = transport.requests[0];
    const contentType = sent?.headers["content-type"] ?? "";
    const boundary = contentType.match(/^multipart\/form-data; boundary=(\S+)$/)?.[1];
    expect(boundary).toBeDefined();
    expect(sent?.body).toBeInstanceOf(Uint8Array);
    const bytes = Buffer.from(sent?.body as Uint8Array);
    const text = bytes.toString("latin1");
    expect(text.startsWith(`--${boundary}\r\n`)).toBe(true);
    expect(text.endsWith(`\r\n--${boundary}--\r\n`)).toBe(true);
    expect(text).toContain(
      `Content-Disposition: form-data; name="file"; filename="file"\r\nContent-Type: application/pdf\r\n\r\n`,
    );
    // The file part carries the decoded bytes, not the base64 the agent supplied.
    expect(bytes.indexOf(pdf)).toBeGreaterThan(0);
    expect(text).not.toContain(pdf.toString("base64"));
    expect(text).toContain(`Content-Disposition: form-data; name="note"\r\n\r\nhi\r\n`);
    expect(text).toContain(`Content-Disposition: form-data; name="pages"\r\n\r\n2\r\n`);
    expect(text).toContain(`Content-Disposition: form-data; name="public"\r\n\r\ntrue\r\n`);
    expect(text).toContain(
      `Content-Disposition: form-data; name="meta"\r\nContent-Type: application/json\r\n\r\n{"k":"v"}\r\n`,
    );
    // The recorded request size is the multipart byte count, not a JSON length.
    expect(res.record.requestBytes).toBe(bytes.byteLength);
  });

  it("uses a fresh boundary per request", async () => {
    const transport = new MockTransport(() => ok({ id: "u1" }));
    const { context } = ctx(transport);
    for (let i = 0; i < 2; i += 1) {
      await execute(upload(), { input: { body: { note: "hi" } } }, context);
    }
    const boundaries = transport.requests.map((r) => r.headers["content-type"]);
    expect(boundaries[0]).not.toBe(boundaries[1]);
  });

  it("refuses a file field that is not base64 as a validation error, before credentials", async () => {
    const transport = new MockTransport(() => ok({ id: "u1" }));
    const { context, reads } = ctx(transport);
    const res = await execute(upload(), { input: { body: { file: "not base64!!" } } }, context);
    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") throw new Error("expected a refusal");
    expect(res.envelope.error.code).toBe("validation_error");
    expect(transport.requests).toHaveLength(0);
    expect(reads()).toBe(0);
  });

  it("previews a multipart body in a dry run as size and content type", async () => {
    const transport = new MockTransport(() => ok({ id: "u1" }));
    const { context } = ctx(transport);
    const res = await execute(upload(), { input: { body: { note: "hi" } }, dryRun: true }, context);
    expect(res.outcome).toBe("dry_run");
    if (res.outcome !== "dry_run") throw new Error("expected a plan");
    expect(res.plan.body).toMatchObject({ bytes: expect.any(Number) });
    expect((res.plan.body as { content_type: string }).content_type).toContain("multipart/form-data");
    expect(transport.requests).toHaveLength(0);
  });
});

describe("unencodable content types", () => {
  for (const contentType of ["application/octet-stream", "text/plain", "application/xml"]) {
    it(`refuses a ${contentType} body before any credential is read`, async () => {
      const transport = new MockTransport(() => ok({ ok: true }));
      const { context, reads } = ctx(transport);
      const res = await execute(op({ contentType }), { input: { body: { a: 1 } } }, context);
      expect(res.outcome).toBe("error");
      if (res.outcome !== "error") throw new Error("expected a refusal");
      expect(res.envelope.error.code).toBe("unsupported_operation");
      expect(res.envelope.error.message).toContain(contentType);
      expect(res.envelope.error.details).toMatchObject({ body_content_type: contentType });
      expect(transport.requests).toHaveLength(0);
      expect(reads()).toBe(0);
    });
  }

  it("still refuses under a dry run, which is a preview of a request that cannot exist", async () => {
    const transport = new MockTransport(() => ok({ ok: true }));
    const { context } = ctx(transport);
    const res = await execute(
      op({ contentType: "application/octet-stream" }),
      { input: { body: { a: 1 } }, dryRun: true },
      context,
    );
    expect(res.outcome).toBe("error");
  });

  it("keeps JSON bodies byte-identical, including +json vendor types", async () => {
    const transport = new MockTransport(() => ok({ ok: true }));
    const { context } = ctx(transport);
    const res = await execute(
      op({ contentType: "application/vnd.api+json" }),
      { input: { body: { a: [1, { b: "c" }] } } },
      context,
    );
    expect(res.outcome).toBe("success");
    expect(transport.requests[0]?.headers["content-type"]).toBe("application/vnd.api+json");
    expect(transport.requests[0]?.body).toBe('{"a":[1,{"b":"c"}]}');
  });
});
