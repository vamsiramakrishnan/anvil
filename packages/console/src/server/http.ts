import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, relative, resolve, sep } from "node:path";
import type { z } from "zod";
import { CONSOLE_ROUTES, type ConsoleRoute } from "../contract.js";
import { ConsoleError, forbidden, invalidRequest, notFound, toConsoleError } from "./errors.js";

/**
 * The HTTP layer: the security gate the contract's SECURITY block specifies,
 * the route table read from `CONSOLE_ROUTES` (so a route the contract adds
 * without a handler is a compile error in `Handlers`, never a silent 404),
 * JSON bodies with a size cap, and static serving of the built UI with the
 * per-process token injected into the page.
 *
 * Order of checks on a non-GET request — each one closes before the next
 * opens, and the body is not read until all have passed:
 *   token → origin → Sec-Fetch-Site → route → content-type → size → JSON → schema.
 */

const MAX_BODY_BYTES = 1024 * 1024;
/** How long a refused connection stays open so the refusal reaches the peer before the reset. */
const UNREAD_REFUSAL_GRACE_MS = 250;
const TOKEN_HEADER = "x-anvil-console-token";
const TOKEN_META = "anvil-console-token";

export type Handlers = {
  [R in ConsoleRoute]: (input: {
    params: Record<string, string>;
    query: URLSearchParams;
    /** The validated request body (mutating routes) or `undefined`. */
    body: unknown;
  }) => unknown | Promise<unknown>;
};

export interface ListenerOptions {
  token: string;
  /** The server's own origin, known once it is listening. */
  origin: () => string;
  uiDir: string;
  handlers: Handlers;
  log: (line: string) => void;
}

interface CompiledRoute {
  key: ConsoleRoute;
  method: string;
  segments: string[];
}

const ROUTES: CompiledRoute[] = (Object.keys(CONSOLE_ROUTES) as ConsoleRoute[]).map((key) => ({
  key,
  method: CONSOLE_ROUTES[key].method,
  segments: CONSOLE_ROUTES[key].path.split("/").slice(1),
}));

function matchRoute(
  method: string,
  pathname: string,
): { key: ConsoleRoute; params: Record<string, string> } | undefined {
  const actual = pathname.split("/").slice(1);
  for (const route of ROUTES) {
    if (route.method !== method || route.segments.length !== actual.length) continue;
    const params: Record<string, string> = {};
    let matched = true;
    for (let i = 0; i < route.segments.length; i++) {
      const expected = route.segments[i] as string;
      const given = actual[i] as string;
      if (expected.startsWith(":")) {
        try {
          params[expected.slice(1)] = decodeURIComponent(given);
        } catch {
          matched = false;
          break;
        }
      } else if (expected !== given) {
        matched = false;
        break;
      }
    }
    if (matched) return { key: route.key, params };
  }
  return undefined;
}

function tokenMatches(expected: string, given: string | string[] | undefined): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(given, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === "string" ? value : undefined;
}

/** The mutation-protection gate: throws `console/forbidden` on the first failed check. */
function assertMutationAllowed(req: IncomingMessage, opts: ListenerOptions): void {
  if (!tokenMatches(opts.token, req.headers[TOKEN_HEADER])) throw forbidden();
  if (header(req, "origin") !== opts.origin()) throw forbidden();
  const site = header(req, "sec-fetch-site");
  if (site !== undefined && site !== "same-origin" && site !== "none") throw forbidden();
}

function mediaType(req: IncomingMessage): string {
  return (header(req, "content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

/** Whether the request body was read to its end; a refusal issued before that closes the connection. */
interface BodyState {
  consumed: boolean;
}

function readJsonBody(req: IncomingMessage, state: BodyState): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const declared = Number(header(req, "content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      reject(tooLarge());
      return;
    }
    const chunks: Buffer[] = [];
    let received = 0;
    const onData = (chunk: Buffer): void => {
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        // Stop reading; the refusal path closes the connection behind the response.
        req.off("data", onData);
        req.pause();
        reject(tooLarge());
        return;
      }
      chunks.push(chunk);
    };
    req.on("data", onData);
    req.on("error", (error) => reject(toConsoleError(error)));
    req.on("end", () => {
      state.consumed = true;
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(
          new ConsoleError("console/invalid_json", 400, "The request body is not valid JSON.", {
            issues: [(error as Error).message],
          }),
        );
      }
    });
  });
}

function tooLarge(): ConsoleError {
  return new ConsoleError(
    "console/payload_too_large",
    413,
    `Request bodies are capped at ${MAX_BODY_BYTES} bytes.`,
  );
}

