import { once } from "node:events";
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONSOLE_ROUTES, type ConsoleRoute, zErrorEnvelope } from "../contract.js";
import { type Client, paymentsWorkspace, startServer, type Workspace } from "./fixture.js";
import { createConsoleServer } from "./index.js";

/**
 * The SECURITY block of contract.ts, one test per line. These are the only
 * defenses between a page in another tab and an approval, so each is asserted
 * from the outside — over a real socket, with the header deliberately wrong —
 * and the mutation gate (tools/mutation/mutants.json) deletes the token,
 * origin, and path-containment checks to prove these tests notice.
 */

let ws: Workspace;
let client: Client;
let server: Awaited<ReturnType<typeof startServer>>["server"];
let log: string[];

const APPROVE = "/api/bundles/payments/operations/approve";
const BODY = { ids: ["payments.nope"] };

beforeAll(async () => {
  ws = await paymentsWorkspace();
  const started = await startServer(ws.root);
  client = started.client;
  server = started.server;
  log = started.log;
});

afterAll(async () => {
  await server.close();
  rmSync(ws.root, { recursive: true, force: true });
});

function expectForbidden(reply: { status: number; json: unknown; headers: Headers }): void {
  expect(reply.status).toBe(403);
  expect(zErrorEnvelope.parse(reply.json).error.code).toBe("console/forbidden");
  expect(reply.headers.get("access-control-allow-origin")).toBeNull();
}

describe("1. bind 127.0.0.1 only", () => {
  it("refuses to construct on any other host", () => {
    for (const host of ["0.0.0.0", "localhost", "::", "192.168.0.1", ""]) {
      expect(() => createConsoleServer({ root: ws.root, host }), host).toThrow(/127\.0\.0\.1 only/);
    }
  });

  it("listens on 127.0.0.1 and names that origin", () => {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});

describe("2. the per-process token", () => {
  it("is 32 random bytes as hex, distinct per server", () => {
    expect(server.token).toMatch(/^[0-9a-f]{64}$/);
    const other = createConsoleServer({ root: ws.root });
    expect(other.token).not.toBe(server.token);
  });

  it("refuses a non-GET without the header, or with a wrong one", async () => {
    expectForbidden(await client.post(APPROVE, BODY, { token: null }));
    expectForbidden(await client.post(APPROVE, BODY, { token: "0".repeat(64) }));
    expectForbidden(await client.post(APPROVE, BODY, { token: server.token.slice(0, 63) }));
    expectForbidden(await client.post(APPROVE, BODY, { token: `${server.token}0` }));
  });

  it("refuses before the body is read: a 10 MiB body behind no token is never consumed", async () => {
    const TEN_MIB = 10 * 1024 * 1024;
    const socket = connect(server.port, "127.0.0.1");
    await once(socket, "connect");
    socket.write(
      `POST ${APPROVE} HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\n` +
        `Origin: ${server.url}\r\nContent-Type: application/json\r\n` +
        `Content-Length: ${TEN_MIB}\r\n\r\n`,
    );
    let written = 0;
    let response = "";
    socket.on("data", (chunk: Buffer) => {
      response += chunk.toString("utf8");
    });
    const chunk = Buffer.alloc(64 * 1024, 0x20);
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      socket.on("close", done);
      socket.on("error", done);
      const pump = (): void => {
        while (written < TEN_MIB && socket.writable && !socket.destroyed) {
          written += chunk.length;
          if (!socket.write(chunk)) {
            socket.once("drain", pump);
            return;
          }
        }
        if (written >= TEN_MIB) socket.end();
      };
      pump();
    });
    expect(response).toMatch(/^HTTP\/1\.1 403 /);
    expect(response.toLowerCase()).toContain("connection: close");
    expect(response).toContain('"console/forbidden"');
    // The server closed the connection without draining the body: far less
    // than the declared 10 MiB ever left the client (only what the kernel's
    // socket buffers absorbed).
    expect(written).toBeLessThan(TEN_MIB / 2);
  });
});

