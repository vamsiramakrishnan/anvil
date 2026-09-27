import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AirDocument } from "@anvil/air";
import { approveOperations, compile } from "@anvil/compiler";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { simulatorDefinitionFor } from "./define.js";
import { serveSimulatorHttp } from "./http.js";
import type { ProviderRequest, StateProvider } from "./provider.js";
import { Simulator } from "./runtime.js";
import { JsonlTrace, type TraceEntry, type TraceSink } from "./trace.js";

/**
 * The HTTP server's reading of a request: every body encoding the runtime can
 * put on the wire, cookie parameters, and a trace that can fail without
 * changing what the caller is served.
 */
const SPEC = `openapi: "3.0.3"
info: { title: Wire, version: "1.0.0" }
paths:
  /tokens:
    post:
      operationId: createToken
      requestBody:
        required: true
        content:
          application/x-www-form-urlencoded:
            schema:
              type: object
              required: [grant_type]
              properties:
                grant_type: { type: string }
                ttl: { type: integer }
                scope: { type: array, items: { type: string } }
      responses:
        "201": { description: created, content: { application/json: { schema: { type: object } } } }
  /uploads:
    post:
      operationId: uploadFile
      requestBody:
        required: true
        content:
          multipart/form-data:
            schema:
              type: object
              required: [file]
              properties:
                file: { type: string, format: binary }
                note: { type: string }
                copies: { type: integer }
      responses:
        "201": { description: created, content: { application/json: { schema: { type: object } } } }
  /notes:
    post:
      operationId: createNote
      requestBody:
        required: true
        content:
          application/json:
            schema: { type: object, required: [text], properties: { text: { type: string } } }
      responses:
        "201": { description: created, content: { application/json: { schema: { type: object } } } }
  /session:
    get:
      operationId: getSession
      parameters:
        - { name: session_id, in: cookie, required: true, schema: { type: string } }
        - { name: page, in: cookie, schema: { type: integer } }
      responses:
        "200": { description: ok, content: { application/json: { schema: { type: object } } } }
`;

let air: AirDocument;
let tmp: string;

