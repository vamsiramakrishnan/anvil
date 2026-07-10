import { describe, expect, it } from "vitest";
import {
  type AgentProcessRunner,
  type AgentRunResult,
  allowlistedEnv,
  ClaudeCodeAgentDriver,
  NodeAgentProcessRunner,
} from "./index.js";

/**
 * Driver + process-runner mechanics. The runner is the async, observable process
 * layer; the driver only configures it. Neither invokes a real coding agent.
 */
describe("NodeAgentProcessRunner", () => {
  const runner = new NodeAgentProcessRunner();

  it("captures stdout, exit code, and a structured execution log", async () => {
    const result = await runner.run({
      command: process.execPath,
      args: ["-e", "process.stdout.write('hello'); process.exit(0)"],
      cwd: process.cwd(),
    });
    expect(result.stdout).toBe("hello");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(typeof result.startedAt).toBe("string");
    expect(typeof result.endedAt).toBe("string");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("reports a non-zero exit code", async () => {
    const result = await runner.run({
      command: process.execPath,
      args: ["-e", "process.exit(3)"],
      cwd: process.cwd(),
    });
    expect(result.exitCode).toBe(3);
  });

  it("times out a long-running child", async () => {
    const result = await runner.run({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 60000)"],
      cwd: process.cwd(),
      timeoutMs: 100,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  it("cancels via an AbortSignal", async () => {
    const controller = new AbortController();
    const p = runner.run({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 60000)"],
      cwd: process.cwd(),
      signal: controller.signal,
    });
    controller.abort();
    const result = await p;
    expect(result.canceled).toBe(true);
  });
});

describe("allowlistedEnv", () => {
  it("keeps PATH/HOME and only the allowlisted names", () => {
    const env = allowlistedEnv(["FOO"], { PATH: "/bin", HOME: "/h", FOO: "1", SECRET: "x" });
    expect(env.PATH).toBe("/bin");
    expect(env.HOME).toBe("/h");
    expect(env.FOO).toBe("1");
    expect(env.SECRET).toBeUndefined();
  });
});

describe("ClaudeCodeAgentDriver configures the runner", () => {
  function fakeRunner(result: Partial<AgentRunResult>): AgentProcessRunner {
    return {
      run: async () => ({
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
        startedAt: "t0",
        endedAt: "t1",
        durationMs: 1,
        timedOut: false,
        canceled: false,
        ...result,
      }),
    };
  }

  it("throws on a non-zero exit and records the execution log", async () => {
    const driver = new ClaudeCodeAgentDriver({ runner: fakeRunner({ exitCode: 2 }) });
    // A minimal case dir with just a CASE.md is enough to build the prompt.
    const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "anvil-driver-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "CASE.md"), "# Case\ninvestigate.", "utf8");
    await expect(driver.run(dir)).rejects.toThrow(/exited 2/);
    expect(driver.lastResult?.exitCode).toBe(2);
  });
});
