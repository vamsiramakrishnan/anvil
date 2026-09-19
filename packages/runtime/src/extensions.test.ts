import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Operation as OperationSchema } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { bootRuntime } from "./boot.js";
import { loadRuntimeConfig } from "./config.js";
import { execute } from "./executor.js";
import {
  composePolicyHooks,
  extensionSpecifiersFromConfig,
  loadRuntimeExtensions,
  parseExtensionSpecifiers,
  resolveExtensionSpecifier,
  runtimeExtensionApi,
} from "./extensions.js";
import type { ExecutionRecord } from "./observability.js";
import { MockTransport } from "./transport.js";

const config = loadRuntimeConfig({ ANVIL_ENV: "dev" });
const api = runtimeExtensionApi(config);

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "anvil-ext-"));
}

function writeModule(dir: string, name: string, source: string): string {
  const path = join(dir, name);
  writeFileSync(path, source);
  return path;
}

describe("specifier parsing", () => {
  it("splits on commas and semicolons, trims, and dedupes", () => {
    expect(parseExtensionSpecifiers(" ./a.mjs, ./b.mjs ;./a.mjs,,")).toEqual([
      "./a.mjs",
      "./b.mjs",
    ]);
    expect(parseExtensionSpecifiers(undefined)).toEqual([]);
  });

  it("appends ANVIL_POLICY_BUNDLE after ANVIL_EXTENSIONS without duplicating it", () => {
    expect(
      extensionSpecifiersFromConfig({ extensions: "./a.mjs,./p.mjs", policyBundle: "./p.mjs" }),
    ).toEqual(["./a.mjs", "./p.mjs"]);
    expect(extensionSpecifiersFromConfig({ policyBundle: "./p.mjs" })).toEqual(["./p.mjs"]);
  });

  it("treats paths and extensions as files, bare names as packages", () => {
    expect(resolveExtensionSpecifier("./x.mjs", "/cwd").path).toBe("/cwd/x.mjs");
    expect(resolveExtensionSpecifier("/abs/x.mjs", "/cwd").path).toBe("/abs/x.mjs");
    expect(resolveExtensionSpecifier("x.mjs", "/cwd").path).toBe("/cwd/x.mjs");
    expect(resolveExtensionSpecifier("@acme/anvil-policy", "/cwd").path).toBeUndefined();
    expect(resolveExtensionSpecifier("@acme/anvil-policy", "/cwd").url).toBe("@acme/anvil-policy");
  });
});

