import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBundleDir } from "@anvil/generators";
import {
  packFiles,
  readBenchmarkReport,
  readPackDir,
  readPackReceipts,
  refinementPackHash,
  runRefinements,
} from "@anvil/refinement";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONSOLE_ROUTES, type ConsoleRoute, zErrorEnvelope } from "../contract.js";
import {
  type Client,
  loadAir,
  paymentsWorkspace,
  startServer,
  type Workspace,
  writeBenchmarkReport,
} from "./fixture.js";
import { createConsoleServer } from "./index.js";

/**
 * The server against the contract, over the real payments bundle: every route
 * in `CONSOLE_ROUTES` is registered (a request to it is never the unknown-
 * route 404), every GET parses against its response schema and writes nothing,
 * and every mutation returns what the library function returned — parsed
 * against the contract — with the decision visible on disk afterwards.
 */

let ws: Workspace;
let client: Client;
let close: () => Promise<void>;
let packDir: string;
let packHash: string;

/** A recursive `path -> size:mtime` snapshot, so "GET wrote nothing" is a comparison. */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const stat = statSync(full);
        out.set(full, `${stat.size}:${stat.mtimeMs}`);
      }
    }
  };
  walk(dir);
  return out;
}

beforeAll(async () => {
  ws = await paymentsWorkspace();
  await writeBenchmarkReport(ws.bundleDir);
  // A second, nested bundle so ids with a slash are exercised end to end.
  cpSync(ws.bundleDir, join(ws.root, "gen", "payments-next"), { recursive: true });
  // A refinement pack for the service, where `anvil refine run --out` would put one.
  packDir = join(ws.root, "packs", "first");
  mkdirSync(packDir, { recursive: true });
  const pack = await runRefinements(ws.air, { safeOnly: false });
  for (const [name, contents] of Object.entries(packFiles(pack))) {
    writeFileSync(join(packDir, name), contents, "utf8");
  }
  packHash = refinementPackHash(readPackDir(packDir));
  const started = await startServer(ws.root);
  client = started.client;
  close = () => started.server.close();
});

afterAll(async () => {
  await close();
  rmSync(ws.root, { recursive: true, force: true });
});

/** Substitute the params every route path declares with values the fixture has. */
function pathFor(route: ConsoleRoute, params: Record<string, string>): string {
  return CONSOLE_ROUTES[route].path.replace(/:(\w+)/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`no fixture value for :${name}`);
    return encodeURIComponent(value);
  });
}

describe("every route in the contract is registered", () => {
  it("answers each route with something other than the unknown-route 404", async () => {
    const params = { id: ws.bundleId, capId: "x", hash: "0".repeat(64), clusterId: "cc_none" };
    for (const key of Object.keys(CONSOLE_ROUTES) as ConsoleRoute[]) {
      const route = CONSOLE_ROUTES[key];
      const path = pathFor(key, params) + (key === "drift" ? `?against=${ws.bundleId}` : "");
      // An invalid body proves the route is dispatched without letting it act;
      // routes whose bodies are all optional are dispatched against a missing
      // capability, pack, or cluster instead, which the handler — not the
      // router — refuses.
      const reply = route.mutates
        ? await client.post(path, { ids: "not-an-array" })
        : await client.get(path);
      expect(reply.status, `${key}: ${reply.text}`).not.toBe(500);
      if (reply.status === 404) {
        const envelope = zErrorEnvelope.parse(reply.json);
        expect(envelope.error.message, key).not.toMatch(/^No route /);
      }
    }
  });

  it("returns the error envelope for an unknown route", async () => {
    const reply = await client.get("/api/nothing/here");
    expect(reply.status).toBe(404);
    expect(zErrorEnvelope.parse(reply.json).error.code).toBe("console/not_found");
    expect(reply.text).not.toMatch(/\n\s+at /);
  });
});

