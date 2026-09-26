/**
 * Serve a simulator over HTTP at the contract's own paths and methods, so any
 * HTTP client of the real API (a generated SDK, the generated MCP server with
 * its base URL pointed here, curl) can drive it unchanged.
 *
 * This layer only translates. Routing picks the operation, the wire request is
 * lifted back into the agent-keyed input every other surface uses, and the
 * simulator's result is written back in the contract's envelope and error
 * shape. Every gate, replay and fault decision stays in `Simulator.call`.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type AirDocument,
  agentPropKey,
  type JsonSchema,
  type Operation,
  type Param,
  resolveIdempotencyCarrier,
} from "@anvil/air";
import { servesItems } from "./provider.js";
import { declaredResponse, type InvokeContext, type Simulator } from "./runtime.js";
import { TRACE_SCHEMA, type TraceSink } from "./trace.js";

export interface SimulatorHttpOptions {
  /** Interface to bind (default 127.0.0.1). */
  host?: string;
  /** Port to bind; 0 picks a free one (default 0). */
  port?: number;
  /** Principal for requests that name none (see `principalFor`). */
  principal?: string;
  trace?: TraceSink;
}

export interface SimulatorHttpServer {
  url: string;
  server: Server;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 16 * 1024 * 1024;

interface Route {
  op: Operation;
  method: string;
  pattern: RegExp;
  names: string[];
  /** Literal segments: a more literal template wins over a more general one. */
  literals: number;
}

function compileRoute(op: Operation): Route | undefined {
  const path = op.sourceRef.path;
  if (!path || !op.sourceRef.method) return undefined;
  const names: string[] = [];
  let literals = 0;
  const source = path
    .split("/")
    .map((segment) => {
      if (!segment.includes("{")) {
        if (segment !== "") literals += 1;
        return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      }
      return segment.replace(/\{([^}]+)\}|([^{]+)/g, (_m, name: string | undefined, lit) => {
        if (name === undefined) return String(lit).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        names.push(name);
        return "([^/]+)";
      });
    })
    .join("/");
  return {
    op,
    method: op.sourceRef.method.toUpperCase(),
    pattern: new RegExp(`^${source}/?$`),
    names,
    literals,
  };
}

/** Coerce one query or header string to what the parameter's schema declares. */
function coerce(schema: JsonSchema | undefined, values: string[]): unknown {
  const type = schema?.type;
  const one = (raw: string, t: unknown): unknown => {
    if (t === "integer" || t === "number") {
      const n = Number(raw);
      return Number.isFinite(n) ? n : raw;
    }
    if (t === "boolean") return raw === "true" ? true : raw === "false" ? false : raw;
    return raw;
  };
  if (type === "array") {
    const items = (schema?.items ?? {}) as JsonSchema;
    const parts = values.length === 1 ? (values[0] ?? "").split(",") : values;
    return parts.map((v) => one(v, items.type));
  }
  return one(values[values.length - 1] ?? "", type);
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let cursor = target;
  for (const key of keys.slice(0, -1)) {
    const next = cursor[key];
    if (typeof next !== "object" || next === null || Array.isArray(next)) cursor[key] = {};
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[keys[keys.length - 1] as string] = value;
}

function getPath(source: unknown, path: string[]): unknown {
  let cursor = source;
  for (const key of path) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

/** The first array-valued property of a declared envelope, in declared order. */
function firstArrayField(schema: JsonSchema | undefined): string | undefined {
  const props = schema?.properties;
  if (typeof props !== "object" || props === null) return undefined;
  for (const [name, prop] of Object.entries(props as Record<string, JsonSchema>)) {
    if (prop && (prop.type === "array" || typeof prop.items === "object")) return name;
  }
  return undefined;
}

/**
 * Write a page of items in the envelope the contract declares: a bare array
 * when the response is an array, else the items at `itemsField` (or the first
 * declared array property) and the continuation at `nextField`. A `link`
 * pagination style gets a URL carrying the cursor, as such APIs serve.
 */
function envelope(
  air: AirDocument,
  op: Operation,
  items: unknown[],
  nextCursor: string | undefined,
  url: URL,
): { body: unknown; headers: Record<string, string> } {
  const declared = declaredResponse(air, op);
  const pagination = op.pagination;
  let next: string | undefined = nextCursor;
  if (nextCursor !== undefined && pagination?.style === "link" && pagination.cursorParam) {
    const link = new URL(url.toString());
    link.searchParams.set(pagination.cursorParam, nextCursor);
    next = link.toString();
  }
  if (declared?.type === "array") {
    return { body: items, headers: next ? { link: `<${next}>; rel="next"` } : {} };
  }
  const body: Record<string, unknown> = {};
  setPath(body, pagination?.itemsField ?? firstArrayField(declared) ?? "items", items);
  if (next !== undefined) setPath(body, pagination?.nextField ?? "next_cursor", next);
  return { body, headers: {} };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name.toLowerCase()];
  return Array.isArray(raw) ? raw[raw.length - 1] : raw;
}

export async function serveSimulatorHttp(
  sim: Simulator,
  air: AirDocument,
  options: SimulatorHttpOptions = {},
): Promise<SimulatorHttpServer> {
  const routes = sim
    .operations()
    .map(compileRoute)
    .filter((r): r is Route => r !== undefined)
    .sort((a, b) => b.literals - a.literals);
  const profiles = new Set(sim.principals().map((p) => p.id));

  const principalFor = (req: IncomingMessage): string | undefined => {
    const named = headerValue(req, "x-anvil-principal");
    if (named) return named;
    const auth = headerValue(req, "authorization");
    const token = auth?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    if (token && profiles.has(token)) return token;
    return options.principal;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = (req.method ?? "GET").toUpperCase();
    const url = new URL(req.url ?? "/", "http://simulator.local");
    let text: string;
    try {
      text = await readBody(req);
    } catch {
      return send(res, 413, { error: { code: "validation_error", message: "Body too large." } });
    }
    let body: unknown;
    if (text.trim() !== "") {
      try {
        body = JSON.parse(text);
      } catch {
        return send(res, 400, {
          error: { code: "validation_error", message: "Request body is not valid JSON." },
        });
      }
    }

    let matched: { route: Route; values: string[] } | undefined;
    for (const route of routes) {
      if (route.method !== method) continue;
      const m = route.pattern.exec(url.pathname);
      if (m) {
        matched = { route, values: m.slice(1) };
        break;
      }
    }

    const query: Record<string, string[]> = {};
    for (const key of new Set(url.searchParams.keys())) query[key] = url.searchParams.getAll(key);
    const ctx: InvokeContext = {
      principalId: principalFor(req),
      tenantId: headerValue(req, "x-anvil-tenant"),
      // Confirmation is a surface-side gate: the MCP server, CLI or SDK asks
      // for it before a request is ever sent, and the wire has no field for
      // it. A request that arrives here was already confirmed by its caller.
      confirm: true,
      faultScenario: headerValue(req, "x-anvil-fault"),
    };

    let tool = `${method} ${url.pathname}`;
    let input: Record<string, unknown> = {};
    let traced: Record<string, string> = {};
    if (matched) {
      const { op } = matched.route;
      tool = op.mcp.toolName;
      ({ input, headers: traced } = liftInput(op, matched.route, matched.values, query, req, body));
      const key = idempotencyKeyFor(op, matched.route, matched.values, query, req, body);
      if (key !== undefined) ctx.idempotencyKey = key;
      const cursorParam = op.pagination?.cursorParam;
      const cursor = cursorParam ? query[cursorParam]?.at(-1) : undefined;
      if (cursor !== undefined) ctx.cursor = cursor;
    }
    for (const name of Object.keys(req.headers)) {
      if (name.startsWith("x-anvil-")) traced[name] = headerValue(req, name) ?? "";
    }

    const call = await sim.call(tool, input, ctx);
    const status = sim.statusFor(call);
    let responseBody: unknown;
    let headers: Record<string, string> = {};
    if (call.result.ok) {
      const output = call.result.output;
      if (call.operation && servesItems(call.operation) && isItems(output)) {
        ({ body: responseBody, headers } = envelope(
          air,
          call.operation,
          output.items,
          call.result.nextCursor,
          url,
        ));
      } else {
        responseBody = output ?? null;
      }
    } else {
      responseBody = sim.wireError(call.operation, call.result.error).body;
    }

    options.trace?.write({
      schema: TRACE_SCHEMA,
      seq: call.seq,
      requestId: call.requestId,
      transport: "http",
      tool: call.operation ? tool : null,
      operationId: call.operation?.id ?? null,
      request: { method, path: url.pathname, query, headers: traced, body: body ?? null },
      normalized: call.normalized,
      provider: call.provider,
      result: call.result,
      status,
      response: responseBody,
    });
    send(res, status, responseBody, { "x-request-id": call.requestId, ...headers });
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
        send(res, 500, { error: { code: "unknown_upstream_error", message } });
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
  return {
    url: `http://${host}:${address.port}`,
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function isItems(output: unknown): output is { items: unknown[] } {
  return (
    typeof output === "object" &&
    output !== null &&
    Array.isArray((output as { items?: unknown }).items)
  );
}

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body ?? null));
}

/**
 * Lift a wire request back into the agent-keyed input the simulator takes:
 * path captures, query values and header params by their `agentPropKey`, and
 * the body either field by field or whole, as the contract projects it.
 */
function liftInput(
  op: Operation,
  route: Route,
  values: string[],
  query: Record<string, string[]>,
  req: IncomingMessage,
  body: unknown,
): { input: Record<string, unknown>; headers: Record<string, string> } {
  const input: Record<string, unknown> = {};
  const headers: Record<string, string> = {};
  const wireValue = (p: Param): string[] | undefined => {
    if (p.in === "path") {
      const i = route.names.indexOf(p.name);
      const raw = i === -1 ? undefined : values[i];
      return raw === undefined ? undefined : [decodeURIComponent(raw)];
    }
    if (p.in === "query") return query[p.name];
    if (p.in === "header") {
      const v = headerValue(req, p.name);
      if (v !== undefined) headers[p.name.toLowerCase()] = v;
      return v === undefined ? undefined : [v];
    }
    return undefined;
  };
  for (const p of op.input.params) {
    const raw = wireValue(p);
    if (raw !== undefined) input[agentPropKey(p)] = coerce(p.schema, raw);
  }
  // A page-size knob the contract names but does not declare as a parameter
  // is still honoured, so a caller can ask for the page it wants.
  const sizeParam = op.pagination?.pageSizeParam;
  if (sizeParam && !op.input.params.some((p) => p.name === sizeParam) && query[sizeParam]) {
    input[sizeParam] = Number(query[sizeParam].at(-1));
  }
  const declared = op.input.body;
  if (declared?.projection === "fields" && typeof body === "object" && body !== null) {
    for (const f of declared.fields) {
      const value = (body as Record<string, unknown>)[f.name];
      if (value !== undefined) input[agentPropKey(f)] = value;
    }
  } else if (declared && body !== undefined) {
    input.body = body;
  }
  return { input, headers };
}

/** The idempotency key from wherever the contract says it travels. */
function idempotencyKeyFor(
  op: Operation,
  route: Route,
  values: string[],
  query: Record<string, string[]>,
  req: IncomingMessage,
  body: unknown,
): string | undefined {
  const carrier = resolveIdempotencyCarrier(op);
  const binding = carrier.ok ? carrier.binding : undefined;
  if (!binding) return undefined;
  let value: unknown;
  switch (binding.mechanism) {
    case "header":
      value = headerValue(req, binding.key);
      break;
    case "query":
      value = query[binding.key]?.at(-1);
      break;
    case "path": {
      const i = route.names.indexOf(binding.key);
      value = i === -1 ? undefined : values[i];
      break;
    }
    case "body":
      value = getPath(body, binding.path);
      break;
  }
  return typeof value === "string" && value !== "" ? value : undefined;
}
