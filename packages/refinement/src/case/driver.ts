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
 * a supported coding-agent CLI against the case directory. This is build-time only —
 * never on Anvil's serving hot path — and invoked solely by `anvil case investigate`.
 * Provider adapters own their CLI grammar so a Codex invocation can never accidentally
 * receive Claude's `-p` print flag (which Codex interprets as a config profile).
 */
export interface AgentCliDriverOptions {
  /** The headless coding-agent command. Its provider supplies the default. */
  command?: string;
  /** Extra provider CLI flags, e.g. `["--model", "gpt-5"]`. */
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

/** Backwards-compatible options name for the explicitly Claude-compatible driver. */
export type ClaudeCodeDriverOptions = AgentCliDriverOptions;

export type AgentProvider = "claude-code" | "codex";
export type AgentOutputMode = "text" | "jsonl";

interface ProviderAdapter {
  name: AgentProvider;
  defaultCommand: string;
  credentialProfile: CredentialProfile;
  outputMode: AgentOutputMode;
  invocation(prompt: string, extraArgs: string[]): { args: string[]; input?: string };
}

const PROVIDER_ADAPTERS: Record<AgentProvider, ProviderAdapter> = {
  "claude-code": {
    name: "claude-code",
    defaultCommand: "claude",
    credentialProfile: "claude-code",
    outputMode: "text",
    invocation: (prompt, extraArgs) => ({
      // Claude's `-p` is a boolean print-mode flag; the prompt is its positional.
      args: ["-p", prompt, ...extraArgs],
    }),
  },
  codex: {
    name: "codex",
    defaultCommand: "codex",
    credentialProfile: "codex",
    outputMode: "jsonl",
    invocation: (prompt, extraArgs) => ({
      // Codex's `-p` means "profile", not "prompt". `exec -` reads the prompt from
      // stdin, while JSONL keeps process output machine-observable. The Codex-owned
      // sandbox is additive to Anvil's backend policy; it never replaces the explicit
      // `--allow-degraded-native` acknowledgement required by the native backend.
      args: [
        "exec",
        "--json",
        "--ephemeral",
        "--skip-git-repo-check",
        "--sandbox",
        "workspace-write",
        ...extraArgs,
        "-",
      ],
      input: prompt,
    }),
  },
};

/**
 * Shared live coding-agent implementation. Provider adapters configure only command
 * grammar, prompt transport, credentials, and output mode; the backend still owns
 * containment, environment narrowing, timeout, and cancellation.
 */
export class CodingAgentDriver implements AgentDriver {
  readonly name: AgentProvider;
  readonly outputMode: AgentOutputMode;
  /** The structured execution log of the last run, for observability. */
  lastResult?: AgentRunResult;
  private readonly backend: ExecutionBackend;
  private readonly policy: ExecutionPolicy;
  private readonly command: string;

  constructor(
    readonly provider: AgentProvider,
    private readonly options: AgentCliDriverOptions = {},
  ) {
    const adapter = PROVIDER_ADAPTERS[provider];
    this.name = adapter.name;
    this.outputMode = adapter.outputMode;
    this.command = options.command ?? adapter.defaultCommand;
    this.backend = options.backend ?? new NativeExecutionBackend(options.runner);
    const profile = options.credentialProfile ?? adapter.credentialProfile;
    const base = options.policy ?? defaultExecutionPolicy(profile);
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
    const invocation = PROVIDER_ADAPTERS[this.provider].invocation(
      prompt,
      this.options.extraArgs ?? [],
    );

    let result: AgentRunResult;
    try {
      result = await this.backend.execute(
        {
          command: this.command,
          args: invocation.args,
          cwd: caseDir,
          input: invocation.input,
          onStdout: (s) => process.stdout.write(s),
          onStderr: (s) => process.stderr.write(s),
        },
        this.policy,
      );
    } catch (err) {
      const hint =
        (err as NodeJS.ErrnoException).code === "ENOENT"
          ? ` — is '${this.command}' installed and on PATH?`
          : "";
      throw new Error(
        `Agent driver '${this.command}' failed to launch: ${(err as Error).message}${hint}`,
      );
    }
    this.lastResult = result;
    if (result.timedOut) throw new Error(`Agent driver '${this.command}' timed out.`);
    if (result.canceled) throw new Error(`Agent driver '${this.command}' was canceled.`);
    if (result.exitCode !== 0)
      throw new Error(`Agent driver '${this.command}' exited ${result.exitCode}.`);
  }
}

/** Explicit Claude/generic-Claude-compatible driver retained for existing callers. */
export class ClaudeCodeAgentDriver extends CodingAgentDriver {
  constructor(options: ClaudeCodeDriverOptions = {}) {
    super("claude-code", options);
  }
}

/** Codex's non-interactive `exec` protocol (stdin prompt + JSONL events). */
export class CodexAgentDriver extends CodingAgentDriver {
  constructor(options: AgentCliDriverOptions = {}) {
    super("codex", options);
  }
}

export interface AgentDriverFactoryOptions extends AgentCliDriverOptions {
  /** Override command-name inference when driving a wrapper executable. */
  provider?: AgentProvider;
}

/**
 * Select the smallest provider adapter needed by a command. Exact `codex` executable
 * basenames use Codex's protocol; every other command preserves the existing
 * Claude-compatible protocol. Wrappers can opt in explicitly with `provider`.
 */
export function createAgentDriver(options: AgentDriverFactoryOptions = {}): CodingAgentDriver {
  const { provider = inferAgentProvider(options.command), ...driverOptions } = options;
  return provider === "codex"
    ? new CodexAgentDriver(driverOptions)
    : new ClaudeCodeAgentDriver(driverOptions);
}

export function inferAgentProvider(command = "claude"): AgentProvider {
  const executable = command.trim().split(/[\\/]/).pop()?.toLowerCase() ?? "";
  return /^codex(?:\.exe|\.cmd)?$/.test(executable) ? "codex" : "claude-code";
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
