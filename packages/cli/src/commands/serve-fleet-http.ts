import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import {
  branchyardPrincipal,
  branchyardSessionFingerprint,
  type FleetServer,
  type InboundAuthConfig,
  type InboundClaims,
  isBranchyardConnectToken,
  loadInboundAuthConfig,
  protectedResourceMetadata,
  verifiedPrincipalFingerprint,
  verifyInboundToken,
} from "@anvil/mcp-runtime";
import { type Principal, resolvePrincipalForBearer, withInboundIdentity } from "@anvil/runtime";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { CliIO } from "../io.js";
import { auditSinkFromEnv, buildGatewayRuntime, type GatewayRuntime } from "./gateway.js";
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
 *
 * With `ANVIL_INBOUND_AUTH_MODE=branchyard` this is the Branchyard gateway
 * (ADR-0029, docs/branchyard.md): each session belongs to one turn's token,
 * its principal and grant come from that token's claims, every tool is
 * mounted under its connector id, credentials come from the vault
 * (`ANVIL_VAULT_KEY_FILE`, required), and the listener also serves the
 * connect flow at `/connect/*`.
 */

export interface FleetHttpOptions {
  host: string;
  port: number;
  env?: NodeJS.ProcessEnv;
  io?: CliIO;
  /** Test seams for the connect flow and vault refreshes (the provider's token endpoint). */
  gatewayDeps?: { fetchImpl?: typeof fetch; now?: () => number };
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
      /** Set in branchyard mode: the principal and grant the token names. */
      principal?: Principal;
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
  if (inbound.mode === "branchyard") {
    // The token is the whole caller: its subject, its grant, its turn. It is
    // never threaded on as an inbound identity — the gateway does not forward
    // it upstream (the MCP specification forbids token passthrough).
    const claims = result.claims as InboundClaims;
    if (isBranchyardConnectToken(claims)) {
      // A connect token is for /connect/* only: it never lists or calls tools.
      res.writeHead(403, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            code: "turn_token_required",
            message: "A connect token cannot list or call tools; use the turn's token.",
          },
        }),
      );
      return { ok: false };
    }
    const principal = branchyardPrincipal(claims);
    if (!principal) {
      res.writeHead(401, {
        "content-type": "application/json",
        "www-authenticate": 'Bearer error="invalid_token"',
      });
      res.end(
        JSON.stringify({
          error: { code: "invalid_token", message: "Token does not name a caller and a grant." },
        }),
      );
      return { ok: false };
    }
    return {
      ok: true,
      callerFingerprint: branchyardSessionFingerprint(claims),
      bearer: undefined,
      identity: undefined,
      principal,
    };
  }
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
    inbound = loadInboundAuthConfig(env, { allowBranchyard: true });
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
        "listener must self-enforce inbound auth (oidc, google_service_account, or branchyard), exactly as the deployed server does",
    };
  }
  const audit = auditSinkFromEnv(env, log);
  const prepared = await prepareFleetForWorkspace(workspaceRoot, env, { audit });
  if (!prepared.ok) return { ok: false, message: prepared.message };
  const { config, bundleIds, principalDirectoryConfigured } = prepared;
  let gateway: GatewayRuntime | undefined;
  if (inbound.mode === "branchyard") {
    try {
      gateway = buildGatewayRuntime(
        prepared.connectors,
        env,
        inbound.audience as string,
        options.gatewayDeps,
      );
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  }

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
    if (gateway && url.pathname.startsWith("/connect/")) {
      return handleConnect(req, res, url, inbound, gateway);
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
      const principal = auth.principal
        ? auth.principal
        : auth.identity
          ? prepared.principalFor(auth.identity)
          : principalDirectoryConfigured
            ? resolvePrincipalForBearer(config.principals, auth.bearer)
            : undefined;
      let fleet: FleetServer;
      try {
        fleet = await prepared.build({
          principal,
          ...(gateway ? { gateway: { credentials: gateway.credentials } } : {}),
        });
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

const CONNECT_BODY_MAX_BYTES = 64 * 1024;

function readSmallJson(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (value: Record<string, unknown> | undefined) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    req.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > CONNECT_BODY_MAX_BYTES) {
        req.resume();
        return finish(undefined);
      }
      chunks.push(bytes);
    });
    req.once("end", () => {
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        finish(
          value && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : undefined,
        );
      } catch {
        finish(undefined);
      }
    });
    req.once("error", () => finish(undefined));
  });
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The connect flow's routes (docs/branchyard.md):
 *
 * - `POST /connect/start` `{connector, account?}` with the person's token →
 *   `{kind: "oauth", url, expires_at}` or `{kind: "static", submit}`. The
 *   authorization URL is returned here and nowhere else.
 * - `GET /connect/callback?state&code[&iss]` — the provider's redirect; no
 *   bearer (a browser follows it), bound to the person by `state`.
 * - `POST /connect/api-key` `{connector, account?, api_key}` with the token.
 * - `GET /connect/status` with the token → the person's connections, no secrets.
 *
 * "The token" on every route but the callback is a connect token
 * (`by_purpose: "connect"`, at most ten minutes, minted by `by connect` for
 * the person alone). A turn token — the one a harness holds — is refused 403
 * before the vault is touched, so a prompt-injected harness can neither start
 * a connection nor overwrite the person's stored credential.
 */