describe("GET routes are pure projections", () => {
  it("parse against their schemas and write nothing anywhere in the workspace", async () => {
    const before = snapshot(ws.root);
    const params = { id: ws.bundleId };
    for (const key of ["workspace", "bundle", "queue", "packs", "benchmark", "drift"] as const) {
      const path = pathFor(key, params) + (key === "drift" ? "?against=gen%2Fpayments-next" : "");
      const reply = await client.get(path);
      expect(reply.status, `${key}: ${reply.text}`).toBe(200);
      expect(() => CONSOLE_ROUTES[key].response.parse(reply.json)).not.toThrow();
      expect(reply.headers.get("access-control-allow-origin")).toBeNull();
    }
    expect(snapshot(ws.root)).toEqual(before);
    // The scratch directory a mutation may create is never created by a read.
    expect(existsSync(join(ws.root, ".anvil", "console"))).toBe(false);
    expect(existsSync(join(ws.root, ".anvil"))).toBe(false);
  });

  it("discovers both bundles, the nested one by its relative path", async () => {
    const reply = await client.get("/api/workspace");
    const view = CONSOLE_ROUTES.workspace.response.parse(reply.json);
    expect(view.root).toBe(ws.root);
    expect(view.bundles.map((b) => b.id)).toEqual(["gen/payments-next", "payments"]);
    const payments = view.bundles.find((b) => b.id === "payments");
    expect(payments?.hasBenchmark).toBe(true);
    expect(payments?.packs).toBe(1);
    // Compiled without a manifest: decisions are pending, nothing is approved yet.
    expect(payments?.counts.operations.review_required).toBeGreaterThan(0);
    expect(payments?.counts.operations.approved).toBeUndefined();
    expect(payments?.counts.capabilities.proposed).toBe(ws.air.capabilities.length);
  });

  it("projects the inspector, the queue, the packs, and the benchmark from disk", async () => {
    const bundle = CONSOLE_ROUTES.bundle.response.parse(
      (await client.get("/api/bundles/gen%2Fpayments-next")).json,
    );
    expect(bundle.id).toBe("gen/payments-next");
    expect(bundle.operations.length).toBe(ws.air.operations.length);
    expect(bundle.capabilities.every((cap) => cap.budget.verdict === "ok")).toBe(true);
    // Only approved operations are served; none is approved yet, so nothing is.
    expect(bundle.servedSurface).toEqual({ before: [], after: [] });

    const queue = CONSOLE_ROUTES.queue.response.parse(
      (await client.get("/api/bundles/payments/queue")).json,
    );
    // Every item carries the subject its decision needs, read off the same
    // files the inspector, the pack list, and the benchmark project.
    const operations = queue.items.filter((item) => item.kind === "operation");
    expect(operations.map((item) => item.id).sort()).toEqual(
      ws.air.operations
        .filter((op) => op.state !== "approved")
        .map((op) => op.id)
        .sort(),
    );
    for (const item of operations) {
      const op = bundle.operations.find((row) => row.id === item.id);
      expect(item.subject.operationId).toBe(item.id);
      expect(item.subject.effect).toEqual(op?.effect);
      expect(item.subject.idempotency).toEqual(op?.idempotency);
      expect(item.subject.confirmation).toEqual(op?.confirmation);
      expect(["none", "safe", "unsafe"]).toContain(item.subject.retries.mode);
    }
    const nonIdempotent = operations.filter(
      (item) => item.subject.effect.kind === "mutation" && item.subject.idempotency.mode === "none",
    );
    expect(nonIdempotent.length).toBeGreaterThan(0);
    for (const item of nonIdempotent) expect(item.subject.retries.mode).toBe("none");
    const capabilities = queue.items.filter((item) => item.kind === "capability");
    expect(capabilities.map((item) => item.id).sort()).toEqual(
      ws.air.capabilities.map((cap) => cap.id).sort(),
    );
    for (const item of capabilities) {
      expect(item.subject.budget).toEqual(
        bundle.capabilities.find((cap) => cap.id === item.id)?.budget,
      );
    }
    for (const item of queue.items) {
      if (item.kind === "refinement") {
        expect(item.id.endsWith(`:${item.subject.deficiencyId}`)).toBe(true);
        expect(item.subject.deficiencyId).toMatch(
          /^(operation|field|enum|error|capability|service)/,
        );
      }
    }
    // The payments pack holds only auto-approved refinements: none awaits a
    // receipt, so none is a decision (admission.test.ts projects a real one).
    expect(queue.items.filter((item) => item.kind === "pack")).toEqual([]);
    expect(queue.items.filter((item) => item.kind === "cluster").map((item) => item.id)).toEqual(
      readBenchmarkReport(ws.bundleDir)?.confusion.clusters.map((cluster) => cluster.id),
    );

    const packs = CONSOLE_ROUTES.packs.response.parse(
      (await client.get("/api/bundles/payments/packs")).json,
    );
    expect(packs.map((p) => p.hash)).toEqual([packHash]);
    expect(packs[0]?.receipts).toEqual([]);
    expect(packs[0]?.items.every((item) => item.receiptPaths.length === 0)).toBe(true);

    const benchmark = CONSOLE_ROUTES.benchmark.response.parse(
      (await client.get("/api/bundles/payments/benchmark")).json,
    );
    expect(benchmark?.fresh).toBe(true);
    expect(benchmark?.bundleHash).toBe(readBenchmarkReport(ws.bundleDir)?.bundleHash);
  });

  it("refuses drift without ?against= and an unknown bundle with the envelope", async () => {
    const missing = await client.get("/api/bundles/payments/drift");
    expect(missing.status).toBe(400);
    const envelope = zErrorEnvelope.parse(missing.json);
    expect(envelope.error.code).toBe("console/invalid_request");
    expect(envelope.error.issues?.join(" ")).toContain("against");

    const unknown = await client.get("/api/bundles/nope");
    expect(unknown.status).toBe(404);
    expect(zErrorEnvelope.parse(unknown.json).error.code).toBe("console/not_found");

    const badEncoding = await client.get("/api/bundles/%E0%A4%A");
    expect(badEncoding.status).toBe(404);
  });
});

