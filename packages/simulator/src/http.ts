/**
 * Serve a simulator over HTTP at the contract's own wire coordinates, so any
 * HTTP client of the real API (a generated SDK, the generated MCP server with
 * its base URL pointed here, curl) can drive it unchanged.
 *
 * This layer only translates. Routing picks the operation, the wire request is
 * lifted back into the agent-keyed input every other surface uses, and the
 * simulator's result is written back in the contract's envelope and error
 * shape. Every gate, replay and fault decision stays in `Simulator.call`.
 *
 * Routing follows the protocol a real client speaks, which is not always the
 * path AIR records. An HTTP+JSON operation is served at its declared path and
 * method, with its body decoded in its declared content type. A GraphQL
 * operation's `sourceRef.path` is a coordinate the compiler synthesized to
 * keep operations apart; the runtime's GraphQL codec posts every call to the
 * one endpoint with the operation in the document, so that is what is served
 * here too. A protocol this server cannot answer natively is refused when the
 * server starts, never left to 404 at call time.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type AirDocument,
  agentPropKey,
  type GraphqlWireBinding,
  type JsonSchema,
  type Operation,
  type Param,
  protocolFacadeApplies,
  resolveIdempotencyCarrier,
  wireExecutability,
  wireProtocolFor,
} from "@anvil/air";
import { coerceWireValues, decodeRequestBody, decodeUndeclared } from "./body-decoding.js";
import { servesItems } from "./provider.js";
import { declaredResponse, type InvokeContext, type SimError, type Simulator } from "./runtime.js";
import { TRACE_SCHEMA, type TraceSink, writeTrace } from "./trace.js";

export interface SimulatorHttpOptions {
  /** Interface to bind (default 127.0.0.1). */
  host?: string;
  /** Port to bind; 0 picks a free one (default 0). */
  port?: number;
  /** Principal for requests that name none (see `principalFor`). */
  principal?: string;
  trace?: TraceSink;
  /**
   * Serve operations whose source protocol is not HTTP+JSON (SOAP, a gRPC
   * method with a recorded transcoding binding, a queue request/reply bridge)
   * at their synthesized coordinates over HTTP+JSON, acting as the protocol
   * facade a client declares (`--protocol-facade`, `ANVIL_PROTOCOL_FACADE`).
   * Without it such a contract is refused at startup, because a client
   * speaking the native protocol would reach coordinates nothing serves.
   */
  protocolFacade?: boolean;
  /**
   * Where a failed trace write is reported (default: stderr). The response is
   * served regardless and carries `X-Anvil-Trace-Error`.
   */
  onTraceError?: (message: string) => void;
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

function readBody(req: IncomingMessage): Promise<Buffer> {
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
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name.toLowerCase()];
  return Array.isArray(raw) ? raw[raw.length - 1] : raw;
}

/* -------------------------------------------------------------------------- */
/* Which operations this server can answer, and how                           */
/* -------------------------------------------------------------------------- */

interface GraphqlOp {
  op: Operation;
  binding: GraphqlWireBinding;
  kind: "query" | "mutation";
}

type Serving = { ok: true; graphql?: GraphqlOp } | { ok: false; protocol: string; reason: string };

/**
 * How one operation is reached, or why it cannot be. The protocol comes from
 * AIR's `wireProtocolFor`, the same derivation the runtime's codec resolution
 * reads, so the server answers exactly the requests a generated client sends.
 */
