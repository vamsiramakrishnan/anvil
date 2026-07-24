import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { join, sep } from "node:path";
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
  /**
   * `isolated` replaces HOME/XDG/TMPDIR with a private directory inside the
   * invocation workspace. This prevents a reviewer from implicitly inheriting
   * host CLI state; credentials must arrive through the named profile instead.
   */
  home: "host" | "isolated";
  /** Environment variable names the run may see, on top of PATH and the selected HOME policy. */
  environmentAllowlist: string[];
  timeoutMs: number;
  sandbox: SandboxKind;
  /** Explicit opt-in to run under a backend that cannot enforce everything the policy asks for. */
  allowDegradedNative?: boolean;
}

export const DEFAULT_AGENT_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * Named credential profiles: the minimal environment a backend resolves for an agent.
 * A driver asks for a profile by name (`credentialProfile: "claude-code"` or
 * `"codex"`); it never enumerates raw provider variables. This is what lets credential
 * *delivery* become runner-owned later (Cloud Run + Secret Manager) without touching
 * the driver.
 */
export const CREDENTIAL_PROFILES = {
  "claude-code": ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "HTTPS_PROXY"],
  codex: ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_HOME", "HTTPS_PROXY"],
} as const;
export type CredentialProfile = keyof typeof CREDENTIAL_PROFILES;

/**
 * The default policy for a credential profile: native sandbox, unrestricted (host)
 * network — the only network state native honestly satisfies without configuring
 * anything — and `allowDegradedNative: false`. No sandboxed backend exists yet, so the
 * native backend cannot enforce the filesystem split; that degradation must be an
 * explicit, acknowledged choice rather than a silent default. A native run therefore
 * refuses to start unless the caller opts in (`--allow-degraded-native`). Never flip
 * this to `true` "because Bubblewrap is unavailable" — the whole point is that the gap
 * is visible and consented to, not assumed away.
 */
export function defaultExecutionPolicy(
  profile: CredentialProfile = "claude-code",
): ExecutionPolicy {
  return {
    filesystem: { repository: "read-only", case: "read-write" },
    network: "host",
    home: "host",
    environmentAllowlist: [...CREDENTIAL_PROFILES[profile]],
    timeoutMs: DEFAULT_AGENT_TIMEOUT_MS,
    sandbox: "native",
    allowDegradedNative: false,
  };
}

/**
 * The filesystem guarantees the policy's fixed split asks for that a backend cannot
 * enforce, phrased for a human ("repository read-only", "case-only writes"). A native
 * backend returns both; a real sandbox returns none. This is what lets a driver refuse
 * to start a native run — with a message naming exactly what containment is missing —
 * before it opts into degraded execution.
 */
