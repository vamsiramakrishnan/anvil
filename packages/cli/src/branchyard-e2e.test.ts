import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The Branchyard connector fixture end to end (examples/github-mini/e2e.mjs,
 * docs/branchyard.md): the built `anvil` CLI compiles and packages the
 * fixture, serves it with `anvil serve mcp --fleet --http` in branchyard mode
 * against a JWKS file and a mock upstream, connects the person's account,
 * lists issues through the packaged Python SDK in gateway mode, is refused
 * `issues.create` with `policy_denied`, and finds both calls in the audit
 * log. This test runs the same script Branchyard's own tests drive.
 */

const script = fileURLToPath(new URL("../../../examples/github-mini/e2e.mjs", import.meta.url));
const bin = fileURLToPath(new URL("../dist/bin-anvil.js", import.meta.url));
const PYTHON = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

describe.runIf(PYTHON && existsSync(bin))("Branchyard connector fixture", () => {
  it("passes every check in examples/github-mini/e2e.mjs", () => {
    const run = spawnSync(process.execPath, [script, "--anvil", bin], {
      encoding: "utf8",
      timeout: 170_000,
    });
    const last = run.stdout.trim().split("\n").at(-1) ?? "";
    let summary: { ok?: boolean; checks?: Array<{ name: string; ok: boolean }> } = {};
    try {
      summary = JSON.parse(last);
    } catch {
      throw new Error(`e2e.mjs printed no summary:\n${run.stdout}\n${run.stderr}`);
    }
    expect(
      summary.checks?.filter((check) => !check.ok),
      run.stderr,
    ).toEqual([]);
    expect(summary.ok).toBe(true);
    expect(run.status).toBe(0);
  }, 180_000);
});