function servingFor(op: Operation, protocolFacade: boolean): Serving {
  const protocol = wireProtocolFor(op.sourceRef);
  const { path, method } = op.sourceRef;
  const coordinates = Boolean(path && method);
  if (protocol === "http_json") {
    return coordinates
      ? { ok: true }
      : { ok: false, protocol, reason: "it declares no HTTP path and method" };
  }
  if (protocol === "graphql") {
    const binding = op.sourceRef.binding;
    if (binding?.protocol !== "graphql") {
      return {
        ok: false,
        protocol,
        reason:
          "it carries no GraphQL wire binding, so no client can call it; recompile it from the SDL",
      };
    }
    const kind = /^\s*mutation\b/.test(binding.document) ? "mutation" : "query";
    return { ok: true, graphql: { op, binding, kind } };
  }
  // A facade carries coordinates, never framing: a subscription's event
  // stream is not an HTTP+JSON call whatever the base URL is, which is why
  // the runtime never routes `graphql_sse` through its JSON codec either.
  const facadeCanCarry = protocol !== "graphql_sse" && coordinates && protocolFacadeApplies(op);
  if (facadeCanCarry && protocolFacade) return { ok: true };
  if (facadeCanCarry) {
    return {
      ok: false,
      protocol,
      reason:
        `a ${protocol} client sends the native protocol, which this server does not decode; ` +
        `a client that declares a protocol facade reaches it at ${method?.toUpperCase()} ${path} ` +
        "when the server is started with --protocol-facade",
    };
  }
  const verdict = wireExecutability(op);
  return {
    ok: false,
    protocol,
    reason:
      protocol === "graphql_sse"
        ? "a GraphQL subscription is read as a Server-Sent Events stream, which this server does not produce"
        : verdict.ok
          ? `this server does not speak ${protocol}`
          : verdict.reason,
  };
}

/** The refusal `serveSimulatorHttp` raises when any served operation would be unreachable. */
function unservableError(refused: Array<{ op: Operation; protocol: string; reason: string }>) {
  const lines = refused.map(({ op, protocol, reason }) => `  - ${op.id} (${protocol}): ${reason}`);
  return new Error(
    `Cannot serve this contract over HTTP: ${refused.length} operation(s) would be unreachable, ` +
      "and a server that answered them with 404 would look like a contract bug.\n" +
      `${lines.join("\n")}\n` +
      "Serve a capability without them (--capability), or drive them in process.",
  );
}

/* -------------------------------------------------------------------------- */
/* GraphQL: one endpoint, the operation in the document                        */
/* -------------------------------------------------------------------------- */

const NAME = "[_A-Za-z][_0-9A-Za-z]*";

/**
 * The first root field an operation selects, and its response key (an alias
 * when one is given). Read from the operation named `operationName` when the
 * document holds several, else from the first. Enough of GraphQL to route a
 * request, not to validate one: the simulator's gates do that.
 */