export function unenforcedFilesystemGuarantees(backend: ExecutionBackend): string[] {
  const out: string[] = [];
  if (!backend.capabilities.enforceReadOnlyRepository) out.push("repository read-only");
  if (!backend.capabilities.enforceCaseWriteBoundary) out.push("case-only writes");
  return out;
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
 * What a backend actually enforces, as opposed to what the policy asks for. `network:
 * "host"` needs no flag — it's the trivial no-restriction state any backend satisfies —
 * so there is deliberately no `enforceNetworkHost`.
 */
export interface ExecutionBackendCapabilities {
  enforceReadOnlyRepository: boolean;
  enforceCaseWriteBoundary: boolean;
  enforceNetworkNone: boolean;
  enforceNetworkProxy: boolean;
}

/** A record of what a run actually enforced vs. what the policy asked for but didn't get. */
export interface ExecutionAttestation {
  requestedSandbox: SandboxKind;
  actualSandbox: SandboxKind;
  enforced: string[];
  degraded: string[];
}

/**
 * A place an agent invocation can run under an `ExecutionPolicy`. `native` runs the
 * process directly with an allowlisted environment and a timeout; `bubblewrap` /
 * `container` backends (not yet written) will additionally enforce the filesystem and
 * network bounds. `capabilities` is what lets a backend be honest about the gap between
 * the two instead of silently under-enforcing. The driver depends only on this interface.
 */
export interface ExecutionBackend {
  readonly sandbox: SandboxKind;
  readonly capabilities: ExecutionBackendCapabilities;
  execute(invocation: AgentInvocation, policy: ExecutionPolicy): Promise<AgentRunResult>;
}

/**
 * The native backend: no sandbox, but it still narrows the environment to the policy's
 * allowlist and applies the timeout. It is the honest floor — it enforces what a bare
 * process can (environment, timeout, cancellation) and claims none of the filesystem or
 * network capabilities. A run that needs those must select a sandboxed backend, or set
 * `allowDegradedNative: true` to accept native's floor and get back an attestation of
 * exactly what was and wasn't enforced.
 */
export class NativeExecutionBackend implements ExecutionBackend {
  readonly sandbox = "native" as const;
  readonly capabilities: ExecutionBackendCapabilities = {
    enforceReadOnlyRepository: false,
    enforceCaseWriteBoundary: false,
    enforceNetworkNone: false,
    enforceNetworkProxy: false,
  };
  constructor(private readonly runner: AgentProcessRunner = new NodeAgentProcessRunner()) {}

  private unenforceableGuarantees(policy: ExecutionPolicy): string[] {
    const violations: string[] = [];
    if (policy.network === "none" && !this.capabilities.enforceNetworkNone) {
      violations.push("network=none (not enforced by native backend)");
    }
    if (policy.network === "proxy" && !this.capabilities.enforceNetworkProxy) {
      violations.push("network=proxy (not enforced by native backend)");
    }
    if (!this.capabilities.enforceReadOnlyRepository) {
      violations.push("filesystem.repository=read-only (not enforced by native backend)");
    }
    if (!this.capabilities.enforceCaseWriteBoundary) {
      violations.push("filesystem.case=read-write (not enforced by native backend)");
    }
    return violations;
  }

  async execute(invocation: AgentInvocation, policy: ExecutionPolicy): Promise<AgentRunResult> {
    const degraded = this.unenforceableGuarantees(policy);
    if (degraded.length > 0 && policy.allowDegradedNative !== true) {
      throw new Error(
        `Native backend cannot enforce: ${degraded.join("; ")}. Set allowDegradedNative: true on the policy to proceed anyway.`,
      );
    }

    const isolatedHome =
      policy.home === "isolated" ? prepareIsolatedHome(invocation.cwd) : undefined;
    let result: AgentRunResult;
    try {
      result = await this.runner.run({
        command: invocation.command,
        args: invocation.args,
        cwd: invocation.cwd,
        env: allowlistedEnv(policy.environmentAllowlist, process.env, { isolatedHome }),
        timeoutMs: policy.timeoutMs,
        input: invocation.input,
        signal: invocation.signal,
        onStdout: invocation.onStdout,
        onStderr: invocation.onStderr,
      });
    } finally {
      if (isolatedHome) rmSync(isolatedHome, { recursive: true, force: true });
    }
    if (degraded.length === 0) return result;

    const enforced = ["environmentAllowlist", "timeoutMs"];
    if (isolatedHome) enforced.push("isolatedHome");
    if (policy.network === "host") enforced.push("network");
    const attestation: ExecutionAttestation = {
      requestedSandbox: policy.sandbox,
      actualSandbox: this.sandbox,
      enforced,
      degraded,
    };
    return { ...result, attestation };
  }
}

function prepareIsolatedHome(cwd: string): string {
  const home = mkdtempSync(join(cwd, ".agent-home-"));
  const boundary = realpathSync(cwd);
  for (const path of [home, join(home, ".config"), join(home, ".cache"), join(home, ".local")]) {
    ensurePrivateDirectory(path, boundary);
  }
  ensurePrivateDirectory(join(home, ".local", "share"), boundary);
  ensurePrivateDirectory(join(home, "tmp"), boundary);
  return home;
}

function ensurePrivateDirectory(path: string, boundary: string): void {
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
  const stat = lstatSync(path);
  const real = realpathSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (real !== boundary && !real.startsWith(`${boundary}${sep}`))
  ) {
    throw new Error(`Isolated agent HOME contains an unsafe filesystem node: ${path}`);
  }
  chmodSync(path, 0o700);
}
