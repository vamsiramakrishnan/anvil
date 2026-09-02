import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { type ConsoleServer, createConsoleServer } from "@anvil/console";
import type { Command } from "commander";
import { emitRefusal } from "../envelope.js";
import type { CliIO } from "../io.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";

/**
 * `anvil console [path]` — launch the local review console. A thin launcher:
 * the server, its security posture, and every read model and mutation live in
 * `@anvil/console`; this command resolves the workspace root, starts the
 * server on 127.0.0.1, prints where it is, and keeps serving until Ctrl+C.
 *
 * The per-process token is injected into the served page only. It is never
 * printed, never placed in the URL, and never logged — the URL an operator
 * pastes into a browser (or a chat) carries nothing that could drive an
 * approval.
 */
export function registerConsole(parent: Command, ctx: CommandContext): void {
  annotate(
    parent
      .command("console")
      .summary("Open the local review console over a workspace of compiled bundles.")
      .description(
        "Serves a browser page on 127.0.0.1 that projects every bundle beneath the workspace root — the decision queue, the inspector, packs, benchmark confusion, and drift — and lets a reviewer approve operations, approve or reject capabilities, record and apply pack decisions, and export or import harness tasks. Every decision calls the same library function the CLI command calls and produces the same receipt: `anvil approve`, `anvil capability approve|reject`, `anvil refine approve|reject|apply-pack|export-task|import-proposal`. Mutations require a per-process token the served page carries and a same-origin request; nothing outside the workspace root is read or written.",
      )
      .argument(
        "[path]",
        "workspace root or a single bundle directory (default: the current directory)",
      )
      .option("--port <n>", "port on 127.0.0.1 (default: a free port)", parsePort)
      .option("--open", "open the console in the default browser")
      .option("--json", "print one { url, port, root } document, then keep serving")
      .action(async (path: string | undefined, opts: ConsoleOptions) => {
        ctx.code = await runConsole(path, opts, ctx);
      }),
    { mutates: true },
  );
}

interface ConsoleOptions {
  port?: number;
  open?: boolean;
  json?: boolean;
}

const CONSOLE_REPORT = "anvil.console";
const CONSOLE_ERROR = "anvil.console-error";

/** Commander's option parser: a port number, or NaN so the refusal below names it. */
function parsePort(value: string): number {
  return /^\d{1,5}$/.test(value) ? Number(value) : Number.NaN;
}

async function runConsole(
  path: string | undefined,
  opts: ConsoleOptions,
  ctx: CommandContext,
): Promise<number> {
  const io = ctx.io;
  const root = resolve(path ?? process.cwd());
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return emitRefusal(io, opts.json, {
      reportType: CONSOLE_ERROR,
      code: "console/root_not_found",
      message: `No such workspace directory: ${root}.`,
    });
  }
  if (opts.port !== undefined && !(Number.isInteger(opts.port) && opts.port <= 65535)) {
    return emitRefusal(io, opts.json, {
      reportType: CONSOLE_ERROR,
      code: "console/invalid_port",
      message: "--port must be an integer between 0 and 65535.",
    });
  }

  let server: ConsoleServer;
  try {
    server = await createConsoleServer({
      root,
      port: opts.port ?? 0,
      log: (line) => io.err(line),
    }).listen();
  } catch (error) {
    return emitRefusal(io, opts.json, {
      reportType: CONSOLE_ERROR,
      code: "console/listen_failed",
      message: `The console could not start: ${(error as Error).message}`,
    });
  }

  const stop = (): void => {
    void handle.close();
  };
  const handle: ConsoleServer = {
    ...server,
    close: async () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      await server.close();
    },
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  if (opts.json === true) {
    io.out(
      JSON.stringify(
        {
          schemaVersion: 1,
          reportType: CONSOLE_REPORT,
          url: server.url,
          port: server.port,
          root: server.root,
        },
        null,
        2,
      ),
    );
  } else {
    io.out(`anvil console: reviewing ${server.root}`);
    io.out(`  open ${server.url} (Ctrl+C to stop)`);
  }
  if (opts.open === true) openBrowser(server.url, io);
  ctx.deps.onConsoleServer?.(handle);
  return 0;
}

/** Open the default browser through the platform's own opener; failure is a note, never an error. */
function openBrowser(url: string, io: CliIO): void {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () =>
      io.err(`  (could not open a browser with ${command}; open the URL yourself)`),
    );
    child.unref();
  } catch {
    io.err(`  (could not open a browser with ${command}; open the URL yourself)`);
  }
}
