import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import {
  type FleetServer,
  type InboundAuthConfig,
  loadInboundAuthConfig,
  protectedResourceMetadata,
  verifiedPrincipalFingerprint,
  verifyInboundToken,
} from "@anvil/mcp-runtime";
import { resolvePrincipalForBearer, withInboundIdentity } from "@anvil/runtime";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { CliIO } from "../io.js";
import { prepareFleetForWorkspace } from "./serve.js";

/**
 * `anvil serve mcp <workspace> --fleet --http <port> [--host <host>]`: the
 * fleet server over StreamableHTTP, with the SAME inbound-auth enforcement the
 * deployed `runtime/server.js` applies to `/mcp` — `loadInboundAuthConfig`,
 * `verifyInboundToken`, and `verifiedPrincipalFingerprint` are the deployed
 * server's own building blocks (`@anvil/mcp-runtime`'s `inbound-auth.ts`),
 * not a local re-reading of them.
 *
 * Every StreamableHTTP session gets its own fleet composition (an `McpServer`
 * binds to exactly one transport) built from bundles that were discovered,
 * read, and certification-verified ONCE at start (`prepareFleetForWorkspace`).
 * The session's principal is resolved from its bearer token against
 * `ANVIL_PRINCIPALS` — the streamable-http rule docs/fleet.md states — and
 * threaded into every mounted bundle's `ExecuteContext`, so an unlisted token
 * on a configured directory is refused fail-closed by `execute()` exactly as
 * it is over stdio.
 *
 * Binding is loopback unless `--host` says otherwise, and a non-loopback
 * bind with inbound auth "none" is refused: that would hand every mounted
 * tool to the network with no gate at all.
 */

export interface FleetHttpOptions {
  host: string;
  port: number;
  env?: NodeJS.ProcessEnv;
  io?: CliIO;
}

export type FleetHttpHandle = {
  host: string;
  port: number;
  bundleIds: string[];
  close(): Promise<void>;
};

export type FleetHttpResult =
  | { ok: true; handle: FleetHttpHandle }
  | { ok: false; message: string };

const MCP_REQUEST_MAX_BYTES = 1024 * 1024;
const SESSION_IDLE_TTL_MS = 15 * 60 * 1000;
const SESSION_SWEEP_MS = 60 * 1000;
const MAX_SESSIONS = 100;

/** True for the loopback names/addresses a local fleet is meant to bind. */
export function isLoopbackHost(host: string): boolean {
  if (host === "localhost") return true;
  const family = isIP(host);
  if (family === 4) return host.startsWith("127.");
  if (family === 6) return host === "::1" || host === "0:0:0:0:0:0:0:1";
  return false;
}

interface Session {
  fleet: FleetServer;
  transport: StreamableHTTPServerTransport;
  callerFingerprint: string;
  sessionId: string | undefined;
  activeRequests: number;
  lastUsedAt: number;
  closing: Promise<void> | undefined;
}

type Authorized =
  | { ok: false }
  | {
      ok: true;
      callerFingerprint: string;
      bearer: string | undefined;
      identity: Parameters<typeof withInboundIdentity>[0] | undefined;
    };