describe("3. same-origin only", () => {
  it("refuses a non-GET whose Origin is absent or not the server's own", async () => {
    expectForbidden(await client.post(APPROVE, BODY, { origin: null }));
    expectForbidden(await client.post(APPROVE, BODY, { origin: "http://evil.example" }));
    expectForbidden(
      await client.post(APPROVE, BODY, { origin: `http://localhost:${server.port}` }),
    );
    expectForbidden(await client.post(APPROVE, BODY, { origin: `${server.url}/` }));
    expectForbidden(await client.post(APPROVE, BODY, { origin: "null" }));
  });

  it("refuses a Sec-Fetch-Site other than same-origin/none even with a matching Origin", async () => {
    for (const site of ["cross-site", "same-site"]) {
      expectForbidden(await client.post(APPROVE, BODY, { headers: { "sec-fetch-site": site } }));
    }
    // With the token and origin right, same-origin/none reach the handler (a
    // refusal for the unknown id, not the gate's 403).
    for (const site of ["same-origin", "none"]) {
      const reply = await client.post(APPROVE, BODY, { headers: { "sec-fetch-site": site } });
      expect(reply.status, site).toBe(409);
    }
  });
});

describe("4. no CORS, ever", () => {
  it("answers a preflight with a refusal carrying no Access-Control header", async () => {
    const reply = await client.send("OPTIONS", APPROVE, undefined, {
      token: null,
      origin: "http://evil.example",
      headers: {
        "access-control-request-method": "POST",
        "access-control-request-headers": "x-anvil-console-token,content-type",
      },
    });
    expect(reply.status).toBe(403);
    for (const [name] of reply.headers) expect(name.toLowerCase()).not.toMatch(/^access-control-/);
  });

  it("emits no Access-Control header on any GET or mutation response", async () => {
    const get = await client.get("/api/workspace", { origin: "http://evil.example" });
    expect(get.status).toBe(200);
    for (const [name] of get.headers) expect(name.toLowerCase()).not.toMatch(/^access-control-/);
    const post = await client.post(APPROVE, BODY);
    for (const [name] of post.headers) expect(name.toLowerCase()).not.toMatch(/^access-control-/);
  });
});

describe("5. JSON bodies only, capped, validated", () => {
  it("refuses a non-JSON content type with 415", async () => {
    for (const contentType of ["text/plain", "application/x-www-form-urlencoded", null]) {
      const reply = await client.post(APPROVE, undefined, {
        raw: JSON.stringify(BODY),
        contentType,
      });
      expect(reply.status, String(contentType)).toBe(415);
      expect(zErrorEnvelope.parse(reply.json).error.code).toBe("console/unsupported_media_type");
    }
    const withCharset = await client.post(APPROVE, undefined, {
      raw: JSON.stringify(BODY),
      contentType: "application/json; charset=utf-8",
    });
    expect(withCharset.status).toBe(409);
  });

  it("refuses a body over 1 MiB with 413, declared or streamed", async () => {
    const big = JSON.stringify({ ids: ["x".repeat(2 * 1024 * 1024)] });
    const declared = await client.post(APPROVE, undefined, { raw: big });
    expect(declared.status).toBe(413);
    expect(zErrorEnvelope.parse(declared.json).error.code).toBe("console/payload_too_large");

    // Chunked transfer: no Content-Length to reject up front, so the cap must
    // hold while the body streams in.
    const socket = connect(server.port, "127.0.0.1");
    await once(socket, "connect");
    socket.write(
      `POST ${APPROVE} HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\n` +
        `Origin: ${server.url}\r\nX-Anvil-Console-Token: ${server.token}\r\n` +
        "Content-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n",
    );
    let response = "";
    socket.on("data", (chunk: Buffer) => {
      response += chunk.toString("utf8");
    });
    const piece = "x".repeat(64 * 1024);
    await new Promise<void>((resolve) => {
      socket.on("close", resolve);
      socket.on("error", resolve);
      let sent = 0;
      const pump = (): void => {
        while (sent < 3 * 1024 * 1024 && socket.writable && !socket.destroyed) {
          sent += piece.length;
          if (!socket.write(`${piece.length.toString(16)}\r\n${piece}\r\n`)) {
            socket.once("drain", pump);
            return;
          }
        }
      };
      pump();
    });
    expect(response).toMatch(/^HTTP\/1\.1 413 /);
  });

  it("refuses malformed JSON and a body that fails the route schema, before any library call", async () => {
    const malformed = await client.post(APPROVE, undefined, { raw: "{not json" });
    expect(malformed.status).toBe(400);
    expect(zErrorEnvelope.parse(malformed.json).error.code).toBe("console/invalid_json");

    const invalid = await client.post(APPROVE, { ids: [] });
    expect(invalid.status).toBe(400);
    const envelope = zErrorEnvelope.parse(invalid.json);
    expect(envelope.error.code).toBe("console/invalid_request");
    expect(envelope.error.issues?.length).toBeGreaterThan(0);

    const decision = await client.post(`/api/bundles/payments/packs/${"0".repeat(64)}/decisions`, {
      decision: "approve",
      refinementIds: ["r"],
      reviewer: "",
      reason: "",
    });
    expect(decision.status).toBe(400);
  });
});

