import { type ChildProcess, spawn } from "node:child_process";

/**
 * A reusable, asynchronous, observable process runner. It owns the generic child
 * process lifecycle — streamed stdout/stderr, a timeout, cancellation, exit status,
 * and a structured execution log — so an agent driver only has to *configure* it,
 * not re-implement process plumbing with a blocking `spawnSync`. This is what lets
 * cases run concurrently later without blocking the event loop.
 */
export interface AgentRunRequest {
  command: string;
  args: string[];
  cwd: string;
  /** The environment to run with — pass a minimal allowlist, not all of process.env. */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Data written to the child's stdin (e.g. the case brief as a prompt). */
  input?: string;
  /** Cancellation — aborting kills the child and resolves with `canceled: true`. */
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface AgentRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  timedOut: boolean;
  canceled: boolean;
}

export interface AgentProcessRunner {
  run(request: AgentRunRequest): Promise<AgentRunResult>;
}

/**
 * Build a minimal environment from an allowlist of variable names, always keeping
 * PATH and HOME. Prefer this over inheriting all of `process.env` into an agent
 * subprocess — the investigation should not see the parent's whole secret surface.
 */
export function allowlistedEnv(
  allow: string[],
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const keep = new Set(["PATH", "HOME", ...allow]);
  const env: NodeJS.ProcessEnv = {};
  for (const key of Object.keys(base)) {
    if (keep.has(key)) env[key] = base[key];
  }
  return env;
}

/** The default runner: an async `spawn` with streaming, timeout, and cancellation. */
export class NodeAgentProcessRunner implements AgentProcessRunner {
  run(request: AgentRunRequest): Promise<AgentRunResult> {
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();

    return new Promise<AgentRunResult>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(request.command, request.args, {
          cwd: request.cwd,
          env: request.env ?? process.env,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err) {
        reject(err);
        return;
      }

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let canceled = false;
      let settled = false;

      const timer = request.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, request.timeoutMs)
        : undefined;

      const onAbort = () => {
        canceled = true;
        child.kill("SIGKILL");
      };
      if (request.signal) {
        if (request.signal.aborted) onAbort();
        else request.signal.addEventListener("abort", onAbort, { once: true });
      }

      child.stdout?.on("data", (d: Buffer) => {
        const s = d.toString("utf8");
        stdout += s;
        request.onStdout?.(s);
      });
      child.stderr?.on("data", (d: Buffer) => {
        const s = d.toString("utf8");
        stderr += s;
        request.onStderr?.(s);
      });

      const finish = (exitCode: number | null, signalName: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        request.signal?.removeEventListener("abort", onAbort);
        const endedAtMs = Date.now();
        resolve({
          exitCode,
          signal: signalName,
          stdout,
          stderr,
          startedAt,
          endedAt: new Date(endedAtMs).toISOString(),
          durationMs: endedAtMs - startedAtMs,
          timedOut,
          canceled,
        });
      };

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code, signalName) => finish(code, signalName));

      if (request.input !== undefined) {
        child.stdin?.write(request.input);
        child.stdin?.end();
      }
    });
  }
}
