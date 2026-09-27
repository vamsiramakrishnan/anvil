import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AirDocument } from "@anvil/air";
import { approveOperations, compile } from "@anvil/compiler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { simulatorDefinitionFor } from "./define.js";
import { serveSimulatorHttp } from "./http.js";
import type { ProviderResponse, StateProvider } from "./provider.js";
import { Simulator } from "./runtime.js";
import { JsonlTrace, type TraceEntry } from "./trace.js";

/**
 * The provider metadata channel: `meta` on any answer is written to the trace
 * and never reaches what the caller is served.
 */
const SPEC = `openapi: "3.0.3"
info: { title: Meta, version: "1.0.0" }
paths:
  /tickets:
    get:
      operationId: listTickets
      parameters:
        - { name: cursor, in: query, schema: { type: string } }
        - { name: limit, in: query, schema: { type: integer } }
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                type: object
                properties:
                  tickets: { type: array, items: { type: object } }
                  next_cursor: { type: string }
  /tickets/{id}:
    get:
      operationId: getTicket
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
      responses:
        "200": { description: ok, content: { application/json: { schema: { type: object } } } }
        "404": { description: missing }
`;

const META = { query: "SELECT * FROM tickets", rowsScanned: 42, fixture: "tickets-v3" };

let air: AirDocument;
let tmp: string;

beforeAll(async () => {
  const compiled = await compile({ spec: SPEC, serviceId: "meta" });
  air = approveOperations(
    compiled,
    compiled.operations.map((o) => o.id),
  );
  for (const op of air.operations) op.auth = { ...op.auth, type: "none", scopes: [] };
  tmp = mkdtempSync(join(tmpdir(), "anvil-sim-meta-"));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const provider: StateProvider = {
  invoke: (req): ProviderResponse => {
    if (req.page) return { ok: true, items: [{ id: "T-1" }], nextCursor: "1", meta: META };
    if (req.params.path.id === "T-1") return { ok: true, result: { id: "T-1" }, meta: META };
    return { ok: false, error: { code: "not_found", message: "No ticket" }, meta: META };
  },
};

describe("provider metadata", () => {
  it("is recorded in the trace and never served, on a page, a result, or an error", async () => {
    const path = join(tmp, "calls.jsonl");
    const sim = new Simulator(air, simulatorDefinitionFor(air), { provider });
    const http = await serveSimulatorHttp(sim, air, { trace: new JsonlTrace(path) });
    const served: Array<{ status: number; headers: string; body: string }> = [];
    try {
      for (const url of ["/tickets?limit=1", "/tickets/T-1", "/tickets/T-9"]) {
        const res = await fetch(`${http.url}${url}`);
        served.push({
          status: res.status,
          headers: JSON.stringify([...res.headers.entries()]),
          body: await res.text(),
        });
      }
    } finally {
      await http.close();
    }
    expect(served.map((s) => s.status)).toEqual([200, 200, 404]);
    expect(JSON.parse(served[0]?.body ?? "")).toEqual({
      tickets: [{ id: "T-1" }],
      next_cursor: "1",
    });
    for (const s of served) {
      expect(s.body).not.toContain("rowsScanned");
      expect(s.headers).not.toContain("rowsScanned");
    }
    const trace = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as TraceEntry);
    expect(trace).toHaveLength(3);
    for (const entry of trace) {
      expect(entry.provider).toMatchObject({ meta: META });
      expect(JSON.stringify(entry.response)).not.toContain("rowsScanned");
      expect(JSON.stringify(entry.result)).not.toContain("rowsScanned");
    }
  });

  it("stays out of the in-process result", async () => {
    const sim = new Simulator(air, simulatorDefinitionFor(air), { provider });
    const tool = air.operations.find((o) => o.sourceRef.operationId === "getTicket")?.mcp.toolName;
    const call = await sim.call(tool ?? "", { id: "T-1" });
    expect(call.result).toEqual({ ok: true, output: { id: "T-1" } });
    expect(call.provider).toMatchObject({ meta: META });
  });
});
