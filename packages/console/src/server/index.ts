import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequestListener, type Handlers } from "./http.js";
import type { Request } from "./mutations.js";
import * as mutations from "./mutations.js";
import * as views from "./read-models.js";
import { assertDirectory } from "./workspace.js";

/**
 * The console server. `node:http` only, bound to 127.0.0.1 only, one random
 * token per process. Every route in `CONSOLE_ROUTES` has a handler here —
 * the `Handlers` type is keyed by the route table, so adding a route to the
 * contract without a handler does not compile — and every mutation handler is
 * a thin call into the library function the CLI command calls.
 */

export const CONSOLE_HOST = "127.0.0.1";

export interface ConsoleServerOptions {
  /** Workspace root: bundles are discovered beneath it and every path stays inside it. */
  root: string;
  /** Per-process token; minted with `mintConsoleToken()` when omitted. */
  token?: string;
  /** Must be 127.0.0.1; anything else refuses to construct. */
  host?: string;
  /** 0 (the default) asks the OS for a free port. */
  port?: number;
  /** Where the built UI lives; defaults to this package's `dist/ui`. */
  uiDir?: string;
  /** Receives one `METHOD /path STATUS Nms` line per request. Never the token. */
  log?: (line: string) => void;
}

export interface ConsoleServer {
  readonly root: string;
  readonly token: string;
  /** `http://127.0.0.1:<port>` — the bound port once listening. */
  readonly url: string;
  readonly port: number;
  listen(): Promise<ConsoleServer>;
  close(): Promise<void>;
}

/** 32 random bytes as hex: 256 bits, well past the contract's 128-bit floor. */
export function mintConsoleToken(): string {
  return randomBytes(32).toString("hex");
}

/** This package's `dist/ui`, whether we run from `dist/` (built) or `src/server/` (vitest). */
function defaultUiDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const packageRoot = here.split(sep).includes("dist")
    ? here.slice(0, here.lastIndexOf(`${sep}dist`))
    : resolve(here, "..", "..");
  return join(packageRoot, "dist", "ui");
}

/** A route parameter the table declares; the matcher never dispatches without it. */
function param(params: Record<string, string>, name: string): string {
  const value = params[name];
  if (value === undefined) throw new Error(`Route parameter '${name}' is missing.`);
  return value;
}

export function createConsoleServer(options: ConsoleServerOptions): ConsoleServer {
  const host = options.host ?? CONSOLE_HOST;
  if (host !== CONSOLE_HOST) {
    throw new Error(
      `The console binds ${CONSOLE_HOST} only; refusing to listen on '${host}'. It carries the reviewer's filesystem authority and must not be reachable from another machine.`,
    );
  }
  const root = resolve(options.root);
  assertDirectory(root);
  const token = options.token ?? mintConsoleToken();
  if (token.length < 32) throw new Error("The console token must carry at least 128 bits.");
  const requestedPort = options.port ?? 0;
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
    throw new Error(`Invalid port: ${options.port}`);
  }
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));

  let boundPort = requestedPort;
  const origin = () => `http://${CONSOLE_HOST}:${boundPort}`;

  const handlers: Handlers = {
    workspace: () => views.workspaceView(root),
    bundle: ({ params }) => views.bundleView(root, param(params, "id")),
    queue: ({ params }) => views.queueView(root, param(params, "id")),
    packs: ({ params }) => views.packsView(root, param(params, "id")),
    benchmark: ({ params }) => views.benchmarkView(root, param(params, "id")),
    drift: ({ params, query }) =>
      views.driftView(root, param(params, "id"), query.get("against") ?? ""),
    // Bodies reach a handler only after `dispatchApi` validated them against the
    // route's own request schema, so each cast names a shape already proven.
    approveOperations: ({ params, body }) =>
      mutations.approveOperations(root, param(params, "id"), body as Request<"approveOperations">),
    approveCapability: ({ params, body }) =>
      mutations.approveCapability(
        root,
        param(params, "id"),
        param(params, "capId"),
        body as Request<"approveCapability">,
      ),
    rejectCapability: ({ params, body }) =>
      mutations.rejectCapability(
        root,
        param(params, "id"),
        param(params, "capId"),
        body as Request<"rejectCapability">,
      ),
    packDecision: ({ params, body }) =>
      mutations.packDecision(
        root,
        param(params, "id"),
        param(params, "hash"),
        body as Request<"packDecision">,
      ),
    applyPack: ({ params, body }) =>
      mutations.applyPack(
        root,
        param(params, "id"),
        param(params, "hash"),
        body as Request<"applyPack">,
      ),
    exportTask: ({ params, body }) =>
      mutations.exportTask(
        root,
        param(params, "id"),
        param(params, "clusterId"),
        body as Request<"exportTask">,
      ),
    importTask: ({ params, body }) =>
      mutations.importTask(root, param(params, "id"), body as Request<"importTask">),
  };

  const server: Server = createServer(
    createRequestListener({
      token,
      origin,
      uiDir: options.uiDir ?? defaultUiDir(),
      handlers,
      log,
    }),
  );

  const handle: ConsoleServer = {
    root,
    token,
    get url() {
      return origin();
    },
    get port() {
      return boundPort;
    },
    listen: () =>
      new Promise((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(requestedPort, CONSOLE_HOST, () => {
          server.off("error", reject);
          const address = server.address();
          if (address && typeof address === "object") boundPort = address.port;
          resolveListen(handle);
        });
      }),
    close: () =>
      new Promise((resolveClose, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolveClose()));
      }),
  };
  return handle;
}