describe("loading", () => {
  it("returns the empty result for no specifiers", async () => {
    const ext = await loadRuntimeExtensions([], api);
    expect(ext.loaded).toEqual([]);
    expect(ext.policy).toBeUndefined();
  });

  it("loads an object-form module and records its identity", async () => {
    const dir = tmp();
    const path = writeModule(
      dir,
      "audit.mjs",
      `export default { name: "audit", observer: { onRecord() {} } };`,
    );
    const ext = await loadRuntimeExtensions([path], api);
    expect(ext.loaded).toHaveLength(1);
    expect(ext.loaded[0]?.name).toBe("audit");
    expect(ext.loaded[0]?.contributes).toEqual(["observer"]);
    expect(ext.loaded[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ext.observers).toHaveLength(1);
  });

  it("calls a factory with the api and registers the backends it returns", async () => {
    const dir = tmp();
    const path = writeModule(
      dir,
      "backends.mjs",
      `export default (api) => ({
        name: "backends",
        ledgers: { memtest: () => new api.InMemoryLedger() },
        credentials: { vaultish: () => ({ resolve: async () => null }) },
      });`,
    );
    const ledgers: string[] = [];
    const creds: string[] = [];
    const ext = await loadRuntimeExtensions([path], api, {
      registerLedger: (scheme) => void ledgers.push(scheme),
      registerCredential: (key) => void creds.push(key),
    });
    expect(ledgers).toEqual(["memtest"]);
    expect(creds).toEqual(["vaultish"]);
    expect(ext.loaded[0]?.ledgerSchemes).toEqual(["memtest"]);
    expect(ext.loaded[0]?.credentialBackends).toEqual(["vaultish"]);
  });

  it("refuses to replace a built-in backend", async () => {
    const dir = tmp();
    const ledger = writeModule(
      dir,
      "bad-ledger.mjs",
      `export default { name: "x", ledgers: { firestore: () => ({}) } };`,
    );
    await expect(
      loadRuntimeExtensions([ledger], api, { registerLedger: () => {} }),
    ).rejects.toThrow(/may not replace the built-in 'firestore'/);
    const cred = writeModule(
      dir,
      "bad-cred.mjs",
      `export default { name: "y", credentials: { env: () => ({}) } };`,
    );
    await expect(
      loadRuntimeExtensions([cred], api, { registerCredential: () => {} }),
    ).rejects.toThrow(/may not replace the built-in 'env'/);
  });

  it("fails closed on a missing module, a malformed shape, and a duplicate name", async () => {
    const dir = tmp();
    await expect(loadRuntimeExtensions([join(dir, "nope.mjs")], api)).rejects.toThrow(
      /cannot be read/,
    );
    const noName = writeModule(dir, "noname.mjs", "export default { policy: {} };");
    await expect(loadRuntimeExtensions([noName], api)).rejects.toThrow(/non-empty `name`/);
    const badPhase = writeModule(
      dir,
      "badphase.mjs",
      `export default { name: "b", policy: { beforeCall() {} } };`,
    );
    await expect(loadRuntimeExtensions([badPhase], api)).rejects.toThrow(/not a hook phase/);
    const notFn = writeModule(
      dir,
      "notfn.mjs",
      `export default { name: "c", policy: { preExecute: 42 } };`,
    );
    await expect(loadRuntimeExtensions([notFn], api)).rejects.toThrow(/must be a function/);
    const a = writeModule(dir, "a.mjs", `export default { name: "same" };`);
    const b = writeModule(dir, "b.mjs", `export default { name: "same" };`);
    await expect(loadRuntimeExtensions([a, b], api)).rejects.toThrow(/duplicates extension name/);
    const throws = writeModule(
      dir,
      "throws.mjs",
      `export default () => { throw new Error("boom"); };`,
    );
    await expect(loadRuntimeExtensions([throws], api)).rejects.toThrow(/factory threw: boom/);
  });

  it("chains hooks in load order and wraps the transport in load order", async () => {
    const dir = tmp();
    const first = writeModule(
      dir,
      "first.mjs",
      `export default { name: "first", policy: { preExecute: (ctx) => ctx.decide("first") },
        transport: (base) => ({ send: (req) => base.send({ ...req, headers: { ...req.headers, "x-first": "1" } }) }) };`,
    );
    const second = writeModule(
      dir,
      "second.mjs",
      `export default { name: "second", policy: { preExecute: (ctx) => ctx.decide("second") },
        transport: (base) => ({ send: (req) => base.send({ ...req, headers: { ...req.headers, "x-second": "1" } }) }) };`,
    );
    const ext = await loadRuntimeExtensions([first, second], api);
    const decisions: string[] = [];
    await ext.policy?.preExecute?.({
      operation: {} as never,
      input: {},
      traceId: "t",
      decide: (d) => decisions.push(d),
    });
    expect(decisions).toEqual(["first", "second"]);
    const seen: Record<string, string>[] = [];
    const transport = ext.wrapTransport({
      send: async (req) => {
        seen.push(req.headers);
        return { status: 200, headers: {}, body: "" };
      },
    });
    await transport.send({ method: "GET", url: "https://x", headers: {} });
    expect(seen[0]).toEqual({ "x-first": "1", "x-second": "1" });
  });

  it("composes only the phases some contributor provided", () => {
    const composed = composePolicyHooks([{ preAuth: () => {} }, { postError: () => {} }]);
    expect(Object.keys(composed ?? {}).sort()).toEqual(["postError", "preAuth"]);
    expect(composePolicyHooks([{}, {}])).toBeUndefined();
  });
});

const readOp = OperationSchema.parse({
  id: "widgets.list",
  canonicalName: "list_widgets",
  displayName: "List widgets",
  sourceRef: { kind: "openapi", path: "/widgets", method: "get" },
  effect: { kind: "read", resource: "widget", risk: "none", reversible: true },
  input: { params: [] },
  idempotency: { mode: "natural", mechanism: "none" },
  retries: { mode: "safe", maxAttempts: 2, backoff: "exponential_jitter", retryOn: ["http_503"] },
  confirmation: { required: false, risk: "none" },
  auth: { type: "none", scopes: [] },
  cli: { command: "widgets list" },
  mcp: { toolName: "widgets_list" },
  skill: { intentExamples: [] },
  state: "approved",
});

describe("bootRuntime", () => {
  it("wires an extension's policy hooks and observer into the execute context", async () => {
    const dir = tmp();
    const path = writeModule(
      dir,
      "deny.mjs",
      `let records = [];
       export default (api) => ({
         name: "deny-after-hours",
         policy: {
           preExecute(ctx) {
             ctx.decide("hours:checked");
             if (ctx.input.after_hours === true) api.denyPolicy(ctx, "closed for the night");
           },
         },
         observer: { onRecord(r) { records.push(r); globalThis.__anvilExtRecords = records; } },
       });`,
    );
    const env = { ANVIL_ENV: "dev", ANVIL_EXTENSIONS: path };
    const boot = await bootRuntime(loadRuntimeConfig(env), {
      env,
      serviceId: "widgets",
      transport: new MockTransport(() => ({
        status: 200,
        headers: {},
        body: JSON.stringify({ ok: true }),
      })),
      log: () => {},
    });
    expect(boot.extensions.loaded.map((e) => e.name)).toEqual(["deny-after-hours"]);
    expect(boot.policy?.preExecute).toBeTypeOf("function");
    const ctx = {
      ...boot.contextDeps,
      serviceId: "widgets",
      baseUrl: "https://api.example.com",
      env: "dev",
      allowedHosts: [],
    };
    const ok = await execute(readOp, { input: {} }, ctx);
    expect(ok.outcome).toBe("success");
    expect(ok.record.policyDecisions).toContain("hours:checked");
    const denied = await execute(readOp, { input: { after_hours: true } }, ctx);
    expect(denied.outcome).toBe("error");
    if (denied.outcome === "error") expect(denied.envelope.error.code).toBe("policy_denied");
    const records = (globalThis as { __anvilExtRecords?: ExecutionRecord[] }).__anvilExtRecords;
    expect(records?.map((r) => r.outcome)).toEqual(["success", "error"]);
    expect(boot.metrics.count).toBe(2);
    expect(boot.metrics.render()).toContain(
      'anvil_policy_denied_total{operation="widgets.list"} 1',
    );
  });

  it("boots byte-identically without extensions: no policy, memory exporter, one observer", async () => {
    const env = { ANVIL_ENV: "dev" };
    const boot = await bootRuntime(loadRuntimeConfig(env), {
      env,
      serviceId: "widgets",
      log: () => {},
    });
    expect(boot.extensions.loaded).toEqual([]);
    expect(boot.policy).toBeUndefined();
    expect(boot.contextDeps.policy).toBeUndefined();
    expect(boot.exporter).toBe("memory");
  });

  it("loads extensions before the ledger is selected, so an extension's scheme is usable", async () => {
    const dir = tmp();
    const path = writeModule(
      dir,
      "ledger.mjs",
      `export default (api) => ({
         name: "custom-ledger",
         ledgers: { customtest: (uri) => Object.assign(new api.InMemoryLedger(), { uri }) },
       });`,
    );
    const env = {
      ANVIL_ENV: "dev",
      ANVIL_EXTENSIONS: path,
      ANVIL_LEDGER: "customtest://ns",
    };
    const boot = await bootRuntime(loadRuntimeConfig(env), {
      env,
      serviceId: "widgets",
      log: () => {},
    });
    expect((boot.ledger as { uri?: string }).uri).toBe("customtest://ns");
    expect(boot.extensions.loaded[0]?.ledgerSchemes).toEqual(["customtest"]);
  });

  it("refuses to boot when a configured extension is missing", async () => {
    const env = { ANVIL_ENV: "dev", ANVIL_POLICY_BUNDLE: "/definitely/not/here.mjs" };
    await expect(
      bootRuntime(loadRuntimeConfig(env), { env, serviceId: "widgets", log: () => {} }),
    ).rejects.toThrow(/Refusing to serve/);
  });
});
