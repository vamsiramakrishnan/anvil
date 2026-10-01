import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { airFromYaml, airToYaml } from "@anvil/air";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAnvilCli } from "../anvil-cli.js";
import { bufferIO } from "../io.js";

/**
 * `anvil package harness` and `anvil connectors index` (ADR-0029): the files a
 * Branchyard harness home holds, all in gateway mode.
 */

const examples = fileURLToPath(new URL("../../../../examples/", import.meta.url));
const PYTHON = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
let work = "";
let github = "";
let payments = "";

async function anvil(args: string[]) {
  const io = bufferIO();
  const code = await runAnvilCli(args, { io });
  return { code, io };
}

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "anvil-harness-pkg-"));
  github = join(work, "ws", "github");
  payments = join(work, "ws", "payments");
  for (const [out, name] of [
    [github, "github-mini"],
    [payments, "payments"],
  ] as const) {
    const compiled = await anvil([
      "compile",
      join(examples, name, "openapi.yaml"),
      "--manifest",
      join(examples, name, "anvil.yaml"),
      "--out",
      out,
    ]);
    if (compiled.code !== 0) throw new Error(compiled.io.text());
  }
}, 120_000);
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("anvil package harness", () => {
  it("writes a self-contained gateway-mode package", async () => {
    const out = join(work, "home", "github");
    const { code, io } = await anvil(["package", "harness", github, "--out", out]);
    expect(code, io.text()).toBe(0);
    for (const rel of [
      "SKILL.md",
      "harness.json",
      "reference/operations.md",
      "reference/errors.md",
      "reference/idempotency.md",
      "schemas/list_issue.schema.json",
      "python/anvil_github/_gateway.py",
      "python/anvil_github/client.py",
      "typescript/src/gateway.ts",
      "typescript/src/client.ts",
      "bin/github",
      "bin/package.json",
    ]) {
      expect(existsSync(join(out, rel)), rel).toBe(true);
    }
    expect(existsSync(join(out, "reference", "setup.md"))).toBe(false);
    expect(statSync(join(out, "bin", "github")).mode & 0o111).not.toBe(0);

    const skill = readFileSync(join(out, "SKILL.md"), "utf8");
    expect(skill).toMatch(/^---\nname: github\ndescription: Use when a task needs GitHub Mini/);
    expect(skill).toContain("bin/github issues list --owner <owner> --repo <repo>");
    expect(skill).toContain("policy/grant_denied");
    expect(skill).not.toMatch(/GITHUB_TOKEN|ANVIL_[A-Z_]+_TOKEN\b/);
    expect(skill.split("\n").length).toBeLessThan(80);

    const manifest = JSON.parse(readFileSync(join(out, "harness.json"), "utf8"));
    expect(manifest).toMatchObject({
      connector: "github",
      service: { id: "github" },
      bundleHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      entrypoints: { cli: "bin/github", python: "python/anvil_github" },
    });
    expect(manifest.operations.map((o: { tool: string }) => o.tool)).toContain(
      "github__github_list_issue",
    );
    expect(readFileSync(join(out, "python", "anvil_github", "_gateway.py"), "utf8")).toContain(
      'DEFAULT_CONNECTOR = "github"',
    );
  });

  it("the packaged CLI runs on bare Node, documents itself, and refuses without a gateway", () => {
    const out = join(work, "home", "github");
    const bin = join(out, "bin", "github");
    const env = { PATH: process.env.PATH ?? "" };
    const help = execFileSync(bin, ["--help"], { env, encoding: "utf8" });
    expect(help).toContain("github issues list --owner <string> --repo <string>");
    expect(help).toContain("needs --confirm");
    const opHelp = execFileSync(bin, ["issues", "create", "--help"], { env, encoding: "utf8" });
    expect(opHelp).toContain("Needs --confirm");
    const schema = JSON.parse(
      execFileSync(bin, ["issues", "get", "--schema"], { env, encoding: "utf8" }),
    );
    expect(schema.required).toEqual(expect.arrayContaining(["owner", "repo", "issue_number"]));
    const refused = spawnSync(bin, ["issues", "list", "--owner", "o", "--repo", "r"], {
      env,
      encoding: "utf8",
    });
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain("ANVIL_GATEWAY_URL is not set");
    const typo = spawnSync(bin, ["issues", "list", "--ownr", "o"], { env, encoding: "utf8" });
    expect(typo.status).toBe(2);
    expect(typo.stderr).toContain("--ownr");
  });

  it.runIf(PYTHON)("the packaged Python SDK imports and starts in gateway mode", () => {
    const out = join(work, "home", "github");
    const printed = execFileSync(
      "python3",
      [
        "-c",
        "from anvil_github import GithubClient; c = GithubClient(); print(c._gateway.connector)",
      ],
      {
        env: {
          PATH: process.env.PATH ?? "",
          PYTHONPATH: join(out, "python"),
          ANVIL_GATEWAY_URL: "http://127.0.0.1:1/mcp",
        },
        encoding: "utf8",
      },
    );
    expect(printed.trim()).toBe("github");
  });

  it("refuses to replace a directory that is not a harness package", async () => {
    const out = join(work, "not-a-package");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "keep.txt"), "mine");
    const { code, io } = await anvil(["package", "harness", github, "--out", out]);
    expect(code).toBe(1);
    expect(io.text()).toContain("not a harness package");
    expect(readFileSync(join(out, "keep.txt"), "utf8")).toBe("mine");
  });

  it("takes an explicit connector id", async () => {
    const out = join(work, "home", "gh_work");
    const { code } = await anvil([
      "package",
      "harness",
      github,
      "--out",
      out,
      "--connector",
      "gh_work",
    ]);
    expect(code).toBe(0);
    expect(existsSync(join(out, "bin", "gh_work"))).toBe(true);
    expect(JSON.parse(readFileSync(join(out, "harness.json"), "utf8")).connector).toBe("gh_work");
  });
});

