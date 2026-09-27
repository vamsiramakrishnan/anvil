/**
 * A `StateProvider` that lives in another process and speaks JSON-RPC 2.0 over
 * its stdin/stdout, one message per line. The wire protocol is specified in
 * docs/simulator-state-providers.md so a provider can be written in any
 * language without reading this file.
 */
import { type ChildProcess, spawn } from "node:child_process";
import {
  PROVIDER_PROTOCOL_VERSION,
  type ProviderInitializeParams,
  type ProviderRequest,
  type ProviderResponse,
  type StateProvider,
} from "./provider.js";

export interface StdioProviderOptions {
  /** A shell command line that starts the provider, e.g. `python -m my_provider`. */
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Per-request deadline in milliseconds (default 30000). `initialize` gets the same. */
  timeoutMs?: number;
  /** Forward the child's stderr to this process's stderr (default true). */
  forwardStderr?: boolean;
}

/** The provider did not answer a request in time. */
export class ProviderTimeoutError extends Error {
  override name = "ProviderTimeoutError";
}

/** The provider process is gone; every pending and later request fails with this. */
export class ProviderExitedError extends Error {
  override name = "ProviderExitedError";
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const STDERR_TAIL_BYTES = 2048;
const SHUTDOWN_GRACE_MS = 2000;

export class StdioStateProvider implements StateProvider {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buffer = "";
  private stderrTail = "";
  private exitError: ProviderExitedError | undefined;
  private readonly exitListeners: Array<(error: ProviderExitedError) => void> = [];
  private closing = false;
  private readonly timeoutMs: number;

  private constructor(
    private readonly child: ChildProcess,
    options: StdioProviderOptions,
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.onData(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
      if (options.forwardStderr !== false) process.stderr.write(chunk);
    });
    // A write to a dead child's stdin surfaces here; the exit handler reports it.
    child.stdin?.on("error", () => {});
    child.on("error", (err) => this.fail(`could not start '${options.command}': ${err.message}`));
    child.on("exit", (code, signal) => {
      if (this.closing && this.pending.size === 0) {
        this.exitError = new ProviderExitedError("State provider was shut down.");
        return;
      }
      const how = signal ? `signal ${signal}` : `exit code ${code}`;
      const tail = this.stderrTail.trim();
      this.fail(`State provider exited (${how}).${tail ? ` Last stderr: ${tail}` : ""}`);
    });
  }

  /** Spawn the provider and complete the `initialize` handshake. */
  static async start(
    options: StdioProviderOptions,
    params: ProviderInitializeParams,
  ): Promise<StdioStateProvider> {
    const child = spawn(options.command, {
      shell: true,
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const provider = new StdioStateProvider(child, options);
    try {
      const result = await provider.request("initialize", params);
      const version =
        typeof result === "object" && result !== null
          ? (result as { protocolVersion?: unknown }).protocolVersion
          : undefined;
      if (version !== PROVIDER_PROTOCOL_VERSION) {
        throw new Error(
          `State provider speaks protocol ${String(version)}; this simulator speaks ${PROVIDER_PROTOCOL_VERSION}.`,
        );
      }
    } catch (err) {
      await provider.close();
      throw err;
    }
    return provider;
  }

  async invoke(request: ProviderRequest): Promise<ProviderResponse> {
    return (await this.request("invoke", request)) as ProviderResponse;
  }

  /** Called once if the provider dies while the simulator still needs it. */
  onExit(listener: (error: ProviderExitedError) => void): void {
    this.exitListeners.push(listener);
  }

  /** Send `shutdown`, then end stdin; escalate to SIGTERM/SIGKILL if the child lingers. */
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    if (this.exitError || this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
    try {
      await this.request("shutdown", {}, SHUTDOWN_GRACE_MS);
    } catch {
      // A provider that ignores shutdown is still stopped below.
    }
    this.child.stdin?.end();
    const timer = setTimeout(() => this.child.kill("SIGTERM"), SHUTDOWN_GRACE_MS);
    const hard = setTimeout(() => this.child.kill("SIGKILL"), SHUTDOWN_GRACE_MS * 2);
    await exited;
    clearTimeout(timer);
    clearTimeout(hard);
  }

  private request(method: string, params: unknown, timeoutMs = this.timeoutMs): Promise<unknown> {
    if (this.exitError) return Promise.reject(this.exitError);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new ProviderTimeoutError(
            `State provider did not answer '${method}' (id ${id}) within ${timeoutMs} ms.`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line !== "") this.onLine(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private onLine(line: string): void {
    let message: { id?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } };
    try {
      message = JSON.parse(line);
    } catch {
      process.stderr.write(
        `anvil: ignoring non-JSON line from state provider: ${line.slice(0, 200)}\n`,
      );
      return;
    }
    if (typeof message?.id !== "number") return; // notifications are not part of the protocol
    const pending = this.pending.get(message.id);
    if (!pending) return; // a late answer to a request that already timed out
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(
        new Error(
          `State provider returned JSON-RPC error ${String(message.error.code)}: ${String(message.error.message)}`,
        ),
      );
    } else {
      pending.resolve(message.result);
    }
  }

  private fail(message: string): void {
    if (this.exitError) return;
    const error = new ProviderExitedError(message);
    this.exitError = error;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    if (!this.closing) for (const listener of this.exitListeners) listener(error);
  }
}
