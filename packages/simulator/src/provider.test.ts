import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AirDocument, contractHash } from "@anvil/air";
import { approveOperations, compile } from "@anvil/compiler";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { simulatorDefinitionFor } from "./define.js";
import { serveSimulatorHttp } from "./http.js";
import type { ProviderRequest, ProviderResponse, StateProvider } from "./provider.js";
import { Simulator } from "./runtime.js";
import { StdioStateProvider } from "./stdio-provider.js";
import { JsonlTrace, type TraceEntry } from "./trace.js";

const SPEC = `openapi: "3.0.3"
info: { title: Tickets, version: "1.0.0" }
paths:
  /tickets:
    get:
      operationId: listTickets
      parameters:
        - { name: cursor, in: query, schema: { type: string } }
        - { name: limit, in: query, schema: { type: integer, maximum: 50 } }
        - { name: status, in: query, schema: { type: string } }
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                type: object
                properties:
                  tickets: { type: array, items: { $ref: "#/components/schemas/Ticket" } }
                  next_cursor: { type: string }
    post:
      operationId: createTicket
      parameters:
        - { name: Idempotency-Key, in: header, schema: { type: string } }
      requestBody:
        required: true
        content:
          application/json:
            schema: { type: object, required: [title], properties: { title: { type: string } } }
      responses:
        "201": { description: created, content: { application/json: { schema: { $ref: "#/components/schemas/Ticket" } } } }
        "409": { description: duplicate }
  /tickets/{ticket_id}:
    get:
      operationId: getTicket
      parameters:
        - { name: ticket_id, in: path, required: true, schema: { type: string } }
      responses:
        "200": { description: ok, content: { application/json: { schema: { $ref: "#/components/schemas/Ticket" } } } }
        "404": { description: not found }
components:
  schemas:
    Ticket:
      type: object
      properties: { id: { type: string }, title: { type: string }, status: { type: string } }
`;

/**
 * A provider that is a plain function over a five-ticket table: lists page by
 * offset cursor and filter by `status`, a get of an unknown id raises the
 * vendor's own error code, a create appends. The Node child script below is
 * the same logic behind the stdio protocol.
 */
const PROVIDER_LOGIC = `
function makeStore() {
  const rows = [1, 2, 3, 4, 5].map((n) => ({ id: "T-" + n, title: "Ticket " + n, status: n % 2 ? "open" : "closed" }));
  return function answer(req) {
    if (req.kind === "list") {
      const status = req.params.query.status;
      const all = status ? rows.filter((r) => r.status === status) : rows;
      const start = req.page.cursor ? Number(req.page.cursor) : 0;
      const end = start + req.page.size;
      return { ok: true, items: all.slice(start, end), nextCursor: end < all.length ? String(end) : null };
    }
    if (req.kind === "read") {
      const row = rows.find((r) => r.id === req.params.path.ticket_id);
      if (!row) return { ok: false, error: { code: "not_found", upstreamCode: "TICKET_NOT_FOUND", message: "No ticket " + req.params.path.ticket_id } };
      return { ok: true, result: row };
    }
    if (req.kind === "create") {
      const row = { id: "T-" + (rows.length + 1), title: req.body.title, status: "open" };
      rows.push(row);
      return { ok: true, result: row };
    }
    return { ok: false, error: { code: "unsupported_operation" } };
  };
}
`;

const inProcessProvider = (): StateProvider & { seen: ProviderRequest[] } => {
  const answer = new Function(`${PROVIDER_LOGIC}; return makeStore();`)() as (
    req: ProviderRequest,
  ) => ProviderResponse;
  const seen: ProviderRequest[] = [];
  return {
    seen,
    invoke: (req) => {
      seen.push(req);
      return answer(req);
    },
  };
};

const CHILD = (mode: "serve" | "die" | "hang") => `
import { createInterface } from "node:readline";
${PROVIDER_LOGIC}
const answer = makeStore();
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ id: msg.id, result: { protocolVersion: 1, echo: msg.params } });
  } else if (msg.method === "invoke") {
    if (${JSON.stringify(mode)} === "die") { process.stderr.write("boom\\n"); process.exit(3); }
    if (${JSON.stringify(mode)} === "hang") return;
    send({ id: msg.id, result: answer(msg.params) });
  } else if (msg.method === "shutdown") {
    send({ id: msg.id, result: null });
    process.exit(0);
  }
});
`;

let air: AirDocument;
let tmp: string;

