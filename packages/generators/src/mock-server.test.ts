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

interface TokenExchangeView {
  grantType: string;
  subjectTokenPresent: boolean;
  subjectTokenType: string | null;
  requestedTokenType: string | null;
  audience: string | null;
  resource: string | null;
  scopes: string[];
  actorTokenPresent: boolean;
  clientAuth: string;
}

const evidence = async (): Promise<{
  requests: CaptureView[];
  tokenExchanges: TokenExchangeView[];
}> => {
  const res = await fetch(`${base}/__anvil/capture`);
  return (await res.json()) as {
    requests: CaptureView[];
    tokenExchanges: TokenExchangeView[];
  };
};

const capture = async (): Promise<CaptureView[]> => {
  return (await evidence()).requests;
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

  it("mints hermetic OAuth tokens without polluting operation captures", async () => {
    await reset();
    const res = await fetch(`${base}/__anvil/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        scope: "payments.read",
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      access_token: "anvil-hermetic-upstream-token",
      token_type: "Bearer",
    });
    expect(await capture()).toEqual([]);
  });

  it("records only redacted OBO exchange metadata", async () => {
    await reset();
    const subjectToken = "header.private-subject.signature";
    const clientSecret = "private-client-secret";
    const res = await fetch(`${base}/__anvil/oauth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(`client:${clientSecret}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: subjectToken,
        subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
        requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
        audience: "api://payments",
        scope: "payments.read payments.write",
      }),
    });
    expect(res.status).toBe(200);
    const recorded = await evidence();
    expect(recorded.requests).toEqual([]);
    expect(recorded.tokenExchanges).toEqual([
      {
        grantType: "urn:ietf:params:oauth:grant-type:token-exchange",
        subjectTokenPresent: true,
        subjectTokenType: "urn:ietf:params:oauth:token-type:jwt",
        requestedTokenType: "urn:ietf:params:oauth:token-type:access_token",
        audience: "api://payments",
        resource: null,
        scopes: ["payments.read", "payments.write"],
        actorTokenPresent: false,
        clientAuth: "client_secret_basic",
      },
    ]);
    const serialized = JSON.stringify(recorded);
    expect(serialized).not.toContain(subjectToken);
    expect(serialized).not.toContain(clientSecret);
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

/**
 * Twilio-style templates embed the param inside a segment with a literal
 * suffix ("/Calls/{sid}.json") and Jira's addWatcher takes a bare JSON string
 * body. The matcher and validator must handle both without special-casing.
 */
describe("generated mock server (embedded path params + non-object bodies)", () => {
  const spec = `openapi: 3.0.0
info: { title: comms, version: 1.0.0 }
paths:
  /v1/calls/{sid}.json:
    get:
      operationId: fetchCall
      parameters:
        - { name: sid, in: path, required: true, schema: { type: string } }
      responses:
        "200": { description: ok }
  /v1/calls/latest.json:
    get:
      operationId: fetchLatestCall
      responses:
        "200": { description: ok }
  /v1/issues/{key}/watchers:
    post:
      operationId: addWatcher
      parameters:
        - { name: key, in: path, required: true, schema: { type: string } }
      requestBody:
        required: true
        content:
          application/json:
            schema: { type: string, description: account id }
      responses:
        "200": { description: ok }
`;
  const manifest = `service: { name: comms }
operations:
  fetchCall: { state: approved }
  fetchLatestCall: { state: approved }
  addWatcher: { state: approved }
`;

  let commsDir: string;
  let commsChild: ChildProcess;
  let commsBase: string;
  /** Derived operation id for a path template, read from the emitted table. */
  const opIdFor = (path: string): string => {
    const routes = JSON.parse(readFileSync(join(commsDir, "mock", "routes.json"), "utf8")) as {
      operationId: string;
      path: string;
    }[];
    const route = routes.find((r) => r.path === path);
    if (!route) throw new Error(`no route for ${path}`);
    return route.operationId;
  };
  const commsCapture = async (): Promise<CaptureView[]> => {
    const res = await fetch(`${commsBase}/__anvil/capture`);
    return ((await res.json()) as { requests: CaptureView[] }).requests;
  };
  const commsReset = () => fetch(`${commsBase}/__anvil/reset`, { method: "POST" });

  beforeAll(async () => {
    const commsAir = await compile({ spec, manifest, serviceId: "comms" });
    commsDir = mkdtempSync(join(tmpdir(), "anvil-mock-embedded-test-"));
    writeBundle(commsDir, generateBundle(commsAir));
    const started = await startMock(commsDir);
    commsChild = started.child;
    commsBase = `http://127.0.0.1:${started.port}`;
  }, 60_000);

  afterAll(() => {
    commsChild?.kill("SIGKILL");
    rmSync(commsDir, { recursive: true, force: true });
  });

  it("matches a param embedded inside a segment with a literal suffix", async () => {
    await commsReset();
    const res = await fetch(`${commsBase}/v1/calls/CA123.json`);
    expect(res.status).toBe(200);
    const [req] = await commsCapture();
    expect(req.matchedOpId).toBe(opIdFor("/v1/calls/{sid}.json"));
    expect(req.pathParams).toEqual({ sid: "CA123" });
  });

  it("percent-decodes the segment before matching literals and params", async () => {
    await commsReset();
    const res = await fetch(`${commsBase}/v1/calls/CA%20123.json`);
    expect(res.status).toBe(200);
    const [req] = await commsCapture();
    expect(req.pathParams).toEqual({ sid: "CA 123" });
  });

  it("routes ambiguity most-literal-first, deterministically", async () => {
    await commsReset();
    // /v1/calls/latest.json matches BOTH the literal route and {sid}.json —
    // the fully-literal template must win regardless of table order.
    await fetch(`${commsBase}/v1/calls/latest.json`);
    const [req] = await commsCapture();
    const literal = opIdFor("/v1/calls/latest.json");
    const embedded = opIdFor("/v1/calls/{sid}.json");
    expect(req.matchedOpId).toBe(literal);
    expect(req.matchedCandidates.sort()).toEqual([embedded, literal].sort());
  });

  it("accepts a bare JSON string body when the contract's body type is string", async () => {
    await commsReset();
    const res = await fetch(`${commsBase}/v1/issues/PROJ-1/watchers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify("account-id"),
    });
    expect(res.status).toBe(201); // the mutation's success scenario
  });

  it("still rejects a body whose JSON type contradicts the contract", async () => {
    const res = await fetch(`${commsBase}/v1/issues/PROJ-1/watchers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ not: "a string" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { invalid: string[] } };
    expect(body.error.invalid.join(" ")).toMatch(/expected a JSON string/);
  });
});