beforeEach(async () => {
  const compiled = await compile({ spec: SPEC, serviceId: "wire" });
  air = approveOperations(
    compiled,
    compiled.operations.map((o) => o.id),
  );
  for (const op of air.operations) {
    // Keep the idempotency gate out of the way: these tests are about reading
    // the wire, not about the replay contract.
    op.idempotency = { mode: "none", mechanism: "none", keyDerivation: "none" };
    op.auth = { ...op.auth, type: "none", scopes: [] };
  }
  tmp = mkdtempSync(join(tmpdir(), "anvil-sim-http-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/** Echoes what it was asked, so a test reads exactly what the server lifted. */
const echoProvider = (): StateProvider & { seen: ProviderRequest[] } => {
  const seen: ProviderRequest[] = [];
  return {
    seen,
    invoke: (req) => {
      seen.push(req);
      const echo = { params: req.params, body: req.body };
      return req.page ? { ok: true, items: [echo], nextCursor: null } : { ok: true, result: echo };
    },
  };
};

async function serving(
  options: { trace?: TraceSink; onTraceError?: (m: string) => void } = {},
): Promise<{ url: string; provider: ReturnType<typeof echoProvider>; close(): Promise<void> }> {
  const provider = echoProvider();
  const sim = new Simulator(air, simulatorDefinitionFor(air), { provider });
  const http = await serveSimulatorHttp(sim, air, options);
  return { url: http.url, provider, close: () => http.close() };
}

describe("request bodies are read in the content type the operation declares", () => {
  it("decodes a form body, typing each field by its schema", async () => {
    const s = await serving();
    try {
      const form = new URLSearchParams();
      form.append("grant_type", "client_credentials");
      form.append("ttl", "3600");
      form.append("scope", "read");
      form.append("scope", "write,admin");
      const res = await fetch(`${s.url}/tokens`, { method: "POST", body: form });
      expect(res.status).toBe(201);
      expect(s.provider.seen[0]?.body).toEqual({
        grant_type: "client_credentials",
        ttl: 3600,
        // A form repeats its key for an array; a comma is part of a value.
        scope: ["read", "write,admin"],
      });
    } finally {
      await s.close();
    }
  });

  it("decodes multipart, handing a file part back as the base64 an agent supplies", async () => {
    const s = await serving();
    try {
      const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x0d, 0x0a]);
      const form = new FormData();
      form.append("file", new Blob([bytes], { type: "application/pdf" }), "report.pdf");
      form.append("note", "quarterly");
      form.append("copies", "2");
      const res = await fetch(`${s.url}/uploads`, { method: "POST", body: form });
      expect(res.status).toBe(201);
      expect(s.provider.seen[0]?.body).toEqual({
        file: bytes.toString("base64"),
        note: "quarterly",
        copies: 2,
      });
    } finally {
      await s.close();
    }
  });

  it("refuses a multipart body with no boundary, and invalid JSON, as validation errors", async () => {
    const s = await serving();
    try {
      const noBoundary = await fetch(`${s.url}/uploads`, {
        method: "POST",
        headers: { "content-type": "multipart/form-data" },
        body: "--x\r\n\r\n--x--",
      });
      expect(noBoundary.status).toBe(400);
      expect(await noBoundary.json()).toMatchObject({ error: { code: "validation_error" } });
      const badJson = await fetch(`${s.url}/notes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      });
      expect(badJson.status).toBe(400);
      expect(s.provider.seen).toHaveLength(0);
    } finally {
      await s.close();
    }
  });

  it("still reads JSON, and never refuses a body on a path no operation serves", async () => {
    const s = await serving();
    try {
      const ok = await fetch(`${s.url}/notes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hi" }),
      });
      expect(ok.status).toBe(201);
      expect(s.provider.seen[0]?.body).toEqual({ text: "hi" });
      const nowhere = await fetch(`${s.url}/nowhere`, { method: "POST", body: "a=1&b=2" });
      expect(nowhere.status).toBe(404);
    } finally {
      await s.close();
    }
  });
});

describe("cookie parameters", () => {
  it("lifts declared cookies, so a required one is not reported missing", async () => {
    const s = await serving();
    try {
      const res = await fetch(`${s.url}/session`, {
        headers: { cookie: 'tracking=abc; session_id="s-42"; page=3' },
      });
      expect(res.status).toBe(200);
      expect(s.provider.seen[0]?.params).toEqual({
        path: {},
        query: {},
        header: {},
        cookie: { session_id: "s-42", page: 3 },
      });
      const missing = await fetch(`${s.url}/session`);
      expect(missing.status).toBe(400);
      expect(await missing.json()).toMatchObject({
        error: { code: "validation_error", message: "Missing required parameter 'session_id'." },
      });
    } finally {
      await s.close();
    }
  });
});

describe("the call trace never changes a call's outcome", () => {
  it("refuses an unwritable trace path when the sink is opened, not on the first call", () => {
    expect(() => new JsonlTrace(join(tmp, "no-such-dir", "trace.jsonl"))).toThrow(
      /Cannot write the call trace to '.*no-such-dir.*'/,
    );
  });

  it("serves the real response when a trace write fails, and reports the failure", async () => {
    const reported: string[] = [];
    const failing: TraceSink = {
      write: () => {
        throw new Error("disk full");
      },
    };
    const s = await serving({ trace: failing, onTraceError: (m) => reported.push(m) });
    try {
      const res = await fetch(`${s.url}/notes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "kept" }),
      });
      // The mutation happened; the caller is told so, not handed a 500.
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({
        params: { path: {}, query: {}, header: {}, cookie: {} },
        body: { text: "kept" },
      });
      expect(res.headers.get("x-anvil-trace-error")).toMatch(
        /trace write failed for r1: disk full/,
      );
      expect(reported).toEqual([expect.stringMatching(/trace write failed for r1: disk full/)]);
      expect(s.provider.seen).toHaveLength(1);
    } finally {
      await s.close();
    }
  });

  it("carries no trace-error header when the trace is written", async () => {
    const tracePath = join(tmp, "trace.jsonl");
    const s = await serving({ trace: new JsonlTrace(tracePath) });
    try {
      const res = await fetch(`${s.url}/session`, { headers: { cookie: "session_id=s-1" } });
      expect(res.headers.get("x-anvil-trace-error")).toBeNull();
    } finally {
      await s.close();
    }
    const [entry] = readFileSync(tracePath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as TraceEntry);
    expect(entry?.normalized?.params.cookie).toEqual({ session_id: "s-1" });
  });

  it("keeps an in-process call's result when its trace write fails", async () => {
    const reported: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      reported.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const sim = new Simulator(air, simulatorDefinitionFor(air), {
        provider: echoProvider(),
        trace: {
          write: () => {
            throw new Error("gone");
          },
        },
      });
      const tool = air.operations.find((o) => o.sourceRef.operationId === "createNote")?.mcp
        .toolName as string;
      const result = await sim.invokeAsync(tool, { text: "x" }, { confirm: true });
      expect(result).toMatchObject({ ok: true, output: { body: { text: "x" } } });
    } finally {
      process.stderr.write = original;
    }
    expect(reported.join("")).toMatch(/trace write failed for r1: gone/);
  });
});
