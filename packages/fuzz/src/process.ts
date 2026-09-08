import { type ChildProcess, spawn } from "node:child_process";

export interface ProcessSpec {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

/** Inherit execution plumbing, never ambient application credentials. */
export function processEnvironment(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "TMPDIR", "TEMP", "TMP", "LANG"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

export function stopProcess(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

/** Argument arrays only. Oversized output aborts instead of truncating into plausible JSON. */
export async function runProcess(
  spec: ProcessSpec,
  input: string,
  signal: AbortSignal,
  limit = 1024 * 1024,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  if (signal.aborted) throw new Error("Process aborted");
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args ?? [], {
      cwd: spec.cwd,
      env: processEnvironment(spec.env),
      detached: process.platform !== "win32",
      // Version probes and compilers may exit before an empty stdin pipe is
      // flushed. Give commands with no input EOF directly, avoiding a spurious
      // EPIPE that would misreport an installed toolchain as unavailable.
      stdio: [input.length ? "pipe" : "ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let failed = false;
    const fail = () => {
      failed = true;
      stopProcess(child);
    };
    signal.addEventListener("abort", fail, { once: true });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > limit) fail();
      else stdout += chunk;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limit) fail();
      else stderr += chunk.toString("utf8");
    });
    child.stdin?.on("error", fail);
    child.on("error", () => {
      signal.removeEventListener("abort", fail);
      reject(new Error("Process could not start"));
    });
    child.on("close", (exitCode) => {
      signal.removeEventListener("abort", fail);
      if (failed || signal.aborted) reject(new Error("Process aborted or output limit exceeded"));
      else resolve({ exitCode, stdout, stderr });
    });
    child.stdin?.end(input);
  });
}
