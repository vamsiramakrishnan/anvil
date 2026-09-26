import { resolve } from "node:path";
import { loadBundleAir, readBundleDir, resolveBundleDir } from "@anvil/generators";
import {
  JsonlTrace,
  Simulator,
  type SimulatorHttpServer,
  StdioStateProvider,
  serveSimulatorHttp,
  simulatorDefinitionFor,
} from "@anvil/simulator";
import type { Command } from "commander";
import type { CliIO } from "../io.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";

export interface SimulateServeOptions {
  contract?: string;
  providerCmd?: string;
  providerTimeout?: string;
  host?: string;
  port?: string;
  seed?: string;
  capability?: string;
  principal?: string;
  pageSize?: string;
  trace?: string;
}

/**
 * `anvil simulate serve --contract <bundle>`: the simulator over HTTP at the
 * contract's own paths, optionally backed by an out-of-process state provider
 * (docs/simulator-state-providers.md). Prints the bound URL as the first line
 * of stdout and serves until SIGINT/SIGTERM, or until the provider dies.
 */
export function registerSimulateServe(simulate: Command, ctx: CommandContext): void {
  annotate(
    simulate
      .command("serve")
      .summary("Serve the simulator over HTTP at the contract's paths, optionally provider-backed.")
      .description(
        "Serves a bundle's approved operations over HTTP at their declared paths and methods, so a generated SDK (base_url) or the generated MCP server (ANVIL_BASE_URL) can target the simulator. Anvil keeps the surface: auth scopes, required idempotency and replay, injected faults (X-Anvil-Fault), page envelopes, and the contract's error statuses. With --provider-cmd, state and query semantics come from a child process speaking JSON-RPC 2.0 over stdio (see docs/simulator-state-providers.md); without it, the built-in seeded store serves. Prints the bound URL on stdout's first line. With --trace, appends one JSON line per call.",
      )
      .requiredOption("--contract <path>", "generated bundle directory (or its air.yaml)")
      .option(
        "--provider-cmd <command>",
        "shell command that starts a stdio JSON-RPC state provider",
      )
      .option("--provider-timeout <ms>", "per-request provider deadline in milliseconds", "30000")
      .option("--host <host>", "interface to bind", "127.0.0.1")
      .option("--port <port>", "port to bind; 0 picks a free one", "0")
      .option("--seed <n>", "deterministic simulator seed", "1")
      .option("--capability <id>", "serve one discovered capability instead of the whole service")
      .option(
        "--principal <id>",
        "simulated principal for requests that name none (default: one holding every scope)",
      )
      .option("--page-size <n>", "page size when the contract lets Anvil derive none")
      .option("--trace <file>", "append a JSONL call trace to this file")
      .action(async (opts: SimulateServeOptions) => {
        ctx.code = await runSimulateServe(opts, ctx.io);
      }),
    { mutates: false },
  );
}

function nonNegativeInt(value: string | undefined, flag: string, io: CliIO): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    io.err(`anvil: ${flag} expects a non-negative integer, got '${value}'.`);
    return Number.NaN;
  }
  return n;
}

export type SimulateServeStart =
  | { ok: true; http: SimulatorHttpServer; close(): Promise<void>; exited: Promise<string> }
  | { ok: false };

/** Boot the server; the caller decides how long it runs. */
export async function startSimulateServe(
  opts: SimulateServeOptions,
  io: CliIO,
): Promise<SimulateServeStart> {
  const port = nonNegativeInt(opts.port ?? "0", "--port", io);
  const seed = nonNegativeInt(opts.seed ?? "1", "--seed", io);
  const timeoutMs = nonNegativeInt(opts.providerTimeout ?? "30000", "--provider-timeout", io);
  const pageSize = nonNegativeInt(opts.pageSize, "--page-size", io);
  if ([port, seed, timeoutMs, pageSize].some((n) => Number.isNaN(n))) return { ok: false };
  if (!opts.contract) {
    io.err("anvil: --contract is required.");
    return { ok: false };
  }

  let dir: string;
  let air: ReturnType<typeof loadBundleAir>;
  try {
    dir = resolveBundleDir(opts.contract);
    air = loadBundleAir(dir, readBundleDir(dir));
  } catch (err) {
    io.err(`anvil: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false };
  }

  let def: ReturnType<typeof simulatorDefinitionFor>;
  try {
    def = simulatorDefinitionFor(air, {
      seed,
      ...(opts.capability ? { capabilityId: opts.capability } : {}),
    });
    // Validate the capability before spawning anything.
    new Simulator(air, def);
  } catch (err) {
    io.err(`anvil: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false };
  }

  let provider: StdioStateProvider | undefined;
  let exited: Promise<string> = new Promise(() => {});
  if (opts.providerCmd) {
    try {
      provider = await StdioStateProvider.start(
        { command: opts.providerCmd, cwd: process.cwd(), timeoutMs },
        new Simulator(air, def).initializeParams(),
      );
    } catch (err) {
      io.err(`anvil: ${err instanceof Error ? err.message : String(err)}`);
      return { ok: false };
    }
    const started = provider;
    exited = new Promise((resolveExit) => started.onExit((e) => resolveExit(e.message)));
  }

  const trace = opts.trace ? new JsonlTrace(resolve(opts.trace)) : undefined;
  const sim = new Simulator(air, def, {
    ...(provider ? { provider } : {}),
    ...(trace ? { trace } : {}),
    ...(pageSize ? { defaultPageSize: pageSize } : {}),
  });
  const principal =
    opts.principal ??
    sim
      .principals()
      .slice()
      .sort((a, b) => b.scopes.length - a.scopes.length)[0]?.id;
  let http: SimulatorHttpServer;
  try {
    http = await serveSimulatorHttp(sim, air, {
      host: opts.host ?? "127.0.0.1",
      port,
      ...(principal ? { principal } : {}),
      ...(trace ? { trace } : {}),
    });
  } catch (err) {
    await provider?.close();
    io.err(`anvil: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false };
  }
  return {
    ok: true,
    http,
    exited,
    close: async () => {
      await http.close();
      await provider?.close();
    },
  };
}

async function runSimulateServe(opts: SimulateServeOptions, io: CliIO): Promise<number> {
  const started = await startSimulateServe(opts, io);
  if (!started.ok) return 1;
  // The URL alone on stdout's first line, so a parent process can read it.
  io.out(started.http.url);
  const outcome = await new Promise<number>((resolveOutcome) => {
    const stop = () => resolveOutcome(0);
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    started.exited.then((message) => {
      io.err(`anvil: ${message}`);
      resolveOutcome(1);
    });
  });
  await started.close();
  return outcome;
}
