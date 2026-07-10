import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type CredentialProfile,
  defaultExecutionPolicy,
  type ExecutionBackend,
  type ExecutionPolicy,
  NativeExecutionBackend,
  unenforcedFilesystemGuarantees,
} from "./execution-policy.js";
import { CASE_FILES } from "./model.js";
import type { AgentProcessRunner, AgentRunResult } from "./process-runner.js";

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
  /**
   * The credential profile the run needs. The backend resolves the minimal
   * environment for it — the driver never enumerates raw provider variables.
   */
  credentialProfile?: CredentialProfile;
  /**
   * The execution policy (filesystem/network/env/timeout/sandbox). Defaults to the
   * native policy for the credential profile; override to raise the timeout or, later,
   * select a sandboxed backend's policy.
   */
  policy?: ExecutionPolicy;
  /**
   * Explicit consent to run under a backend that cannot enforce the case's filesystem
   * split (repository read-only, case-only writes) — i.e. native execution today.
   * Absent, a native run refuses to start rather than silently accepting the reduced
   * containment. Wired to the CLI's `--allow-degraded-native`. Overrides
   * `policy.allowDegradedNative` when supplied.
   */
  allowDegradedNative?: boolean;
  /** Where the invocation runs. Defaults to the native (unsandboxed) backend. */
  backend?: ExecutionBackend;
  /**
   * Injectable process runner. A convenience that wraps the default native backend
   * around a custom runner (used by tests); ignored when `backend` is supplied.
   */
  runner?: AgentProcessRunner;
}

export class ClaudeCodeAgentDriver implements AgentDriver {
  readonly name = "claude-code";
  /** The structured execution log of the last run, for observability. */
  lastResult?: AgentRunResult;
  private readonly backend: ExecutionBackend;
  private readonly policy: ExecutionPolicy;

  constructor(private readonly options: ClaudeCodeDriverOptions = {}) {
    this.backend = options.backend ?? new NativeExecutionBackend(options.runner);
    const base = options.policy ?? defaultExecutionPolicy(options.credentialProfile);
    this.policy =
      options.allowDegradedNative !== undefined
        ? { ...base, allowDegradedNative: options.allowDegradedNative }
        : base;
  }

  async run(caseDir: string): Promise<void> {
    // Containment preflight: if the chosen backend cannot enforce the case's filesystem
    // split (native can't) and the caller has not explicitly accepted degraded
    // execution, refuse before launching anything. Degradation must be consented to, not
    // discovered after a real agent has already run unsandboxed.
    const unenforced = unenforcedFilesystemGuarantees(this.backend);
    if (unenforced.length > 0 && this.policy.allowDegradedNative !== true) {
      throw new Error(
        "Native execution cannot enforce repository read-only and case-only writes.\n" +
          "Use a sandboxed backend or pass --allow-degraded-native to acknowledge the reduced containment.",
      );
    }
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

    let result: AgentRunResult;
    try {
      result = await this.backend.execute(
        {
          command,
          args: ["-p", prompt, ...(this.options.extraArgs ?? [])],
          cwd: caseDir,
          onStdout: (s) => process.stdout.write(s),
          onStderr: (s) => process.stderr.write(s),
        },
        this.policy,
      );
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
