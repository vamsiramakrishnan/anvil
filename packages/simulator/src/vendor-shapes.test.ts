import type { AirDocument } from "@anvil/air";
import { approveOperations, compile } from "@anvil/compiler";
import { beforeAll, describe, expect, it } from "vitest";
import { simulatorDefinitionFor } from "./define.js";
import { serveSimulatorHttp } from "./http.js";
import type { ProviderRequest, ProviderResponse, StateProvider } from "./provider.js";
import { Simulator } from "./runtime.js";
import type { TraceEntry } from "./trace.js";

/**
 * Wire shapes of real vendor contracts served over HTTP through a provider:
 * a continuation token in the request and response bodies (Jira's enhanced
 * search).
 */
const SPEC = `openapi: "3.0.3"
info: { title: Vendor shapes, version: "1.0.0" }
paths:
  /rest/api/3/search/jql:
    post:
      operationId: searchIssuesPost
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                jql: { type: string }
                fields: { type: array, items: { type: string } }
                maxResults: { type: integer, default: 50, maximum: 100 }
                nextPageToken: { type: string }
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                type: object
                properties:
                  isLast: { type: boolean }
                  issues: { type: array, items: { type: object } }
                  nextPageToken: { type: string }
`;

const ROWS = Array.from({ length: 5 }, (_, i) => ({ id: String(i + 1) }));

/** Pages through ROWS by a numeric cursor. */
const pagingProvider = (): StateProvider & { seen: ProviderRequest[] } => {
  const seen: ProviderRequest[] = [];
  return {
    seen,
    invoke: (req): ProviderResponse => {
      seen.push(req);
      if (req.page) {
        const start = Number(req.page.cursor ?? 0);
        const end = start + req.page.size;
        return {
          ok: true,
          items: ROWS.slice(start, end),
          nextCursor: end < ROWS.length ? String(end) : null,
        };
      }
      return { ok: true, result: null };
    },
  };
};

let air: AirDocument;

beforeAll(async () => {
  const compiled = await compile({ spec: SPEC, serviceId: "vendor" });
  air = approveOperations(
    compiled,
    compiled.operations.map((o) => o.id),
  );
  for (const op of air.operations) {
    op.idempotency = { mode: "none", mechanism: "none", keyDerivation: "none" };
    op.auth = { ...op.auth, type: "none", scopes: [] };
  }
});

async function serving() {
  const provider = pagingProvider();
  const trace: TraceEntry[] = [];
  const sim = new Simulator(air, simulatorDefinitionFor(air), { provider });
  const http = await serveSimulatorHttp(sim, air, { trace: { write: (e) => trace.push(e) } });
  return { url: http.url, provider, trace, close: () => http.close() };
}

const json = { "content-type": "application/json" };

describe("a continuation token carried in the request body", () => {
  it("passes page.cursor from the body and writes the next token into the response body", async () => {
    const s = await serving();
    try {
      const first = await fetch(`${s.url}/rest/api/3/search/jql`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ jql: "project = K", maxResults: 2 }),
      });
      expect(first.status).toBe(200);
      const page1 = await first.json();
      expect(page1).toEqual({ issues: [{ id: "1" }, { id: "2" }], nextPageToken: "2" });
      expect(s.provider.seen[0]?.page).toEqual({ cursor: null, size: 2 });

      const second = await fetch(`${s.url}/rest/api/3/search/jql`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ jql: "project = K", maxResults: 2, nextPageToken: "4" }),
      });
      expect(await second.json()).toEqual({ issues: [{ id: "5" }] });
      expect(s.provider.seen[1]?.page).toEqual({ cursor: "4", size: 2 });
      expect(s.provider.seen[1]?.body).toMatchObject({ nextPageToken: "4" });
    } finally {
      await s.close();
    }
  });

  it("clamps a body page size to the declared maximum", async () => {
    const s = await serving();
    try {
      await fetch(`${s.url}/rest/api/3/search/jql`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ jql: "x", maxResults: 500 }),
      });
      expect(s.provider.seen[0]?.page?.size).toBe(100);
    } finally {
      await s.close();
    }
  });
});
