import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { airFromYaml, airToYaml, loadAirDocument } from "@anvil/air";
import { type ConsoleServer, createConsoleServer } from "@anvil/console";
import { readBundleDir } from "@anvil/generators";
import { readPackDir } from "@anvil/refinement";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAnvilCli } from "../anvil-cli.js";
import { bufferIO } from "../io.js";

/**
 * `anvil console` as a launcher, and the parity that makes the console a
 * pure projection: a decision made through the server and the same decision
 * made through the CLI, on two copies of one bundle, leave byte-identical
 * files behind — the AIR, every regenerated projection, and the receipts.
 */

const examples = fileURLToPath(new URL("../../../../examples/payments/", import.meta.url));
const roots: string[] = [];
const servers: ConsoleServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});

async function anvil(...argv: string[]) {
  const io = bufferIO();
  const code = await runAnvilCli(argv, { io });
  return { code, io };
}

/** A workspace holding one compiled payments bundle at `<root>/bundle`, with decisions pending. */
async function workspace(): Promise<{ root: string; bundle: string }> {
  const root = mkdtempSync(join(tmpdir(), "anvil-console-cli-"));
  roots.push(root);
  const bundle = join(root, "bundle");
  const io = bufferIO();
  const code = await runAnvilCli(
    [
      "compile",
      join(examples, "openapi.yaml"),
      "--service",
      "payments",
      "--out",
      bundle,
      "--root",
      join(root, "sources"),
    ],
    { io },
  );
  expect(code, io.text()).toBe(0);
  return { root, bundle };
}

function read(overrides: Record<string, unknown>) {
  return {
    idempotency: { mode: "natural" },
    retries: { mode: "safe" },
    confirmation: { required: false },
    auth: { type: "api_key" },
    errors: [],
    evidence: { claims: [] },
    state: "approved",
    ...overrides,
  };
}

/**
 * The views estate from refine-group.test.ts, as a workspace: the one fixture
 * whose refinement pack lands at the review tier (group proposals always do),
 * so a receipt-bound decision has something to decide. Built entirely through
 * the CLI: benchmark → export-task → import-proposal → a pack at `<root>/pack`.
 */
async function reviewablePackWorkspace(): Promise<{ root: string; refinementId: string }> {
  const root = mkdtempSync(join(tmpdir(), "anvil-console-cli-pack-"));
  roots.push(root);
  const bundle = join(root, "bundle");
  mkdirSync(bundle, { recursive: true });
  const operation = (id: string, name: string, path: string, intents: string[]) =>
    read({
      id: `svc.views.${id}`,
      canonicalName: `${name}_view`,
      displayName: `${name} view`,
      description: `${name} a view.`,
      sourceRef: { kind: "openapi", path, method: "get", operationId: `${name}View` },
      effect: { kind: "read", action: id === "list" ? "list" : "get", resource: "view" },
      input: {
        params:
          id === "list" ? [] : [{ name: "view_id", in: "path", required: true, example: "v1" }],
      },
      output: {
        schema:
          id === "list"
            ? {
                type: "array",
                items: { type: "object", properties: { view_id: { type: "string" } } },
              }
            : { type: "object", properties: { rows: { type: "array" } } },
      },
      cli: { command: `svc views ${id}` },
      mcp: { toolName: `svc_${name}_view` },
      skill: { intentExamples: intents },
    });
  const air = loadAirDocument({
    service: { id: "svc", displayName: "Service", version: "1", source: { kind: "openapi" } },
    operations: [
      operation("list", "list", "/views", [
        "show all views",
        "execute the view list",
        "count the views available",
        "execute the whole view list",
        "count the views for me",
      ]),
      operation("execute", "execute", "/views/{view_id}/execute", [
        "execute the view",
        "list the view rows",
        "count rows the view returns",
        "count rows in the view result",
      ]),
      operation("count", "count", "/views/{view_id}/count", [
        "count tickets in the view",
        "execute a count of the view",
      ]),
    ],
  });
  writeFileSync(join(bundle, "air.yaml"), airToYaml(air));
  for (const args of [
    ["init", "-q"],
    ["config", "user.email", "anvil@example.test"],
    ["config", "user.name", "Anvil Test"],
    ["add", "."],
    ["commit", "-qm", "fixture"],
  ]) {
    execFileSync("git", args, { cwd: root });
  }

  const bench = await anvil("benchmark", bundle);
  expect(bench.code, bench.io.text()).toBe(0);
  const report = JSON.parse(readFileSync(join(bundle, "benchmark.report.json"), "utf8")) as {
    confusion: { clusters: Array<{ id: string }> };
  };
  const cluster = report.confusion.clusters[0];
  if (!cluster) throw new Error("the views estate produced no confusion cluster");
  const taskPath = join(root, "task.json");
  const exported = await anvil(
    "refine",
    "export-task",
    bundle,
    `group:${cluster.id}`,
    "--repo-root",
    root,
    "--out",
    taskPath,
  );
  expect(exported.code, exported.io.text()).toBe(0);
  const task = JSON.parse(readFileSync(taskPath, "utf8")) as { taskId: string; taskHash: string };
  const payload = {
    name: "list_and_execute_view",
    description: "List views, then execute the chosen view and count its rows.",
    intent_examples: ["execute a view from the list"],
    steps: [
      { operation: "svc.views.list" },
      { operation: "svc.views.execute", bindings: { view_id: "$.output.view_id" } },
    ],
    supersedes: ["svc.views.execute", "svc.views.list"],
  };
  const submissionPath = join(root, "submission.json");
  writeFileSync(
    submissionPath,
    JSON.stringify({
      schemaVersion: 1,
      taskId: task.taskId,
      taskHash: task.taskHash,
      executor: { name: "claude-code", version: "1" },
      status: "proposal_generated",
      summary: "Docs describe list-then-execute as one user task.",
      evidence: [{ id: "doc", kind: "repository", source: "doc_example", path: "bundle/air.yaml" }],
      claims: [{ predicate: "group.workflow", value: payload, evidenceId: "doc" }],
      patch: { set: { workflow: payload } },
    }),
  );
  const imported = await anvil(
    "refine",
    "import-proposal",
    bundle,
    taskPath,
    submissionPath,
    "--repo-root",
    root,
    "--out",
    join(root, "pack"),
  );
  expect(imported.code, imported.io.text()).toBe(0);
  const refinementId = readPackDir(join(root, "pack")).refinements[0]?.id;
  if (!refinementId) throw new Error("the imported pack carries no refinement");
  return { root, refinementId };
}