describe("connector ids follow the fleet's rule", () => {
  it("names a nested fleet bundle by its folded workspace path, in the package and the index", async () => {
    const ws = join(work, "fleet");
    const nested = join(ws, "team", "github");
    mkdirSync(dirname(nested), { recursive: true });
    cpSync(github, nested, { recursive: true });
    const out = join(work, "fleet-home", "team_github");
    const packaged = await anvil(["package", "harness", nested, "--out", out, "--workspace", ws]);
    expect(packaged.code, packaged.io.text()).toBe(0);
    const manifest = JSON.parse(readFileSync(join(out, "harness.json"), "utf8"));
    expect(manifest.connector).toBe("team_github");
    expect(manifest.operations.map((op: { tool: string }) => op.tool)).toContain(
      "team_github__github_list_issue",
    );
    expect(existsSync(join(out, "bin", "team_github"))).toBe(true);
    expect(readFileSync(join(out, "bin", "team_github"), "utf8")).toContain("team_github");

    const grants = join(work, "fleet-grants.json");
    writeFileSync(
      grants,
      JSON.stringify([{ connector: "team_github", operations: ["*"], mode: "read" }]),
    );
    const index = join(work, "fleet-home", "INDEX.md");
    const indexed = await anvil([
      "connectors",
      "index",
      "--grants",
      grants,
      "--out",
      index,
      "--workspace",
      ws,
      nested,
    ]);
    expect(indexed.code, indexed.io.text()).toBe(0);
    expect(readFileSync(index, "utf8")).toContain("## team_github — GitHub Mini");

    // An explicit --connector still wins; a bundle outside the workspace is refused.
    const explicit = await anvil([
      "package",
      "harness",
      nested,
      "--out",
      join(work, "fleet-home", "gh"),
      "--workspace",
      ws,
      "--connector",
      "gh",
    ]);
    expect(explicit.code).toBe(0);
    expect(
      JSON.parse(readFileSync(join(work, "fleet-home", "gh", "harness.json"), "utf8")).connector,
    ).toBe("gh");
    const outside = await anvil([
      "package",
      "harness",
      payments,
      "--out",
      join(work, "fleet-home", "payments"),
      "--workspace",
      ws,
    ]);
    expect(outside.code).toBe(1);
    expect(outside.io.text()).toContain("not a bundle the workspace");
  });
});

