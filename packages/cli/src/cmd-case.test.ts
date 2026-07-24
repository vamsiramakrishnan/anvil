import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAnvilCli } from "./anvil-cli.js";
import { bufferIO } from "./io.js";

let root: string;
let caseDir: string;
let fakeCodex: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "anvil-case-cli-"));
  caseDir = join(root, "case");
  const binDir = join(root, "bin");
  mkdirSync(caseDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(caseDir, "CASE.md"), "# Case\nInvestigate this fixture.", "utf8");
  fakeCodex = join(binDir, "codex");
  writeFileSync(
    fakeCodex,
    [
      "#!/usr/bin/env node",
      'const { writeFileSync } = require("node:fs");',
      'let input = "";',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (chunk) => { input += chunk; });',
      'process.stdin.on("end", () => {',
      '  writeFileSync("cli-invocation.json",',
      "    JSON.stringify({ args: process.argv.slice(2), input }));",
      "});",
    ].join("\n"),
    "utf8",
  );
  chmodSync(fakeCodex, 0o755);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("anvil case investigate", () => {
  it("uses Codex's exec protocol when --command resolves to codex", async () => {
    const io = bufferIO();
    const code = await runAnvilCli(
      [
        "case",
        "investigate",
        caseDir,
        "--command",
        fakeCodex,
        "--model",
        "test-model",
        "--allow-degraded-native",
      ],
      { io },
    );

    expect(code).toBe(0);
    expect(io.stderr.join("\n")).toContain("driving codex");
    expect(io.stderr.join("\n")).not.toContain("driving claude-code");
    const invocation = JSON.parse(readFileSync(join(caseDir, "cli-invocation.json"), "utf8")) as {
      args: string[];
      input: string;
    };
    expect(invocation.args).toEqual([
      "exec",
      "--json",
      "--ephemeral",
      "--skip-git-repo-check",
      "--sandbox",
      "workspace-write",
      "--model",
      "test-model",
      "-",
    ]);
    expect(invocation.input).toContain("# Case");
  });

  it("still refuses native execution without explicit degraded-containment consent", async () => {
    const io = bufferIO();
    const code = await runAnvilCli(["case", "investigate", caseDir, "--command", fakeCodex], {
      io,
    });

    expect(code).toBe(1);
    expect(io.stderr.join("\n")).toContain("--allow-degraded-native");
    expect(existsSync(join(caseDir, "cli-invocation.json"))).toBe(false);
  });

  it("describes Codex protocol detection in command help", async () => {
    const io = bufferIO();
    expect(await runAnvilCli(["case", "investigate", "--help"], { io })).toBe(0);
    expect(io.text()).toMatch(/codex is\s+protocol-aware/);
  });
});
