import {
  type AgentProcessRunner,
  type AgentRunResult,
  allowlistedEnv,
  NodeAgentProcessRunner,
} from "./process-runner.js";

/**
 * **Execution policy and backends.** An agent driver decides *what* to run (the
 * command, the prompt, the credential profile it needs); an execution *backend*
 * decides *how much it is allowed to touch* (filesystem, network, environment,
 * sandbox). Separating the two keeps sandbox details out of Claude-specific code:
 * Bubblewrap and Cloud Run Jobs become new backends that enforce the same
 * `ExecutionPolicy`, not new branches inside the driver. This file models the policy
 * and ships the one native backend; the sandboxed backends are deliberately unwritten.
 */

export type SandboxKind = "native" | "bubblewrap" | "container";
export type NetworkPolicy = "none" | "host" | "proxy";

/**
 * The bounds one agent run executes within. The filesystem split is fixed — the
 * repository is read-only, the case directory read-write — because it is the whole
 * safety story; a backend that cannot honour it must refuse rather than widen it.
 */
export interface ExecutionPolicy {
  filesystem: { repository: "read-only"; case: "read-write" };
  network: NetworkPolicy;
  /** Environment variable names the run may see, on top of PATH/HOME. */
  environmentAllowlist: string[];
  timeoutMs: number;
  sandbox: SandboxKind;
}

export const DEFAULT_AGENT_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * Named credential profiles: the minimal environment a backend resolves for an agent.
 * A driver asks for a profile by name (`credentialProfile: "claude-code"`); it never
 * enumerates raw provider variables. This is what lets credential *delivery* become
 * runner-owned later (Cloud Run + Secret Manager) without touching the driver.
 */
export const CREDENTIAL_PROFILES = {
  "claude-code": ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "HTTPS_PROXY"],
} as const;
export type CredentialProfile = keyof typeof CREDENTIAL_PROFILES;

/** The default policy for a credential profile: native sandbox, proxied network. */
export function defaultExecutionPolicy(
  profile: CredentialProfile = "claude-code",
): ExecutionPolicy {
  return {
    filesystem: { repository: "read-only", case: "read-write" },
    network: "proxy",
    environmentAllowlist: [...CREDENTIAL_PROFILES[profile]],
    timeoutMs: DEFAULT_AGENT_TIMEOUT_MS,
    sandbox: "native",
  };
}

/** A resolved request to run one agent process — what a driver hands a backend. */
export interface AgentInvocation {
  command: string;
  args: string[];
  cwd: string;
  input?: string;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

/**
 * A place an agent invocation can run under an `ExecutionPolicy`. `native` runs the
 * process directly with an allowlisted environment and a timeout; `bubblewrap` /
 * `container` backends (not yet written) will additionally enforce the filesystem and
 * network bounds. The driver depends only on this interface.
 */
export interface ExecutionBackend {
  readonly sandbox: SandboxKind;
  execute(invocation: AgentInvocation, policy: ExecutionPolicy): Promise<AgentRunResult>;
}

/**
 * The native backend: no sandbox, but it still narrows the environment to the policy's
 * allowlist and applies the timeout. It is the honest floor — it enforces what a bare
 * process can (environment, timeout, cancellation) and makes no claim to isolate the
 * filesystem or network. A run that needs those must select a sandboxed backend.
 */
export class NativeExecutionBackend implements ExecutionBackend {
  readonly sandbox = "native" as const;
  constructor(private readonly runner: AgentProcessRunner = new NodeAgentProcessRunner()) {}

  execute(invocation: AgentInvocation, policy: ExecutionPolicy): Promise<AgentRunResult> {
    return this.runner.run({
      command: invocation.command,
      args: invocation.args,
      cwd: invocation.cwd,
      env: allowlistedEnv(policy.environmentAllowlist),
      timeoutMs: policy.timeoutMs,
      input: invocation.input,
      signal: invocation.signal,
      onStdout: invocation.onStdout,
      onStderr: invocation.onStderr,
    });
  }
}