describe("webhook receivers", () => {
  it("leaves an approved webhook_receiver out of the CLI, skill and harness.json, as the MCP server and SDKs do", async () => {
    const bundle = join(work, "hooked", "github");
    cpSync(github, bundle, { recursive: true });
    const air = airFromYaml(readFileSync(join(bundle, "air.yaml"), "utf8"));
    const hooked = {
      ...air,
      operations: air.operations.map((op) =>
        op.id === "github.pulls.list" ? { ...op, archetype: "webhook_receiver" as const } : op,
      ),
    };
    writeFileSync(join(bundle, "air.yaml"), airToYaml(hooked), "utf8");
    rmSync(join(bundle, "air.json"), { force: true });
    const out = join(work, "hooked-home", "github");
    const { code, io } = await anvil(["package", "harness", bundle, "--out", out]);
    expect(code, io.text()).toBe(0);
    const manifest = JSON.parse(readFileSync(join(out, "harness.json"), "utf8"));
    const ids = manifest.operations.map((op: { id: string }) => op.id);
    expect(ids).toContain("github.issues.list");
    expect(ids).not.toContain("github.pulls.list");
    expect(readFileSync(join(out, "SKILL.md"), "utf8")).not.toContain("github pulls list");
    expect(readFileSync(join(out, "bin", "github"), "utf8")).not.toContain("github.pulls.list");
    const help = execFileSync(join(out, "bin", "github"), ["--help"], {
      env: { PATH: process.env.PATH ?? "" },
      encoding: "utf8",
    });
    expect(help).not.toContain("pulls list");
    // The SDK the package ships agrees.
    expect(readFileSync(join(out, "python", "anvil_github", "client.py"), "utf8")).not.toContain(
      "list_pull",
    );
  });
});

describe("anvil connectors index", () => {
  it("lists only granted connectors, one short entry each", async () => {
    const grants = join(work, "grants.json");
    writeFileSync(
      grants,
      JSON.stringify([
        { connector: "github", operations: ["issues.*"], mode: "read", account: "work" },
      ]),
    );
    const out = join(work, "home", "INDEX.md");
    const { code, io } = await anvil([
      "connectors",
      "index",
      "--grants",
      grants,
      "--out",
      out,
      github,
      payments,
    ]);
    expect(code, io.text()).toBe(0);
    const index = readFileSync(out, "utf8");
    expect(index).toContain("## github — GitHub Mini");
    expect(index).toContain("read (issues.*), account work");
    expect(index).toContain("`github/SKILL.md`");
    expect(index).not.toContain("payments");
    expect(dirname(out)).toBe(join(work, "home"));
  });

  it("accepts {grants: [...]} and writes an empty index when nothing is granted", async () => {
    const grants = join(work, "grants-obj.json");
    writeFileSync(grants, JSON.stringify({ grants: [] }));
    const out = join(work, "empty", "INDEX.md");
    const { code } = await anvil(["connectors", "index", "--grants", grants, "--out", out, github]);
    expect(code).toBe(0);
    expect(readFileSync(out, "utf8")).toContain("No connectors are granted");
  });

  it("refuses a malformed grant", async () => {
    const grants = join(work, "bad.json");
    writeFileSync(grants, JSON.stringify([{ connector: "github", mode: "read" }]));
    const { code, io } = await anvil([
      "connectors",
      "index",
      "--grants",
      grants,
      "--out",
      join(work, "x.md"),
      github,
    ]);
    expect(code).toBe(1);
    expect(io.text()).toContain("is not a grant");
  });
});