beforeEach(async () => {
  const compiled = await compile({ spec: SPEC, serviceId: "tickets" });
  air = approveOperations(
    compiled,
    compiled.operations.map((o) => o.id),
  );
  for (const op of air.operations) {
    if (op.sourceRef.operationId === "createTicket") {
      op.auth = { ...op.auth, type: "oauth2_client_credentials", scopes: ["tickets:write"] };
      op.idempotency = {
        mode: "key_supported",
        mechanism: "header",
        key: "Idempotency-Key",
        keyDerivation: "none",
      };
    }
    if (op.sourceRef.operationId === "getTicket") {
      op.errors = [{ code: "not_found", upstream: { httpStatus: 404, code: "TICKET_NOT_FOUND" } }];
    }
  }
  tmp = mkdtempSync(join(tmpdir(), "anvil-provider-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const tool = (opId: string) =>
  air.operations.find((o) => o.sourceRef.operationId === opId)?.mcp.toolName as string;

const writeChild = (mode: "serve" | "die" | "hang") => {
  const path = join(tmp, `provider-${mode}.mjs`);
  writeFileSync(path, CHILD(mode), "utf8");
  return `"${process.execPath}" "${path}"`;
};

describe("default provider", () => {
  it("serves invokeAsync from the built-in store exactly as invoke does", async () => {
    const def = simulatorDefinitionFor(air, { seed: 7 });
    const a = new Simulator(air, def);
    const b = new Simulator(air, def);
    const calls: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      [tool("listTickets"), {}, {}],
      [tool("createTicket"), { title: "x" }, { principalId: "admin", confirm: true }],
      [
        tool("createTicket"),
        { title: "x" },
        { principalId: "admin", confirm: true, idempotencyKey: "k" },
      ],
      [
        tool("createTicket"),
        { title: "x" },
        { principalId: "admin", confirm: true, idempotencyKey: "k" },
      ],
      [tool("getTicket"), { ticket_id: "nope" }, {}],
    ];
    for (const [name, input, ctx] of calls) {
      expect(await b.invokeAsync(name, input, ctx)).toEqual(a.invoke(name, input, ctx));
    }
  });

  it("refuses the synchronous invoke once a provider owns state", () => {
    const sim = new Simulator(air, simulatorDefinitionFor(air), { provider: inProcessProvider() });
    expect(() => sim.invoke(tool("listTickets"))).toThrow(/invokeAsync/);
  });
});

describe("in-process provider", () => {
  const build = () => {
    const provider = inProcessProvider();
    const entries: TraceEntry[] = [];
    const sim = new Simulator(air, simulatorDefinitionFor(air, { seed: 3 }), {
      provider,
      trace: { write: (e) => entries.push(e) },
      defaultPageSize: 2,
    });
    return { provider, entries, sim };
  };

  it("hands the provider a normalized request and pages through its cursor", async () => {
    const { provider, sim } = build();
    const first = await sim.invokeAsync(tool("listTickets"), { status: "open" });
    expect(first).toEqual({
      ok: true,
      output: {
        items: [
          { id: "T-1", title: "Ticket 1", status: "open" },
          { id: "T-3", title: "Ticket 3", status: "open" },
        ],
      },
      nextCursor: "2",
    });
    const second = await sim.invokeAsync(tool("listTickets"), { status: "open", cursor: "2" });
    expect(second).toEqual({
      ok: true,
      output: { items: [{ id: "T-5", title: "Ticket 5", status: "open" }] },
    });
    expect(provider.seen[0]).toEqual({
      requestId: "r1",
      capabilityId: "tickets",
      operationId: "tickets.tickets.list",
      toolName: tool("listTickets"),
      kind: "list",
      action: "list",
      resource: "ticket",
      method: "GET",
      pathTemplate: "/tickets",
      params: { path: {}, query: { status: "open" }, header: {}, cookie: {} },
      body: null,
      page: { cursor: null, size: 2 },
      principal: null,
      tenantId: null,
      idempotencyKey: null,
    });
    expect(provider.seen[1]?.page).toEqual({ cursor: "2", size: 2 });
  });

  it("clamps a requested page size to the contract's maximum", async () => {
    const { provider, sim } = build();
    await sim.invokeAsync(tool("listTickets"), { limit: 500 });
    expect(provider.seen[0]?.page).toEqual({ cursor: null, size: 50 });
  });

  it("maps a domain error onto the contract's declared error", async () => {
    const { sim } = build();
    const result = await sim.invokeAsync(tool("getTicket"), { ticket_id: "T-9" });
    expect(result).toEqual({
      ok: false,
      error: {
        code: "not_found",
        message: "No ticket T-9",
        wire: {
          status: 404,
          body: { error: { code: "TICKET_NOT_FOUND", message: "No ticket T-9" } },
        },
      },
    });
  });

  it("keeps every surface gate in front of the provider", async () => {
    const { provider, sim } = build();
    const create = tool("createTicket");
    expect(await sim.invokeAsync(create, { title: "a" })).toMatchObject({
      error: { code: "auth_required" },
    });
    expect(await sim.invokeAsync(create, { title: "a" }, { principalId: "limited" })).toMatchObject(
      { error: { code: "permission_denied" } },
    );
    expect(await sim.invokeAsync(create, { title: "a" }, { principalId: "admin" })).toMatchObject({
      error: { code: "confirmation_required" },
    });
    expect(
      await sim.invokeAsync(create, {}, { principalId: "admin", confirm: true }),
    ).toMatchObject({ error: { code: "validation_error" } });
    expect(
      await sim.invokeAsync(tool("listTickets"), {}, { faultScenario: "throttle" }),
    ).toMatchObject({ error: { code: "rate_limited" } });
    expect(provider.seen).toEqual([]);
  });

  it("replays a keyed mutation without reaching the provider twice, even concurrently", async () => {
    const { provider, sim } = build();
    const ctx = { principalId: "admin", confirm: true, idempotencyKey: "key-1" };
    const [a, b] = await Promise.all([
      sim.invokeAsync(tool("createTicket"), { title: "dup" }, ctx),
      sim.invokeAsync(tool("createTicket"), { title: "dup" }, ctx),
    ]);
    const c = await sim.invokeAsync(tool("createTicket"), { title: "dup" }, ctx);
    expect(a).toEqual({ ok: true, output: { id: "T-6", title: "dup", status: "open" } });
    expect(b).toEqual({ ...a, replayed: true });
    expect(c).toEqual({ ...a, replayed: true });
    expect(provider.seen.map((r) => r.idempotencyKey)).toEqual(["key-1"]);
    expect(provider.seen[0]?.principal).toEqual({
      id: "admin",
      role: "admin",
      scopes: ["tickets:write"],
    });
  });

  it("refuses a page larger than the one it asked for", async () => {
    const sim = new Simulator(air, simulatorDefinitionFor(air), {
      provider: { invoke: () => ({ ok: true, items: [1, 2, 3] }) },
      defaultPageSize: 2,
    });
    expect(await sim.invokeAsync(tool("listTickets"))).toMatchObject({
      ok: false,
      error: { code: "schema_mismatch" },
    });
  });

  it("traces the agent's request, the provider exchange and the result", async () => {
    const { entries, sim } = build();
    await sim.invokeAsync(tool("getTicket"), { ticket_id: "T-2" });
    await sim.invokeAsync(tool("createTicket"), { title: "a" });
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      schema: "anvil.simulator.trace/v1",
      seq: 1,
      requestId: "r1",
      transport: "in_process",
      operationId: "tickets.tickets.get",
      request: { input: { ticket_id: "T-2" }, context: {} },
      normalized: { kind: "read", params: { path: { ticket_id: "T-2" } } },
      provider: { ok: true, result: { id: "T-2" } },
      result: { ok: true },
      status: 200,
    });
    // A refused call never reached the provider, and the trace says so.
    expect(entries[1]).toMatchObject({
      seq: 2,
      normalized: null,
      provider: null,
      result: { ok: false, error: { code: "auth_required" } },
      status: 401,
    });
  });
});

describe("stdio provider", () => {
  const init = () => new Simulator(air, simulatorDefinitionFor(air)).initializeParams();

  it("initializes with the contract digest and serves invokes over JSON-RPC", async () => {
    const provider = await StdioStateProvider.start({ command: writeChild("serve") }, init());
    try {
      const sim = new Simulator(air, simulatorDefinitionFor(air), { provider, defaultPageSize: 3 });
      expect(sim.initializeParams().contractDigest).toBe(contractHash(air));
      const page = await sim.invokeAsync(tool("listTickets"));
      expect(page).toMatchObject({ ok: true, nextCursor: "3" });
      expect((page as { output: { items: unknown[] } }).output.items).toHaveLength(3);
      expect(await sim.invokeAsync(tool("getTicket"), { ticket_id: "T-0" })).toMatchObject({
        error: { code: "not_found", wire: { status: 404 } },
      });
    } finally {
      await provider.close();
    }
  });

  it("refuses a provider that speaks another protocol version", async () => {
    const path = join(tmp, "old.mjs");
    writeFileSync(
      path,
      `process.stdin.on("data", (d) => { const m = JSON.parse(String(d)); process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 99 } }) + "\\n"); });`,
    );
    await expect(
      StdioStateProvider.start({ command: `"${process.execPath}" "${path}"` }, init()),
    ).rejects.toThrow(/protocol 99/);
  });

  it("reports a dead child clearly, with its exit code and stderr", async () => {
    const provider = await StdioStateProvider.start(
      { command: writeChild("die"), forwardStderr: false },
      init(),
    );
    const exited = new Promise<Error>((resolve) => provider.onExit(resolve));
    const sim = new Simulator(air, simulatorDefinitionFor(air), { provider });
    const result = await sim.invokeAsync(tool("getTicket"), { ticket_id: "T-1" });
    expect(result).toMatchObject({ ok: false, error: { code: "upstream_unavailable" } });
    const message = (result as { error: { message: string } }).error.message;
    expect(message).toContain("exited (exit code 3)");
    expect(message).toContain("boom");
    expect((await exited).message).toContain("exit code 3");
    // Every later call fails fast with the same diagnosis.
    expect(await sim.invokeAsync(tool("getTicket"), { ticket_id: "T-1" })).toMatchObject({
      error: { code: "upstream_unavailable", message: expect.stringContaining("exit code 3") },
    });
  });

  it("times out a provider that never answers", async () => {
    const provider = await StdioStateProvider.start(
      { command: writeChild("hang"), timeoutMs: 200 },
      init(),
    );
    try {
      const sim = new Simulator(air, simulatorDefinitionFor(air), { provider });
      expect(await sim.invokeAsync(tool("getTicket"), { ticket_id: "T-1" })).toMatchObject({
        error: { code: "upstream_timeout", message: expect.stringContaining("within 200 ms") },
      });
    } finally {
      await provider.close();
    }
  });
});

describe("HTTP serving", () => {
  it("serves the contract's paths with its envelope, mapped errors, and a trace", async () => {
    const provider = await StdioStateProvider.start(
      { command: writeChild("serve") },
      new Simulator(air, simulatorDefinitionFor(air)).initializeParams(),
    );
    const tracePath = join(tmp, "trace.jsonl");
    const sim = new Simulator(air, simulatorDefinitionFor(air), { provider, defaultPageSize: 2 });
    const http = await serveSimulatorHttp(sim, air, { trace: new JsonlTrace(tracePath) });
    try {
      const page1 = await fetch(`${http.url}/tickets?status=open`);
      expect(page1.status).toBe(200);
      expect(await page1.json()).toEqual({
        tickets: [
          { id: "T-1", title: "Ticket 1", status: "open" },
          { id: "T-3", title: "Ticket 3", status: "open" },
        ],
        next_cursor: "2",
      });
      const page2 = await fetch(`${http.url}/tickets?status=open&cursor=2`);
      expect(await page2.json()).toEqual({
        tickets: [{ id: "T-5", title: "Ticket 5", status: "open" }],
      });

      const missing = await fetch(`${http.url}/tickets/T-404`);
      expect(missing.status).toBe(404);
      expect(missing.headers.get("x-request-id")).toBe("r3");
      expect(await missing.json()).toEqual({
        error: { code: "TICKET_NOT_FOUND", message: "No ticket T-404" },
      });

      const create = () =>
        fetch(`${http.url}/tickets`, {
          method: "POST",
          headers: {
            authorization: "Bearer admin",
            "content-type": "application/json",
            "idempotency-key": "abc",
          },
          body: JSON.stringify({ title: "From HTTP" }),
        });
      const created = await create();
      expect(created.status).toBe(201);
      expect(await created.json()).toEqual({ id: "T-6", title: "From HTTP", status: "open" });
      expect(await (await create()).json()).toEqual({
        id: "T-6",
        title: "From HTTP",
        status: "open",
      });

      const anonymous = await fetch(`${http.url}/tickets`, {
        method: "POST",
        body: JSON.stringify({ title: "x" }),
      });
      expect(anonymous.status).toBe(401);
      expect(await anonymous.json()).toEqual({
        error: { code: "auth_required", message: "No principal supplied." },
      });

      const unknown = await fetch(`${http.url}/nowhere`);
      expect(unknown.status).toBe(404);
    } finally {
      await http.close();
      await provider.close();
    }

    const trace = readFileSync(tracePath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as TraceEntry);
    expect(trace.map((e) => [e.seq, e.status, e.operationId])).toEqual([
      [1, 200, "tickets.tickets.list"],
      [2, 200, "tickets.tickets.list"],
      [3, 404, "tickets.tickets.get"],
      [4, 201, "tickets.tickets.create"],
      [5, 201, "tickets.tickets.create"],
      [6, 401, "tickets.tickets.create"],
      [7, 404, null],
    ]);
    expect(trace[0]).toMatchObject({
      transport: "http",
      request: { method: "GET", path: "/tickets", query: { status: ["open"] }, body: null },
      normalized: { kind: "list", page: { cursor: null, size: 2 } },
      provider: { ok: true, nextCursor: "2" },
      response: { next_cursor: "2" },
    });
    expect(trace[3]).toMatchObject({
      request: { headers: { "idempotency-key": "abc" }, body: { title: "From HTTP" } },
      normalized: {
        idempotencyKey: "abc",
        principal: { id: "admin" },
        body: { title: "From HTTP" },
      },
    });
    // The replay was answered by the simulator, never by the provider.
    expect(trace[4]).toMatchObject({
      normalized: null,
      provider: null,
      result: { replayed: true },
    });
  });
});