describe("mutations call the lifted library functions and report their result", () => {
  it("approves an operation and re-projects the bundle atomically", async () => {
    const pending = ws.air.operations.find((op) => op.state === "review_required");
    if (!pending) throw new Error("payments fixture has no review_required operation");
    const reply = await client.post("/api/bundles/payments/operations/approve", {
      ids: [pending.id],
    });
    expect(reply.status, reply.text).toBe(200);
    const view = CONSOLE_ROUTES.approveOperations.response.parse(reply.json);
    expect(view.approved).toEqual([pending.id]);
    expect(view.alreadyApproved).toEqual([]);
    expect(view.reprojection.projectionsChanged).toBe(true);
    expect(view.reprojection.stale.records).toContain("benchmark.report.json");
    expect(view.refusals).toEqual([]);
    const after = loadAir(ws.bundleDir);
    expect(after.operations.find((op) => op.id === pending.id)?.state).toBe("approved");
    // The projections moved with the AIR: the MCP surface now serves the tool.
    expect(readBundleDir(ws.bundleDir)["mcp/air.json"]).toContain(pending.mcp.toolName);
    // Re-approving reports it as already approved, refusing nothing.
    const again = await client.post("/api/bundles/payments/operations/approve", {
      ids: [pending.id],
    });
    expect(CONSOLE_ROUTES.approveOperations.response.parse(again.json).alreadyApproved).toEqual([
      pending.id,
    ]);
  });

  it("refuses an unknown operation id with the library's message, writing nothing", async () => {
    const before = snapshot(ws.bundleDir);
    const reply = await client.post("/api/bundles/payments/operations/approve", {
      ids: ["payments.nope"],
    });
    expect(reply.status).toBe(409);
    const envelope = zErrorEnvelope.parse(reply.json);
    expect(envelope.error.code).toBe("console/refused");
    expect(envelope.error.message).toContain("Unknown operation id(s): payments.nope");
    expect(snapshot(ws.bundleDir)).toEqual(before);
  });

  it("approves and rejects capabilities through the compiler's review gate", async () => {
    const proposed = ws.air.capabilities.filter((cap) => cap.lifecycle === "proposed");
    const [toApprove, toReject] = [proposed[0], proposed[1] ?? ws.air.capabilities[0]];
    if (!toApprove || !toReject) throw new Error("payments fixture has no capabilities");

    const approved = await client.post(
      `/api/bundles/payments/capabilities/${encodeURIComponent(toApprove.id)}/approve`,
      { note: "reviewed in the console" },
    );
    expect(approved.status, approved.text).toBe(200);
    const view = CONSOLE_ROUTES.approveCapability.response.parse(approved.json);
    expect(view.capabilityId).toBe(toApprove.id);
    expect(view.budget.verdict).toBe("ok");
    expect(loadAir(ws.bundleDir).capabilities.find((c) => c.id === toApprove.id)?.lifecycle).toBe(
      "approved",
    );

    const rejected = await client.post(
      `/api/bundles/payments/capabilities/${encodeURIComponent(toReject.id)}/reject`,
      { reason: "not a task boundary" },
    );
    expect(rejected.status, rejected.text).toBe(200);
    CONSOLE_ROUTES.rejectCapability.response.parse(rejected.json);
    expect(loadAir(ws.bundleDir).capabilities.find((c) => c.id === toReject.id)?.lifecycle).toBe(
      "rejected",
    );

    const missing = await client.post("/api/bundles/payments/capabilities/nope/approve", {});
    expect(missing.status).toBe(404);
    expect(zErrorEnvelope.parse(missing.json).error.code).toBe("capability_not_found");
  });

  it("refuses a decision on an auto-tier refinement, as the receipt binding does", async () => {
    // The payments pack holds only auto-approved refinements; a receipt is for
    // review-tier ones (admission.test.ts records and applies a real one).
    const auto = readPackDir(packDir).refinements[0];
    if (!auto) throw new Error("payments pack is empty");
    const reply = await client.post(`/api/bundles/payments/packs/${packHash}/decisions`, {
      decision: "approve",
      refinementIds: [auto.id],
      reviewer: "reviewer@example.test",
      reason: "evidence is sound",
    });
    expect(reply.status).toBe(409);
    expect(zErrorEnvelope.parse(reply.json).error.message).toContain("not awaiting human review");
    expect(readPackReceipts(packDir)).toEqual([]);

    const unknownPack = await client.post(
      `/api/bundles/payments/packs/${"f".repeat(64)}/apply`,
      {},
    );
    expect(unknownPack.status).toBe(404);
    expect(zErrorEnvelope.parse(unknownPack.json).error.code).toBe("console/not_found");
  });

  it("refuses an export for a cluster the benchmark did not measure", async () => {
    const reply = await client.post("/api/bundles/payments/clusters/cc_nowhere/export-task", {});
    expect(reply.status).toBe(409);
    const envelope = zErrorEnvelope.parse(reply.json);
    expect(envelope.error.code).toBe("console/refused");
    expect(envelope.error.message).toContain("No confusion cluster 'cc_nowhere'");
  });
});