async function handleConnect(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  inbound: InboundAuthConfig,
  gateway: GatewayRuntime,
): Promise<void> {
  if (url.pathname === "/connect/callback") {
    if (req.method !== "GET") return json(res, 405, { error: { code: "method_not_allowed" } });
    const q = url.searchParams;
    const outcome = await gateway.connect.callback({
      state: q.get("state") ?? undefined,
      code: q.get("code") ?? undefined,
      iss: q.get("iss") ?? undefined,
      error: q.get("error") ?? undefined,
    });
    res.writeHead(outcome.ok ? 200 : outcome.status, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    });
    res.end(
      outcome.ok
        ? `Connected ${outcome.connector} (account ${outcome.account}). You can close this window.\n`
        : `Not connected: ${outcome.message}\n`,
    );
    return;
  }
  const verified = await verifyInboundToken(req.headers.authorization, inbound);
  if (!verified.ok) {
    res.writeHead(verified.status, {
      "content-type": "application/json",
      "www-authenticate": verified.wwwAuthenticate,
    });
    res.end(JSON.stringify({ error: { code: verified.error, message: verified.description } }));
    return;
  }
  const claims = verified.claims as InboundClaims;
  if (!isBranchyardConnectToken(claims)) {
    req.resume();
    return json(res, 403, {
      error: {
        code: "connect_token_required",
        message:
          'The connect routes take only a connect token (by_purpose "connect"), never a turn token.',
      },
    });
  }
  const sub = claims.sub as string;
  if (url.pathname === "/connect/status" && req.method === "GET") {
    return json(res, 200, { sub, connections: gateway.vault.list(sub) });
  }
  if (req.method !== "POST") {
    return json(res, 404, { error: { code: "not_found", message: "No such route." } });
  }
  const body = await readSmallJson(req);
  if (!body) {
    return json(res, 400, {
      error: { code: "invalid_request", message: "Expected a JSON object." },
    });
  }
  const connector = text(body.connector);
  const account = text(body.account);
  if (!connector) {
    return json(res, 400, { error: { code: "invalid_request", message: "Name a connector." } });
  }
  if (url.pathname === "/connect/start") {
    const started = gateway.connect.start({ sub, connector, ...(account ? { account } : {}) });
    if (!started.ok) {
      return json(res, started.status, { error: { code: started.code, message: started.message } });
    }
    return json(
      res,
      200,
      started.kind === "oauth"
        ? { kind: "oauth", connector, url: started.url, expires_at: started.expiresAt }
        : { kind: "static", connector, submit: started.submit },
    );
  }
  if (url.pathname === "/connect/api-key") {
    const secret = typeof body.api_key === "string" ? body.api_key : "";
    const stored = gateway.connect.putStatic({
      sub,
      connector,
      ...(account ? { account } : {}),
      secret,
    });
    if (!stored.ok) {
      return json(res, stored.status, { error: { code: stored.code, message: stored.message } });
    }
    return json(res, 200, {
      connected: true,
      connector: stored.connector,
      account: stored.account,
    });
  }
  return json(res, 404, { error: { code: "not_found", message: "No such route." } });
}