function selectedRootField(
  document: string,
  operationName: string | undefined,
): { kind: "query" | "mutation" | "subscription"; field: string; key: string } | undefined {
  const text = document.replace(/#[^\n]*/g, "");
  let from = 0;
  // Only a well-formed name reaches the pattern; anything else is a caller's
  // text and must not become part of a regular expression.
  if (operationName && new RegExp(`^${NAME}$`).test(operationName)) {
    const named = new RegExp(`\\b(query|mutation|subscription)\\s+${operationName}\\b`).exec(text);
    if (named) from = named.index;
  }
  const head = new RegExp(
    `^\\s*(?:(query|mutation|subscription)\\b\\s*(?:${NAME})?\\s*(?:\\([^)]*\\))?\\s*(?:@[^{]*)?)?\\{\\s*(?:(${NAME})\\s*:\\s*)?(${NAME})`,
  ).exec(text.slice(from));
  if (!head) return undefined;
  const field = head[3] as string;
  return {
    kind: (head[1] as "query" | "mutation" | "subscription" | undefined) ?? "query",
    field,
    key: head[2] ?? field,
  };
}

interface GraphqlRequest {
  target: GraphqlOp | undefined;
  /** The key the root field's value is served under. */
  responseKey: string | undefined;
  /** A name for the trace when no operation matched. */
  label: string;
  variables: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolve a GraphQL-over-HTTP envelope to the operation it calls: by the
 * `operationName` the compiled document carries, then by the document itself,
 * then by the root field it selects (a hand-written query). Arguments travel
 * as `variables`, which is how the runtime sends them; inline literals are not
 * read.
 */
function resolveGraphql(
  ops: readonly GraphqlOp[],
  envelope: Record<string, unknown>,
): GraphqlRequest {
  const document = envelope.query as string;
  const operationName =
    typeof envelope.operationName === "string" && envelope.operationName !== ""
      ? envelope.operationName
      : undefined;
  const variables = isRecord(envelope.variables) ? envelope.variables : {};
  const selected = selectedRootField(document, operationName);
  const target =
    (operationName ? ops.find((g) => g.binding.operationName === operationName) : undefined) ??
    ops.find((g) => g.binding.document === document) ??
    (selected
      ? ops.find((g) => g.binding.rootField === selected.field && g.kind === selected.kind)
      : undefined);
  const responseKey =
    target && selected?.field === target.binding.rootField
      ? selected.key
      : target?.binding.rootField;
  return {
    target,
    responseKey,
    label: `graphql ${operationName ?? selected?.field ?? "(unparsed document)"}`,
    variables,
  };
}

/**
 * A failed call in GraphQL's envelope. A provider that already answered with
 * an `errors` array is served verbatim; anything else becomes one error whose
 * `extensions.code` is the vendor code the contract maps (else Anvil's own).
 */
function graphqlErrors(error: SimError, wireBody: unknown): unknown {
  if (isRecord(wireBody) && Array.isArray(wireBody.errors)) return wireBody;
  const vendor =
    isRecord(wireBody) && isRecord(wireBody.error) && typeof wireBody.error.code === "string"
      ? wireBody.error.code
      : error.code;
  return { errors: [{ message: error.message, extensions: { code: vendor } }], data: null };
}

/* -------------------------------------------------------------------------- */
/* The server                                                                  */
/* -------------------------------------------------------------------------- */

/** A header value that is always legal on the wire. */
function headerSafe(text: string): string {
  return text.replace(/[^\x20-\x7e]/g, "?").slice(0, 512);
}

export async function serveSimulatorHttp(
  sim: Simulator,
  air: AirDocument,
  options: SimulatorHttpOptions = {},
): Promise<SimulatorHttpServer> {
  const refused: Array<{ op: Operation; protocol: string; reason: string }> = [];
  const graphqlOps: GraphqlOp[] = [];
  for (const op of sim.operations()) {
    const serving = servingFor(op, options.protocolFacade === true);
    if (!serving.ok) refused.push({ op, protocol: serving.protocol, reason: serving.reason });
    else if (serving.graphql) graphqlOps.push(serving.graphql);
  }
  if (refused.length > 0) throw unservableError(refused);

  // A GraphQL operation keeps its synthesized route too, for a client that
  // declares a protocol facade: the runtime then sends plain JSON there.
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
    let raw: Buffer;
    try {
      raw = await readBody(req);
    } catch {
      return send(res, 413, { error: { code: "validation_error", message: "Body too large." } });
    }
    const contentType = headerValue(req, "content-type");

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
    let body: unknown;
    let graphql: GraphqlRequest | undefined;
    if (matched) {
      const { op, names } = matched.route;
      // The route is chosen first, so the body is read the way *this*
      // operation declares it: JSON, a form, or multipart.
      const decoded = decodeRequestBody(op, raw, contentType);
      if (!decoded.ok) {
        return send(res, decoded.status, {
          error: { code: "validation_error", message: decoded.message },
        });
      }
      body = decoded.value;
      const values = matched.values;
      const pathValue = (name: string) => {
        const i = names.indexOf(name);
        return i === -1 ? undefined : values[i];
      };
      tool = op.mcp.toolName;
      ({ input, headers: traced } = liftInput(op, pathValue, query, req, body));
      const key = idempotencyKeyFor(op, pathValue, query, req, body);
      if (key !== undefined) ctx.idempotencyKey = key;
      const cursorParam = op.pagination?.cursorParam;
      const cursor = cursorParam ? query[cursorParam]?.at(-1) : undefined;
      if (cursor !== undefined) ctx.cursor = cursor;
    } else {
      body = decodeUndeclared(raw, contentType);
      if (
        method === "POST" &&
        graphqlOps.length > 0 &&
        isRecord(body) &&
        typeof body.query === "string"
      ) {
        graphql = resolveGraphql(graphqlOps, body);
        tool = graphql.label;
        const target = graphql.target?.op;
        if (target) {
          tool = target.mcp.toolName;
          const noPath = () => undefined;
          ({ input, headers: traced } = liftInput(target, noPath, query, req, graphql.variables));
          const key = idempotencyKeyFor(target, noPath, query, req, graphql.variables);
          if (key !== undefined) ctx.idempotencyKey = key;
          const cursorParam = target.pagination?.cursorParam;
          const cursor = cursorParam ? graphql.variables[cursorParam] : undefined;
          if (typeof cursor === "string" && cursor !== "") ctx.cursor = cursor;
        }
      }
    }
    for (const name of Object.keys(req.headers)) {
      if (name.startsWith("x-anvil-")) traced[name] = headerValue(req, name) ?? "";
    }

    const call = await sim.call(tool, input, ctx);
    let status = sim.statusFor(call);
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
    if (graphql) {
      // GraphQL over HTTP answers a well-formed request with 200 and reports
      // failure in `errors`, which is where the runtime's codec reads it
      // (whatever the status). The contract's error code travels in
      // `extensions.code`; the status the REST mapping would have used is kept
      // in the trace's `result` for a grader.
      status = 200;
      headers = {};
      responseBody = call.result.ok
        ? { data: { [graphql.responseKey ?? "data"]: responseBody } }
        : graphqlErrors(call.result.error, responseBody);
    }

    // The call has happened; a trace that cannot be written is reported, not
    // allowed to turn the response the agent is owed into a different one.
    const traceError = writeTrace(
      options.trace,
      {
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
      },
      options.onTraceError,
    );
    send(res, status, responseBody, {
      "x-request-id": call.requestId,
      ...headers,
      ...(traceError ? { "x-anvil-trace-error": headerSafe(traceError) } : {}),
    });
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

/** The name/value pairs of a `Cookie` header, repeats kept in order (RFC 6265 section 5.4). */
function cookiesOf(req: IncomingMessage): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const raw = req.headers.cookie;
  if (raw === undefined) return out;
  for (const pair of raw.split(";")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    let value = pair.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    const values = out[name] ?? [];
    values.push(value);
    out[name] = values;
  }
  return out;
}

/**
 * Lift a wire request back into the agent-keyed input the simulator takes:
 * path captures, query values, header and cookie params by their
 * `agentPropKey`, and the body either field by field or whole, as the
 * contract projects it.
 */
function liftInput(
  op: Operation,
  pathValue: (name: string) => string | undefined,
  query: Record<string, string[]>,
  req: IncomingMessage,
  body: unknown,
): { input: Record<string, unknown>; headers: Record<string, string> } {
  const input: Record<string, unknown> = {};
  const headers: Record<string, string> = {};
  const cookies = cookiesOf(req);
  const wireValue = (p: Param): string[] | undefined => {
    if (p.in === "path") {
      const raw = pathValue(p.name);
      return raw === undefined ? undefined : [decodeURIComponent(raw)];
    }
    if (p.in === "query") return query[p.name];
    if (p.in === "header") {
      const v = headerValue(req, p.name);
      if (v !== undefined) headers[p.name.toLowerCase()] = v;
      return v === undefined ? undefined : [v];
    }
    if (p.in === "cookie") return cookies[p.name];
    return undefined;
  };
  for (const p of op.input.params) {
    const raw = wireValue(p);
    if (raw !== undefined) input[agentPropKey(p)] = coerceWireValues(p.schema, raw, true);
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
  pathValue: (name: string) => string | undefined,
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
    case "path":
      value = pathValue(binding.key);
      break;
    case "body":
      value = getPath(body, binding.path);
      break;
  }
  return typeof value === "string" && value !== "" ? value : undefined;
}