describe("the served page", () => {
  it("injects the token into a built UI, serves its files, and refuses traversal", async () => {
    const uiDir = join(tmpdir(), `anvil-console-ui-${process.pid}-${Date.now()}`);
    mkdirSync(join(uiDir, "assets"), { recursive: true });
    writeFileSync(
      join(uiDir, "index.html"),
      "<!doctype html><html><head></head><body>ui</body></html>",
    );
    writeFileSync(join(uiDir, "assets", "app.js"), "console.log('ui');");
    const server = await createConsoleServer({ root: ws.root, uiDir, log: () => {} }).listen();
    try {
      const page = await fetch(server.url);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");
      expect(await page.text()).toContain(
        `<head><meta name="anvil-console-token" content="${server.token}">`,
      );
      const asset = await fetch(`${server.url}/assets/app.js`);
      expect(asset.status).toBe(200);
      expect(asset.headers.get("content-type")).toContain("text/javascript");
      expect(await asset.text()).toBe("console.log('ui');");
      for (const path of [
        "/../fixture.ts",
        "/assets/../../index.ts",
        "/%2e%2e/%2e%2e/etc/passwd",
        "/assets/%2e%2e/%2e%2e/etc/passwd",
        "/missing.js",
        "/assets/",
      ]) {
        const reply = await fetch(`${server.url}${path}`);
        expect(reply.status, path).toBe(404);
        expect(await reply.text()).not.toContain(server.token);
      }
    } finally {
      await server.close();
      rmSync(uiDir, { recursive: true, force: true });
    }
  });

  it("says the UI is not built, and lists the API, when there is no dist/ui", async () => {
    const server = await createConsoleServer({
      root: ws.root,
      uiDir: join(tmpdir(), "anvil-console-absent-ui"),
      log: () => {},
    }).listen();
    try {
      const page = await fetch(server.url);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain("not built");
      for (const route of Object.values(CONSOLE_ROUTES)) {
        expect(html).toContain(`${route.method} ${route.path}`);
      }
      expect(html).toContain(`content="${server.token}"`);
    } finally {
      await server.close();
    }
  });
});