/** Launch `anvil console` in-process and hand back the running server. */
async function launch(...argv: string[]) {
  const io = bufferIO();
  let server: ConsoleServer | undefined;
  const code = await runAnvilCli(["console", ...argv], {
    io,
    onConsoleServer: (running) => {
      server = running;
      servers.push(running);
    },
  });
  return { code, io, server };
}

async function post(server: ConsoleServer, path: string, body: unknown) {
  const response = await fetch(`${server.url}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: server.url,
      "x-anvil-console-token": server.token,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

describe("anvil console", () => {
  it("documents its arguments and sits in the review step of root help", async () => {
    const help = await anvil("console", "--help");
    expect(help.code).toBe(0);
    for (const text of ["[path]", "--port <n>", "--open", "--json", "127.0.0.1"]) {
      expect(help.io.text()).toContain(text);
    }
    const root = await anvil("--help");
    const lines = root.io.text().split("\n");
    const at = (name: string) => lines.findIndex((line) => line.startsWith(`  ${name} `));
    expect(at("console")).toBe(at("approve") + 1);
    expect(at("console")).toBeLessThan(at("lint"));
  });

  it("serves the workspace on 127.0.0.1, prints the URL without the token, and answers the API", async () => {
    const { root } = await workspace();
    const { code, io, server } = await launch(root);
    expect(code, io.text()).toBe(0);
    if (!server) throw new Error("the command did not hand back its server");
    expect(io.stdout.join("\n")).toContain(server.url);
    expect(io.text()).not.toContain(server.token);
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const reply = await fetch(`${server.url}/api/workspace`);
    expect(reply.status).toBe(200);
    const view = (await reply.json()) as { root: string; bundles: Array<{ id: string }> };
    expect(view.root).toBe(root);
    expect(view.bundles.map((b) => b.id)).toEqual(["bundle"]);
    // The request was logged as method, path, status, and duration only.
    expect(io.stderr.some((line) => /^GET \/api\/workspace 200 \d+ms$/.test(line))).toBe(true);
  });

  it("--json prints one document naming its shape, then keeps serving", async () => {
    const { root } = await workspace();
    const { code, io, server } = await launch(root, "--json");
    expect(code).toBe(0);
    if (!server) throw new Error("the command did not hand back its server");
    const document = JSON.parse(io.stdout.join("\n")) as Record<string, unknown>;
    expect(document).toEqual({
      schemaVersion: 1,
      reportType: "anvil.console",
      url: server.url,
      port: server.port,
      root,
    });
    expect(JSON.stringify(document)).not.toContain(server.token);
    expect((await fetch(`${server.url}/api/workspace`)).status).toBe(200);
  });

  it("honours --port and refuses a port that is taken, a bad port, and a missing root", async () => {
    const { root } = await workspace();
    const taken = createServer();
    await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve));
    const address = taken.address();
    const port = address && typeof address === "object" ? address.port : 0;
    try {
      const busy = await launch(root, "--port", String(port), "--json");
      expect(busy.code).toBe(1);
      expect(JSON.parse(busy.io.stdout.join("\n"))).toMatchObject({
        reportType: "anvil.console-error",
        code: "console/listen_failed",
      });
    } finally {
      taken.close();
    }
    const bad = await launch(root, "--port", "abc");
    expect(bad.code).toBe(1);
    expect(bad.io.stderr.join("\n")).toContain("[console/invalid_port]");
    const missing = await launch(join(root, "absent"));
    expect(missing.code).toBe(1);
    expect(missing.io.stderr.join("\n")).toContain("[console/root_not_found]");

    const chosen = await launch(root, "--port", "0");
    expect(chosen.code).toBe(0);
    expect(chosen.server?.port).toBeGreaterThan(0);
  });
});

describe("mutation parity: the server and the CLI leave byte-identical files", () => {
  async function twoCopies() {
    const a = await workspace();
    const b = { root: mkdtempSync(join(tmpdir(), "anvil-console-cli-")), bundle: "" };
    roots.push(b.root);
    b.bundle = join(b.root, "bundle");
    cpSync(a.bundle, b.bundle, { recursive: true });
    expect(readBundleDir(b.bundle)).toEqual(readBundleDir(a.bundle));
    const server = await createConsoleServer({ root: a.root, log: () => {} }).listen();
    servers.push(server);
    return { a, b, server };
  }

  it("approving an operation", async () => {
    const { a, b, server } = await twoCopies();
    const air = airFromYaml(readFileSync(join(a.bundle, "air.yaml"), "utf8"));
    const pending = air.operations.find((op) => op.state === "review_required")?.id;
    if (!pending) throw new Error("payments fixture has no review_required operation");

    const viaServer = await post(server, "/api/bundles/bundle/operations/approve", {
      ids: [pending],
    });
    expect(viaServer.status, viaServer.text).toBe(200);
    const viaCli = await anvil("approve", b.bundle, pending);
    expect(viaCli.code, viaCli.io.text()).toBe(0);

    const filesA = readBundleDir(a.bundle);
    const filesB = readBundleDir(b.bundle);
    expect(filesA["air.yaml"]).toBe(filesB["air.yaml"]);
    expect(filesA["air.yaml"]).toContain(pending);
    expect(filesA).toEqual(filesB);
  });

  it("approving a capability", async () => {
    const { a, b, server } = await twoCopies();
    const air = airFromYaml(readFileSync(join(a.bundle, "air.yaml"), "utf8"));
    const proposed = air.capabilities.find((cap) => cap.lifecycle === "proposed")?.id;
    if (!proposed) throw new Error("payments fixture has no proposed capability");

    const viaServer = await post(
      server,
      `/api/bundles/bundle/capabilities/${encodeURIComponent(proposed)}/approve`,
      { note: "a reviewed unit of work" },
    );
    expect(viaServer.status, viaServer.text).toBe(200);
    const viaCli = await anvil(
      "capability",
      "approve",
      b.bundle,
      proposed,
      "--note",
      "a reviewed unit of work",
    );
    expect(viaCli.code, viaCli.io.text()).toBe(0);

    const filesA = readBundleDir(a.bundle);
    expect(filesA["air.yaml"]).toBe(readBundleDir(b.bundle)["air.yaml"]);
    expect(filesA["air.yaml"]).toContain("a reviewed unit of work");
    expect(filesA).toEqual(readBundleDir(b.bundle));
  });

  it("recording a pack decision", async () => {
    const a = await reviewablePackWorkspace();
    const b = mkdtempSync(join(tmpdir(), "anvil-console-cli-pack-"));
    roots.push(b);
    cpSync(join(a.root, "pack"), join(b, "pack"), { recursive: true });
    const server = await createConsoleServer({ root: a.root, log: () => {} }).listen();
    servers.push(server);
    const packs = (await (await fetch(`${server.url}/api/bundles/bundle/packs`)).json()) as Array<{
      hash: string;
    }>;
    const hash = packs[0]?.hash;
    if (!hash) throw new Error("the server did not discover the pack");

    // A receipt records when it was made; both decisions are made at one instant.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-02T12:00:00Z"));
    const viaServer = await post(server, `/api/bundles/bundle/packs/${hash}/decisions`, {
      decision: "approve",
      refinementIds: [a.refinementId],
      reviewer: "reviewer@example.test",
      reason: "the evidence holds",
    });
    expect(viaServer.status, viaServer.text).toBe(200);
    const viaCli = await anvil(
      "refine",
      "approve",
      join(b, "pack"),
      a.refinementId,
      "--reviewer",
      "reviewer@example.test",
      "--reason",
      "the evidence holds",
    );
    expect(viaCli.code, viaCli.io.text()).toBe(0);

    const receiptsA = readBundleDir(join(a.root, "pack", "receipts"));
    const receiptsB = readBundleDir(join(b, "pack", "receipts"));
    expect(Object.keys(receiptsA)).toHaveLength(1);
    expect(receiptsA).toEqual(receiptsB);
    expect(readBundleDir(join(a.root, "pack"))).toEqual(readBundleDir(join(b, "pack")));
  });
});
