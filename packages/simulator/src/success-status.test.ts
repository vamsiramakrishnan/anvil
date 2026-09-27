import type { AirDocument } from "@anvil/air";
import { approveOperations, compile } from "@anvil/compiler";
import { beforeAll, describe, expect, it } from "vitest";
import { simulatorDefinitionFor } from "./define.js";
import { serveSimulatorHttp } from "./http.js";
import type { ProviderRequest, StateProvider } from "./provider.js";
import { Simulator } from "./runtime.js";
import type { TraceEntry } from "./trace.js";

/**
 * A success is served with a status the contract declares: Jira's transition
 * answers 204 and its issue edit 204 (or 200 when it returns the issue).
 */
const SPEC = `openapi: "3.0.3"
info: { title: Statuses, version: "1.0.0" }
paths:
  /rest/api/3/issue/{issueIdOrKey}:
    put:
      operationId: editIssue
      parameters:
        - { name: issueIdOrKey, in: path, required: true, schema: { type: string } }
      requestBody:
        content: { application/json: { schema: { type: object } } }
      responses:
        "200": { description: returnIssue, content: { application/json: { schema: { type: object } } } }
        "204": { description: ok }
  /rest/api/3/issue/{issueIdOrKey}/transitions:
    post:
      operationId: doTransition
      parameters:
        - { name: issueIdOrKey, in: path, required: true, schema: { type: string } }
      requestBody:
        content: { application/json: { schema: { type: object } } }
      responses:
        "204": { description: ok }
  /pages:
    post:
      operationId: createPage
      requestBody:
        content: { application/json: { schema: { type: object } } }
      responses:
        "200": { description: created, content: { application/json: { schema: { type: object } } } }
`;

let air: AirDocument;

beforeAll(async () => {
  const compiled = await compile({ spec: SPEC, serviceId: "statuses" });
  air = approveOperations(
    compiled,
    compiled.operations.map((o) => o.id),
  );
  for (const op of air.operations) {
    op.idempotency = { mode: "none", mechanism: "none", keyDerivation: "none" };
    op.auth = { ...op.auth, type: "none", scopes: [] };
  }
});

async function serving(answer: (req: ProviderRequest) => unknown) {
  const seen: ProviderRequest[] = [];
  const trace: TraceEntry[] = [];
  const provider: StateProvider = {
    invoke: (req) => {
      seen.push(req);
      const result = answer(req);
      return result === undefined ? { ok: true } : { ok: true, result };
    },
  };
  const sim = new Simulator(air, simulatorDefinitionFor(air), { provider });
  const http = await serveSimulatorHttp(sim, air, { trace: { write: (e) => trace.push(e) } });
  return { url: http.url, seen, trace, close: () => http.close() };
}

const json = { "content-type": "application/json" };

describe("declared success statuses", () => {
  it("answers a 204 sub-resource action with 204 and no body, as an action", async () => {
    const s = await serving(() => undefined);
    try {
      const res = await fetch(`${s.url}/rest/api/3/issue/K-1/transitions`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ transition: { id: "31" } }),
      });
      expect(res.status).toBe(204);
      expect(await res.text()).toBe("");
      expect(s.seen[0]).toMatchObject({ kind: "action", action: "other" });
      expect(s.trace.at(-1)).toMatchObject({ status: 204, response: null });
    } finally {
      await s.close();
    }
  });

  it("answers an edit with 204 when the provider returns no body, else its declared 200", async () => {
    const edit = (url: string) =>
      fetch(`${url}/rest/api/3/issue/K-1`, {
        method: "PUT",
        headers: json,
        body: JSON.stringify({ fields: { summary: "new" } }),
      });
    const empty = await serving(() => undefined);
    try {
      expect((await edit(empty.url)).status).toBe(204);
      expect(empty.seen[0]?.kind).toBe("update");
    } finally {
      await empty.close();
    }
    const returning = await serving(() => ({ id: "K-1" }));
    try {
      const res = await edit(returning.url);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: "K-1" });
    } finally {
      await returning.close();
    }
  });

  it("serves a create with the status its contract declares, not the 201 convention", async () => {
    const s = await serving(() => ({ id: "P-1" }));
    try {
      const res = await fetch(`${s.url}/pages`, { method: "POST", headers: json, body: "{}" });
      expect(res.status).toBe(200);
      expect(s.seen[0]?.kind).toBe("create");
    } finally {
      await s.close();
    }
  });
});