function validate(schema: z.ZodType, value: unknown, what: string): unknown {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw invalidRequest(
    `The ${what} does not match the console contract.`,
    result.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`),
  );
}

/* ------------------------------- responses -------------------------------- */

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

/**
 * A refusal issued BEFORE the body was read. The connection is closed once the
 * response has flushed so the unread body is never drained into the process —
 * a 10 MiB body behind a missing token costs the server nothing.
 */
function sendUnreadRefusal(req: IncomingMessage, res: ServerResponse, error: ConsoleError): void {
  const body = `${JSON.stringify(error.toEnvelope())}\n`;
  res.writeHead(error.status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    connection: "close",
  });
  res.end(body, () => {
    // Destroying the socket the instant the refusal flushes sends a TCP reset
    // while the client is still streaming, and a reset discards response bytes
    // the peer has not read yet — the client sees nothing at all instead of a
    // 413. A short grace lets the status line reach the peer; the unread body
    // meanwhile sits in the kernel's bounded receive buffer, never in this
    // process, and the destroy still closes the connection behind it.
    const grace = setTimeout(() => req.destroy(), UNREAD_REFUSAL_GRACE_MS);
    grace.unref();
  });
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
};

function injectToken(html: string, token: string): string {
  const meta = `<meta name="${TOKEN_META}" content="${token}">`;
  return html.includes("<head>") ? html.replace("<head>", `<head>${meta}`) : `${meta}${html}`;
}

function unbuiltPage(): string {
  const routes = Object.values(CONSOLE_ROUTES)
    .map((route) => `<li><code>${route.method} ${route.path}</code></li>`)
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>anvil console</title></head><body><h1>anvil console</h1><p>The console UI is not built (no <code>dist/ui</code> in @anvil/console). The API is serving:</p><ul>${routes}</ul></body></html>`;
}

/** Serve one file from the UI directory, resolved inside it only; anything else is 404. */
function serveStatic(pathname: string, res: ServerResponse, opts: ListenerOptions): void {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw notFound("No such file.");
  }
  if (decoded.includes("\0") || decoded.split("/").some((segment) => segment === "..")) {
    throw notFound("No such file.");
  }
  const rel = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const indexPage = rel === "index.html";
  const uiRoot = resolve(opts.uiDir);
  const file = resolve(uiRoot, rel);
  const inside = relative(uiRoot, file);
  if (inside === "" || inside.startsWith(`..${sep}`) || inside === ".." || inside.includes("\0")) {
    throw notFound("No such file.");
  }
  if (!existsSync(file) || !statSync(file).isFile()) {
    if (indexPage) {
      const page = injectToken(unbuiltPage(), opts.token);
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": Buffer.byteLength(page),
        "cache-control": "no-store",
      });
      res.end(page);
      return;
    }
    throw notFound("No such file.");
  }
  const type = CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
  const contents = readFileSync(file);
  const body = indexPage
    ? Buffer.from(injectToken(contents.toString("utf8"), opts.token))
    : contents;
  res.writeHead(200, {
    "content-type": type,
    "content-length": body.length,
    "cache-control": "no-store",
  });
  res.end(body);
}

/* -------------------------------- dispatch -------------------------------- */

async function dispatchApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  opts: ListenerOptions,
  body: BodyState,
): Promise<void> {
  const method = req.method ?? "GET";
  const match = matchRoute(method, url.pathname);
  if (!match) throw notFound(`No route ${method} ${url.pathname}.`);
  const route = CONSOLE_ROUTES[match.key];
  let parsed: unknown;
  if (route.mutates) {
    if (mediaType(req) !== "application/json") {
      throw new ConsoleError(
        "console/unsupported_media_type",
        415,
        "Request bodies must be application/json.",
      );
    }
    parsed = validate(route.request, await readJsonBody(req, body), "request body");
  }
  if ("query" in route) {
    validate(route.query, Object.fromEntries(url.searchParams), "query string");
  }
  const value = await opts.handlers[match.key]({
    params: match.params,
    query: url.searchParams,
    body: parsed,
  });
  sendJson(res, 200, value);
}

/** The `node:http` request listener: security gate, API dispatch, static UI. */
export function createRequestListener(
  opts: ListenerOptions,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const started = Date.now();
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    res.on("finish", () => {
      opts.log(`${method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
    });
    // A GET carries no body to consume; a non-GET's body counts as consumed
    // only once `readJsonBody` has read it to its end.
    const body: BodyState = { consumed: method === "GET" };
    const run = async (): Promise<void> => {
      if (method !== "GET") {
        assertMutationAllowed(req, opts);
        await dispatchApi(req, res, url, opts, body);
        return;
      }
      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
        await dispatchApi(req, res, url, opts, body);
        return;
      }
      serveStatic(url.pathname, res, opts);
    };

    run().catch((error: unknown) => {
      const consoleError = toConsoleError(error);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      // A refusal issued before the body was read to its end answers and then
      // closes the connection, so the unread remainder is never drained.
      if (body.consumed) sendJson(res, consoleError.status, consoleError.toEnvelope());
      else sendUnreadRefusal(req, res, consoleError);
    });
  };
}