async function authorize(
  req: IncomingMessage,
  res: ServerResponse,
  inbound: InboundAuthConfig,
): Promise<Authorized> {
  const header = req.headers.authorization;
  const result = await verifyInboundToken(header, inbound);
  if (!result.ok) {
    res.writeHead(result.status, {
      "content-type": "application/json",
      "www-authenticate": result.wwwAuthenticate,
    });
    res.end(JSON.stringify({ error: { code: result.error, message: result.description } }));
    return { ok: false };
  }
  const bearer =
    typeof header === "string" ? header.replace(/^Bearer\s+/i, "").trim() || undefined : undefined;
  if (inbound.mode === "none")
    return { ok: true, callerFingerprint: "anonymous", bearer, identity: undefined };
  const callerFingerprint = bearer ? verifiedPrincipalFingerprint(result.claims) : undefined;
  if (!callerFingerprint || !bearer) {
    res.writeHead(401, {
      "content-type": "application/json",
      "www-authenticate": 'Bearer error="invalid_token"',
    });
    res.end(
      JSON.stringify({
        error: {
          code: "invalid_token",
          message: "Verified token does not identify a stable caller principal.",
        },
      }),
    );
    return { ok: false };
  }
  const claims = (result.claims ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    callerFingerprint,
    bearer,
    identity: {
      subjectToken: bearer,
      subjectTokenType: bearer.split(".").length === 3 ? "jwt" : "access_token",
      sub: claims.sub as string | undefined,
      email: claims.email as string | undefined,
      scope: claims.scope as string | undefined,
      claims,
    },
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function jsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  json(res, status, { jsonrpc: "2.0", error: { code, message }, id: null });
}

function readJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const declared = req.headers["content-length"];
  if (
    typeof declared === "string" &&
    /^\d+$/.test(declared) &&
    Number(declared) > MCP_REQUEST_MAX_BYTES
  ) {
    req.resume();
    jsonRpcError(res, 413, -32600, "MCP request body exceeds the size limit.");
    return Promise.resolve({ ok: false });
  }
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;
    const finish = (value: { ok: true; value: unknown } | { ok: false }) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const reject = (status: number, message: string) => {
      if (!res.headersSent) jsonRpcError(res, status, -32600, message);
      req.once("error", () => {});
      req.resume();
      finish({ ok: false });
    };
    req.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += bytes.length;
      if (received > MCP_REQUEST_MAX_BYTES)
        return reject(413, "MCP request body exceeds the size limit.");
      chunks.push(bytes);
    });
    req.once("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) return reject(400, "MCP request body must contain JSON.");
      try {
        finish({ ok: true, value: JSON.parse(raw) });
      } catch {
        reject(400, "MCP request body is malformed JSON.");
      }
    });
    req.once("aborted", () => reject(400, "MCP request body was aborted."));
    req.once("error", () => reject(400, "MCP request body could not be read."));
  });
}

/**
 * Start the fleet over StreamableHTTP. Resolves once the listener is bound;
 * the returned handle closes every session, the probe fleet, and the listener.
 */
