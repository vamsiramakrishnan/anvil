import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAnvilCli } from "../anvil-cli.js";
import { bufferIO } from "../io.js";

/**
 * `anvil connectors compose` (ADR-0031): the composite SDK over several
 * packaged connectors, and its flows. The Python runtime runs here against
 * the github-mini mock upstream; the gateway path is in
 * examples/github-mini/e2e.mjs.
 */

const examples = fileURLToPath(new URL("../../../../examples/", import.meta.url));
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const PYTHON = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
let work = "";
let ws = "";
let home = "";
let mock: {
  url: string;
  close(): Promise<void>;
  requests: Array<{ method: string; path: string }>;
};

/** Async, so the in-process mock upstream keeps answering while Python runs. */
function python(
  script: string,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("python3", ["-c", script], { env: { PATH: process.env.PATH ?? "" } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function anvil(args: string[]) {
  const io = bufferIO();
  const code = await runAnvilCli(args, { io });
  return { code, io };
}

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "anvil-compose-"));
  ws = join(work, "ws");
  home = join(work, "home");
  const { startMockUpstream } = await import(join(examples, "github-mini", "mock-upstream.mjs"));
  mock = await startMockUpstream({ token: "e2e-upstream-pat" });
  // `github` and `mirror` are two connectors built from one service: the
  // composite must keep their identically named packages apart.
  for (const [connector, name] of [
    ["github", "github-mini"],
    ["mirror", "github-mini"],
    ["payments", "payments"],
  ] as const) {
    const compiled = await anvil([
      "compile",
      join(examples, name, "openapi.yaml"),
      "--manifest",
      join(examples, name, "anvil.yaml"),
      "--out",
      join(ws, connector),
    ]);
    if (compiled.code !== 0) throw new Error(compiled.io.text());
    const packaged = await anvil([
      "package",
      "harness",
      join(ws, connector),
      "--out",
      join(home, connector),
      "--workspace",
      ws,
    ]);
    if (packaged.code !== 0) throw new Error(packaged.io.text());
  }
}, 180_000);
afterAll(async () => {
  await mock?.close();
  rmSync(work, { recursive: true, force: true });
});

