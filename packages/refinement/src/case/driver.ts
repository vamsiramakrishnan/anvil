import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CASE_FILES } from "./model.js";
import {
  type AgentProcessRunner,
  type AgentRunResult,
  allowlistedEnv,
  NodeAgentProcessRunner,
} from "./process-runner.js";

/**
 * An **agent driver** performs the investigation *inside* a materialised case: it
 * reads the brief, navigates the repository, runs the `anvil case` helpers, and
 * deposits the phase outputs. It is the one place a real coding agent (Claude Code,
 * Codex) is invoked, kept behind a narrow, swappable seam so the rest of the
 * framework — materialise, validate, reconcile — stays agent-free and deterministic.
 *
 * A driver only ever writes into the case's own `workspace/` and `output/`; it does
 * not (and must not) touch AIR. What it produces is untrusted until the
 * deterministic core validates it.
 */
export interface AgentDriver {
  name: string;
  /** Investigate the case at `caseDir`, populating its `output/`. */
  run(caseDir: string): Promise<void>;
}

/**
 * The live driver: configures the reusable async `AgentProcessRunner` to shell out to
 * the Claude Code CLI in headless print mode against the case directory. This is
 * build-time only — never on Anvil's serving hot path — and invoked solely by
 * `anvil case investigate`, never by the tests. The command is configurable so Codex
 * or any other headless coding agent can stand in, and the runner is injectable so
 * the driver can be tested without a real agent binary.
 */
export interface ClaudeCodeDriverOptions {
  /** The headless coding-agent command (default `claude`). */
  command?: string;
  /** Extra CLI flags, e.g. `["--model", "claude-opus-4-8", "--permission-mode", "plan"]`. */
  extraArgs?: string[];
  /** Hard wall-clock cap for one investigation. */
  timeoutMs?: number;
  /**
   * Environment variable names to pass through to the agent, on top of PATH/HOME.
   * The investigation gets a minimal environment, not the parent's whole secret surface.
   */
  envAllowlist?: string[];
  /** Injectable process runner (defaults to the async NodeAgentProcessRunner). */
  runner?: AgentProcessRunner;
}

export class ClaudeCodeAgentDriver implements AgentDriver {
  readonly name = "claude-code";
  /** The structured execution log of the last run, for observability. */
  lastResult?: AgentRunResult;
  private readonly runner: AgentProcessRunner;

  constructor(private readonly options: ClaudeCodeDriverOptions = {}) {
    this.runner = options.runner ?? new NodeAgentProcessRunner();
  }

  async run(caseDir: string): Promise<void> {
    const command = this.options.command ?? "claude";
    const brief = readFileSync(join(caseDir, CASE_FILES.brief), "utf8");
    const prompt = [
      brief,
      "",
      "---",
      "You are running inside this case directory (it is your working directory).",
      "Investigate using your own tools and the `anvil case` helpers, then deposit the",
      "phase outputs under `output/`. Run `anvil case finalize .` when you are done —",
      "including when the honest outcome is no proposal. Do not edit any file outside",
      "this case directory.",
    ].join("\n");

    const env = allowlistedEnv(
      this.options.envAllowlist ?? ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "HTTPS_PROXY"],
    );
    let result: AgentRunResult;
    try {
      result = await this.runner.run({
        command,
        args: ["-p", prompt, ...(this.options.extraArgs ?? [])],
        cwd: caseDir,
        env,
        timeoutMs: this.options.timeoutMs ?? 20 * 60 * 1000,
        onStdout: (s) => process.stdout.write(s),
        onStderr: (s) => process.stderr.write(s),
      });
    } catch (err) {
      const hint =
        (err as NodeJS.ErrnoException).code === "ENOENT"
          ? ` — is '${command}' installed and on PATH?`
          : "";
      throw new Error(
        `Agent driver '${command}' failed to launch: ${(err as Error).message}${hint}`,
      );
    }
    this.lastResult = result;
    if (result.timedOut) throw new Error(`Agent driver '${command}' timed out.`);
    if (result.canceled) throw new Error(`Agent driver '${command}' was canceled.`);
    if (result.exitCode !== 0)
      throw new Error(`Agent driver '${command}' exited ${result.exitCode}.`);
  }
}

/**
 * A deterministic driver: runs a supplied function against the case directory. It is
 * the fixture every test uses (the investigation is scripted, so no LLM and no
 * flakiness) and the seam a caller uses to drive a case programmatically — e.g.
 * feeding pre-gathered evidence through the helper commands.
 */
export class ScriptedAgentDriver implements AgentDriver {
  readonly name = "scripted";
  constructor(private readonly script: (caseDir: string) => void | Promise<void>) {}
  async run(caseDir: string): Promise<void> {
    await this.script(caseDir);
  }
}