export async function startFleetHttp(
  workspaceRoot: string,
  options: FleetHttpOptions,
): Promise<FleetHttpResult> {
  const env = options.env ?? process.env;
  const log = (line: string) => (options.io ? options.io.err(line) : console.error(line));
  let inbound: InboundAuthConfig;
  try {
    inbound = loadInboundAuthConfig(env);
  } catch (error) {
    // An incomplete ANVIL_INBOUND_* family is a refusal before any port is
    // bound, exactly as the deployed server refuses its boot.
    return { ok: false, message: (error as Error).message };
  }
  if (!isLoopbackHost(options.host) && inbound.mode === "none") {
    return {
      ok: false,
      message:
        `refusing to bind the fleet to ${options.host} with ANVIL_INBOUND_AUTH_MODE unset: a non-loopback ` +
        "listener must self-enforce inbound auth (oidc or google_service_account), exactly as the deployed server does",
    };
  }
  const prepared = await prepareFleetForWorkspace(workspaceRoot, env);
  if (!prepared.ok) return { ok: false, message: prepared.message };
  const { config, bundleIds, principalDirectoryConfigured } = prepared;

  // One composition built up front: it surfaces a cross-bundle collision
  // before the port is bound, and it answers /readyz for the whole fleet.
  let probe: FleetServer;
  try {
    probe = await prepared.build({ principal: undefined });
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
  const resourceMetadata = protectedResourceMetadata(inbound);

  const sessions = new Map<string, Session>();
  const live = new Set<Session>();
  let shuttingDown = false;

  const forget = (session: Session) => {
    live.delete(session);
    if (session.sessionId && sessions.get(session.sessionId) === session) {
      sessions.delete(session.sessionId);
    }
  };
  const closeSession = (session: Session): Promise<void> => {
    if (session.closing) return session.closing;
    forget(session);
    session.closing = session.fleet.server
      .close()
      .catch(() => {})
      .then(() => session.fleet.close())
      .catch(() => {});
    return session.closing;
  };
  const pruneIdle = (now = Date.now()) => {
    for (const session of sessions.values()) {
      if (session.activeRequests === 0 && now - session.lastUsedAt >= SESSION_IDLE_TTL_MS) {
        void closeSession(session);
      }
    }
  };
  const sweep = setInterval(() => pruneIdle(), SESSION_SWEEP_MS);
  sweep.unref();

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/healthz") {
      return json(res, 200, { status: "ok", fleet: true, bundles: bundleIds.length });
    }
    if (url.pathname === "/readyz") {
      const body = probe.readyz();
      return json(res, body.ready ? 200 : 503, body);
    }
    if (url.pathname === "/.well-known/oauth-protected-resource") {
      return resourceMetadata
        ? json(res, 200, resourceMetadata)
        : json(res, 404, {
            error: { code: "not_found", message: "Inbound auth is not configured." },
          });
    }
    if (url.pathname !== "/mcp") {
      return json(res, 404, { error: { code: "not_found", message: "No such route." } });
    }
    if (shuttingDown) return jsonRpcError(res, 503, -32000, "Server is shutting down.");
    const auth = await authorize(req, res, inbound);
    if (!auth.ok) return;

    let body: unknown;
    if (req.method === "POST") {
      const mediaType = String(req.headers["content-type"] ?? "")
        .split(";", 1)[0]
        ?.trim()
        .toLowerCase();
      if (mediaType !== "application/json") {
        req.resume();
        return jsonRpcError(res, 415, -32600, "Content-Type must be application/json.");
      }
      const parsed = await readJsonBody(req, res);
      if (!parsed.ok) return;
      body = parsed.value;
    }
    const sidHeader = req.headers["mcp-session-id"];
    const sid = typeof sidHeader === "string" ? sidHeader : undefined;
    let session = sid ? sessions.get(sid) : undefined;
    if (session && session.callerFingerprint !== auth.callerFingerprint) {
      return jsonRpcError(
        res,
        403,
        -32001,
        "This MCP session belongs to a different authenticated caller.",
      );
    }
    if (!session) {
      if (!(req.method === "POST" && isInitializeRequest(body))) {
        return jsonRpcError(res, 400, -32000, "No valid session; send initialize first.");
      }
      pruneIdle();
      if (sessions.size >= MAX_SESSIONS) {
        return jsonRpcError(res, 503, -32000, "MCP session capacity is temporarily exhausted.");
      }
      // The session's principal, resolved by the composition root exactly as
      // the deployed HTTP server resolves it: the verified inbound identity
      // when inbound auth produced one (bearer, then issuer:subject, subject,
      // email), else the bearer alone. Unconfigured directory → undefined →
      // execute()'s anonymous default; configured directory + an unnamed
      // caller → undefined + directoryConfigured → execute() refuses
      // fail-closed (policy/principal_unresolved).
      const principal = auth.identity
        ? prepared.principalFor(auth.identity)
        : principalDirectoryConfigured
          ? resolvePrincipalForBearer(config.principals, auth.bearer)
          : undefined;
      let fleet: FleetServer;
      try {
        fleet = await prepared.build({ principal });
      } catch {
        return jsonRpcError(res, 500, -32603, "MCP session initialization failed.");
      }
      let created: Session | undefined;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          if (!created) return;
          created.sessionId = id;
          sessions.set(id, created);
        },
      });
      transport.onclose = () => {
        if (created) forget(created);
      };
      created = {
        fleet,
        transport,
        callerFingerprint: auth.callerFingerprint,
        sessionId: undefined,
        activeRequests: 0,
        lastUsedAt: Date.now(),
        closing: undefined,
      };
      session = created;
      live.add(session);
      try {
        await fleet.server.connect(transport);
      } catch {
        await closeSession(session);
        return jsonRpcError(res, 500, -32603, "MCP session initialization failed.");
      }
    }
    const current = session;
    current.activeRequests += 1;
    current.lastUsedAt = Date.now();
    try {
      await (auth.identity
        ? withInboundIdentity(auth.identity, () => current.transport.handleRequest(req, res, body))
        : current.transport.handleRequest(req, res, body));
    } catch {
      if (!res.headersSent) return jsonRpcError(res, 500, -32603, "MCP request handling failed.");
      res.destroy();
    } finally {
      current.activeRequests = Math.max(0, current.activeRequests - 1);
      current.lastUsedAt = Date.now();
      if (current.sessionId === undefined) await closeSession(current);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  log(
    `anvil: serving fleet of ${bundleIds.length} bundle(s) over StreamableHTTP at http://${options.host}:${port}/mcp ` +
      `(${bundleIds.join(", ")}); inbound auth ${inbound.mode}; /readyz and /healthz on the same listener`,
  );

  const close = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(sweep);
    await Promise.allSettled([...live].map((session) => closeSession(session)));
    await probe.close();
    server.closeIdleConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections?.();
  };
  return { ok: true, handle: { host: options.host, port, bundleIds, close } };
}