describe("6. paths stay inside the workspace root", () => {
  it("refuses request-body paths that resolve outside the root", async () => {
    const outside = join(tmpdir(), "anvil-console-outside.json");
    for (const taskPath of ["../outside.json", "../../etc/passwd", outside, "/etc/passwd"]) {
      const reply = await client.post("/api/bundles/payments/tasks/import", {
        taskPath,
        submissionPath: "submission.json",
      });
      expect(reply.status, taskPath).toBe(400);
      expect(zErrorEnvelope.parse(reply.json).error.code).toBe("console/path_outside_root");
    }
    const outFile = await client.post("/api/bundles/payments/clusters/cc_x/export-task", {
      outFile: "../task.json",
    });
    expect(outFile.status).toBe(400);
    expect(zErrorEnvelope.parse(outFile.json).error.code).toBe("console/path_outside_root");
    const repo = await client.post("/api/bundles/payments/clusters/cc_x/export-task", {
      repositoryRoot: "..",
    });
    expect(zErrorEnvelope.parse(repo.json).error.code).toBe("console/path_outside_root");
  });

  it("follows symlinks when deciding what is inside", async () => {
    mkdirSync(join(ws.root, "links"), { recursive: true });
    symlinkSync(tmpdir(), join(ws.root, "links", "tmp"));
    const reply = await client.post("/api/bundles/payments/tasks/import", {
      taskPath: "links/tmp/anything.json",
      submissionPath: "submission.json",
    });
    expect(reply.status).toBe(400);
    expect(zErrorEnvelope.parse(reply.json).error.code).toBe("console/path_outside_root");
  });

  it("names a path inside the root that does not exist as a bad request, not an escape", async () => {
    const reply = await client.post("/api/bundles/payments/tasks/import", {
      taskPath: "absent/task.json",
      submissionPath: "absent/submission.json",
    });
    expect(reply.status).toBe(400);
    expect(zErrorEnvelope.parse(reply.json).error.code).toBe("console/invalid_request");
  });
});

describe("the token never leaks", () => {
  it("appears in no /api response and in no log line", async () => {
    const texts: string[] = [];
    for (const key of Object.keys(CONSOLE_ROUTES) as ConsoleRoute[]) {
      const path = CONSOLE_ROUTES[key].path
        .replace(":id", "payments")
        .replace(/:\w+/g, "x")
        .concat(key === "drift" ? "?against=payments" : "");
      const reply = CONSOLE_ROUTES[key].mutates
        ? await client.post(path, {})
        : await client.get(path);
      texts.push(reply.text);
      for (const [name, value] of reply.headers) texts.push(`${name}: ${value}`);
    }
    texts.push((await client.post(APPROVE, BODY, { token: null })).text);
    for (const text of texts) expect(text).not.toContain(server.token);
    expect(log.length).toBeGreaterThan(0);
    for (const line of log) {
      expect(line).not.toContain(server.token);
      expect(line).toMatch(/^(GET|POST|OPTIONS) \/\S* \d{3} \d+ms$/);
    }
  });
});