describe("anvil connectors compose", () => {
  it("writes the composite beside the packaged connectors", async () => {
    const out = join(home, "_compose");
    const bundles = ["github", "mirror", "payments"].map((c) => join(ws, c));
    const { code, io } = await anvil([
      "connectors",
      "compose",
      ...bundles,
      "--workspace",
      ws,
      "--out",
      out,
    ]);
    expect(code, io.text()).toBe(0);
    for (const rel of [
      "SKILL.md",
      "compose.json",
      "python/anvil_compose/__init__.py",
      "python/anvil_compose/__main__.py",
      "python/anvil_compose/catalog.json",
      "typescript/src/flow.ts",
      "typescript/src/clients.ts",
      "typescript/src/catalog.ts",
    ]) {
      expect(existsSync(join(out, rel)), rel).toBe(true);
    }
    const catalog = JSON.parse(readFileSync(join(out, "compose.json"), "utf8"));
    expect(catalog.schema).toBe("anvil.compose-catalog/v1");
    expect(catalog.connectors.map((c: { id: string }) => c.id)).toEqual([
      "github",
      "mirror",
      "payments",
    ]);
    const github = catalog.connectors[0];
    expect(github.python).toEqual({
      path: "../github/python",
      package: "anvil_github",
      client: "GithubClient",
    });
    expect(github.typescript.import).toBe("../../../github/typescript/src/index.js");
    const comment = github.operations.find(
      (op: { id: string }) => op.id === "github.comments.create",
    );
    expect(comment).toMatchObject({
      method: { python: "create_comment", typescript: "createComment" },
      effectClass: "reversible",
      undo: { kind: "inverse", operation: "github.comments.delete" },
    });
    expect(comment.undo.arguments.comment_id).toBe("response.id");
    expect(readFileSync(join(out, "SKILL.md"), "utf8")).toContain("name: compose");
  });

  it("refuses a connector that has not been packaged", async () => {
    const { code, io } = await anvil([
      "connectors",
      "compose",
      join(ws, "github"),
      "--out",
      join(work, "elsewhere", "_compose"),
    ]);
    expect(code).toBe(1);
    expect(io.text()).toContain("is not a harness package");
  });

  it("refuses to replace a directory that is not a composite", async () => {
    const out = join(work, "occupied");
    cpSync(join(home, "github", "SKILL.md"), join(out, "SKILL.md"), { recursive: true });
    const { code, io } = await anvil([
      "connectors",
      "compose",
      join(ws, "github"),
      "--workspace",
      ws,
      "--skills-root",
      home,
      "--out",
      out,
    ]);
    expect(code).toBe(1);
    expect(io.text()).toContain("refusing to replace");
  });

  it("points INDEX.md at the composite when several connectors are granted", async () => {
    const grants = join(work, "grants.json");
    writeFileSync(
      grants,
      JSON.stringify([
        { connector: "github", operations: ["*"], mode: "write" },
        { connector: "payments", operations: ["*"], mode: "read" },
      ]),
    );
    const index = join(home, "INDEX.md");
    const bundles = ["github", "payments"].map((c) => join(ws, c));
    const { code, io } = await anvil([
      "connectors",
      "index",
      "--grants",
      grants,
      "--workspace",
      ws,
      "--out",
      index,
      ...bundles,
    ]);
    expect(code, io.text()).toBe(0);
    expect(io.text()).toContain("2 granted connector(s), with the composite");
    expect(readFileSync(index, "utf8")).toContain("`_compose/SKILL.md`");
  });

  it.runIf(existsSync(tsc))(
    "emits TypeScript that typechecks against the connector SDKs",
    () => {
      const result = spawnSync(
        tsc,
        ["-p", join(home, "_compose", "typescript", "tsconfig.json"), "--noEmit"],
        {
          encoding: "utf8",
        },
      );
      expect(result.status, result.stdout + result.stderr).toBe(0);
    },
    120_000,
  );

  it.runIf(PYTHON)(
    "plans, validates, dry-runs, runs and compensates a flow across connectors",
    async () => {
      const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(join(home, "_compose", "python"))})
from anvil_compose import Composite, ComposeError, item, ref

mock = ${JSON.stringify(mock.url)}
c = Composite(connectors={
    "github": {"base_url": mock, "token": "e2e-upstream-pat"},
    "mirror": {"base_url": mock, "token": "e2e-upstream-pat"},
    "payments": {"base_url": "http://127.0.0.1:9", "token": "unused"},
})
out = {"connectors": c.connectors()}
try:
    c.resolve("github.issues.list")
except ComposeError as error:
    out["ambiguous"] = error.code
flow = c.flow("triage")
issues = flow.step("issues", "github:github.issues.list", owner="octo", repo="hello")
flow.map("comment", "github.comments.create", over=issues, connector="mirror",
         args={"owner": "octo", "repo": "hello", "issue_number": item("number"), "body": "triaged"})
flow.step("customer", "payments.customers.get", customer_id=ref(issues, "[0].title"), after=["comment"])
plan = flow.plan()
out["waves"] = plan["waves"]
out["summary"] = plan["summary"]
out["findings"] = flow.validate()
out["dry"] = flow.dry_run().status
run = flow.run()
out["run"] = run.to_json()
out["undone"] = [o["status"] for o in flow.compensate(run)]
out["undone_confirmed"] = [o["status"] for o in flow.compensate(run, confirm=True)]
bad = c.load({"schema": "anvil.compose-flow/v1", "steps": [
    {"id": "x", "operation": "github.issues.create", "connector": "github",
     "args": {"owner": "a", "repo": "b", "title": "t"}},
    {"id": "y", "operation": "nope.op", "after": ["z"]},
    {"id": "p", "operation": "payments.customers.get", "args": {"customer_id": {"$ref": "q"}}},
    {"id": "q", "operation": "payments.customers.get", "args": {"customer_id": {"$ref": "p"}}},
]})
out["bad"] = sorted({(f["code"], f["step"]) for f in bad.validate()})
out["refused"] = bad.run().status
roundtrip = c.load(json.dumps(flow.to_json()))
out["roundtrip"] = roundtrip.plan() == plan
print(json.dumps(out))
`;
      const result = await python(script);
      expect(result.status, result.stderr).toBe(0);
      const out = JSON.parse(result.stdout);
      expect(out.connectors).toEqual(["github", "mirror", "payments"]);
      expect(out.ambiguous).toBe("ambiguous_operation");
      expect(out.waves).toEqual([["issues"], ["comment"], ["customer"]]);
      expect(out.summary).toEqual({ steps: 3, reads: 2, writes: 1, irreversible: [] });
      expect(out.findings).toEqual([]);
      expect(out.dry).toBe("succeeded");
      expect(out.run.status).toBe("failed");
      expect(out.run.failed_step).toBe("customer");
      expect(out.run.steps.comment.connector).toBe("mirror");
      const issues = out.run.steps.issues.result.length;
      expect(out.run.compensation).toHaveLength(issues);
      expect(out.run.compensation[0]).toMatchObject({
        connector: "mirror",
        undo: { kind: "inverse", operation: "github.comments.delete" },
      });
      // The undo goes through the connector SDK's own gate: refused without confirm.
      expect(out.undone.every((s: string) => s === "failed")).toBe(true);
      expect(out.undone_confirmed.every((s: string) => s === "ok")).toBe(true);
      expect(out.bad).toEqual([
        ["confirmation_required", "x"],
        ["cycle", null],
        ["unknown_operation", "y"],
        ["unknown_step", "y"],
      ]);
      expect(out.refused).toBe("refused");
      expect(out.roundtrip).toBe(true);
      const deletes = mock.requests.filter((r) => r.method === "DELETE");
      expect(deletes).toHaveLength(issues);
    },
    60_000,
  );
});
