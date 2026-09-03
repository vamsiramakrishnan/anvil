import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TLSSocket } from "node:tls";
import { fileURLToPath } from "node:url";
import { type AirDocument, Operation as OperationSchema } from "@anvil/air";
import { compile } from "@anvil/compiler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateSdks } from "./sdk/index.js";

/**
 * Run the driver script and collect its stdout.
 *
 * Not `execFileSync`: the mTLS server this file drives against runs in this
 * same process, and `execFileSync` blocks the calling event loop until the
 * child exits — so a synchronous wait here would starve the very server the
 * child is trying to reach, and every call would time out (the same trap
 * `sdk-compile.test.ts` documents for its own fake upstream).
 */
function runDriver(
  scriptRelativePath: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptRelativePath, ...args], { cwd: work, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`driver exited ${code}: ${stderr}`));
    });
  });
}

/**
 * A runtime-level smoke test for the TypeScript SDK's mTLS transport, against
 * a real local `node:https` server presenting mutual-TLS.
 *
 * Every other mTLS test in `sdk.test.ts` reads generated text; this is the one
 * place a client certificate actually reaches a TLS handshake, so it is the
 * test that would catch a `node:https` option mis-wired against a real
 * server — a class of bug string assertions cannot see.
 */

const fixturesDir = fileURLToPath(new URL("../../../examples/payments/", import.meta.url));
const read = (rel: string) => readFileSync(join(fixturesDir, rel), "utf8");

const tlsDir = fileURLToPath(new URL("../test-fixtures/tls/", import.meta.url));
const readTls = (rel: string) => readFileSync(join(tlsDir, rel), "utf8");

const TYPESCRIPT_TSC = createRequire(import.meta.url).resolve("typescript/bin/tsc");
// The generated package intentionally carries no node_modules of its own — a
// temp dir has none to resolve @types/node from, so the workspace root's is
// pointed at explicitly. The generated package.json still lists the real
// devDependency; this only stands in for `npm install` inside the test.
const TYPE_ROOTS = fileURLToPath(new URL("../../../node_modules/@types", import.meta.url));

let work: string;
let baseUrl: string;
let server: ReturnType<typeof createServer>;
let sawClientCert = false;

beforeAll(async () => {
  const air = await compile({
    spec: read("openapi.yaml"),
    manifest: read("anvil.yaml"),
    serviceId: "payments",
  });
  const mtlsAuth = withMtlsAuth(air);
  work = mkdtempSync(join(tmpdir(), "anvil-sdk-mtls-smoke-"));
  for (const [rel, contents] of Object.entries(generateSdks(mtlsAuth))) {
    const full = join(work, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents, "utf8");
  }
  execFileSync(
    process.execPath,
    [TYPESCRIPT_TSC, "-p", "tsconfig.json", "--typeRoots", TYPE_ROOTS],
    {
      cwd: join(work, "sdk/typescript"),
      encoding: "utf8",
      timeout: 180_000,
    },
  );

  server = createServer(
    {
      cert: readTls("server-cert.pem"),
      key: readTls("server-key.pem"),
      ca: readTls("ca-cert.pem"),
      requestCert: true,
      rejectUnauthorized: true,
    },
    (req, res) => {
      const peer = (req.socket as TLSSocket).getPeerCertificate();
      sawClientCert = Boolean(peer?.subject?.CN === "anvil-sdk-client");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "cust_1" }));
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  baseUrl = `https://127.0.0.1:${port}`;
}, 180_000);

afterAll(() => {
  server?.close();
  rmSync(work, { recursive: true, force: true });
});

/** The read operation the payments fixture already declares, re-typed to mtls. */
function withMtlsAuth(document: AirDocument): AirDocument {
  const target = document.operations.find((op) => op.id === "payments.customers.get");
  if (!target) throw new Error("fixture no longer has payments.customers.get");
  const retyped = OperationSchema.parse({
    ...target,
    auth: {
      type: "mtls",
      scopes: [],
      principal: "service",
      secretSource: "env",
      tls: {
        clientCertRef: "PAYMENTS_MTLS_CLIENT_CERT",
        clientKeyRef: "PAYMENTS_MTLS_CLIENT_KEY",
        caRef: "PAYMENTS_MTLS_CA",
      },
    },
  });
  return {
    ...document,
    operations: document.operations.map((op) => (op.id === target.id ? retyped : op)),
  };
}

describe("the TypeScript SDK's mTLS transport, against a real node:https server", () => {
  it("presents the client certificate on the handshake and completes the call", async () => {
    writeFileSync(
      join(work, "sdk/typescript/drive.mjs"),
      `import { PaymentsClient } from "./dist/index.js";
const client = new PaymentsClient({ baseUrl: process.argv[2] });
const result = await client.getCustomer({ customer_id: "c1" });
console.log(JSON.stringify(result));
`,
      "utf8",
    );
    const output = await runDriver("sdk/typescript/drive.mjs", [baseUrl], {
      ...process.env,
      PAYMENTS_MTLS_CLIENT_CERT: join(tlsDir, "client-cert.pem"),
      PAYMENTS_MTLS_CLIENT_KEY: join(tlsDir, "client-key.pem"),
      PAYMENTS_MTLS_CA: join(tlsDir, "ca-cert.pem"),
    });
    expect(JSON.parse(output.trim())).toEqual({ id: "cust_1" });
    expect(sawClientCert).toBe(true);
  }, 30_000);

  it("reads PEM content directly from the environment too, not only a file path", async () => {
    writeFileSync(
      join(work, "sdk/typescript/drive-literal.mjs"),
      `import { PaymentsClient } from "./dist/index.js";
const client = new PaymentsClient({ baseUrl: process.argv[2] });
const result = await client.getCustomer({ customer_id: "c1" });
console.log(JSON.stringify(result));
`,
      "utf8",
    );
    const output = await runDriver("sdk/typescript/drive-literal.mjs", [baseUrl], {
      ...process.env,
      PAYMENTS_MTLS_CLIENT_CERT: readTls("client-cert.pem"),
      PAYMENTS_MTLS_CLIENT_KEY: readTls("client-key.pem"),
      PAYMENTS_MTLS_CA: readTls("ca-cert.pem"),
    });
    expect(JSON.parse(output.trim())).toEqual({ id: "cust_1" });
  }, 30_000);

  it("without cert/key material falls back to the platform fetch, which fails closed against this untrusted test server rather than hanging or crashing", async () => {
    writeFileSync(
      join(work, "sdk/typescript/drive-no-cert.mjs"),
      `import { PaymentsClient } from "./dist/index.js";
const client = new PaymentsClient({ baseUrl: process.argv[2] });
try {
  await client.getCustomer({ customer_id: "c1" });
  console.log("NOT REFUSED");
} catch (error) {
  console.log("refused:" + error.code);
}
`,
      "utf8",
    );
    const output = await runDriver("sdk/typescript/drive-no-cert.mjs", [baseUrl], {
      ...process.env,
      PAYMENTS_MTLS_CLIENT_CERT: "",
      PAYMENTS_MTLS_CLIENT_KEY: "",
    });
    expect(output).toContain("refused:upstream_unavailable");
  }, 30_000);
});
