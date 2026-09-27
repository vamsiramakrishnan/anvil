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
 * search) and OData's `@odata.nextLink` (Microsoft Graph).
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
  /rest/api/3/user/search:
    get:
      operationId: findUsers
      parameters:
        - { name: query, in: query, schema: { type: string } }
        - { name: startAt, in: query, schema: { type: integer } }
        - { name: maxResults, in: query, schema: { type: integer } }
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema: { type: array, items: { type: object } }
  /wiki/api/v2/pages:
    get:
      operationId: getPages
      parameters:
        - { name: cursor, in: query, schema: { type: string } }
        - { name: limit, in: query, schema: { type: integer, maximum: 250 } }
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                type: object
                properties:
                  results: { type: array, items: { type: object } }
                  _links: { type: object, properties: { next: { type: string } } }
  /conversations.history:
    get:
      operationId: conversations_history
      parameters:
        - { name: channel, in: query, schema: { type: string } }
        - { name: cursor, in: query, schema: { type: string } }
        - { name: limit, in: query, schema: { type: integer } }
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                type: object
                required: [messages, has_more]
                properties:
                  has_more: { type: boolean }
                  messages: { type: array, items: { type: object } }
                  response_metadata:
                    type: object
                    properties: { next_cursor: { type: string } }
  /drive/v3/files:
    get:
      operationId: drive.files.list
      parameters:
        - { name: q, in: query, schema: { type: string } }
        - { name: pageToken, in: query, schema: { type: string } }
        - { name: pageSize, in: query, schema: { type: integer } }
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                type: object
                properties:
                  files: { type: array, items: { type: object } }
                  nextPageToken: { type: string }
                  incompleteSearch: { type: boolean }
                  kind: { type: string, default: "drive#fileList" }
  /users.info:
    get:
      operationId: users_info
      parameters:
        - { name: user, in: query, schema: { type: string } }
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                type: object
                required: [ok, user]
                properties:
                  ok: { type: boolean, enum: [true] }
                  user: { type: object, properties: { id: { type: string } } }
                  cache_ts: { type: integer, default: 0 }
  /conversations.list:
    get:
      operationId: conversations_list
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
                required: [ok, channels]
                properties:
                  ok: { type: boolean, enum: [true] }
                  channels: { type: array, items: { type: object } }
                  response_metadata:
                    type: object
                    required: [next_cursor]
                    properties: { next_cursor: { type: string } }
  /users:
    get:
      operationId: users.user.ListUser
      parameters:
        - { name: $top, in: query, schema: { type: integer, minimum: 0 } }
        - { name: $skip, in: query, schema: { type: integer, minimum: 0 } }
        - { name: $filter, in: query, schema: { type: string } }
      responses:
        2XX:
          description: ok
          content:
            application/json:
              schema:
                type: object
                properties:
                  "@odata.nextLink": { type: string, nullable: true }
                  value: { type: array, items: { type: object } }
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
      return { ok: true, result: req.kind === "read" ? { user: { id: "U1" } } : null };
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
      // The response declares `isLast`, so a client that loops on it stops
      // on the last page rather than asking for a token that never comes.
      expect(page1).toEqual({
        isLast: false,
        issues: [{ id: "1" }, { id: "2" }],
        nextPageToken: "2",
      });
      expect(s.provider.seen[0]?.page).toEqual({ cursor: null, size: 2 });

      const second = await fetch(`${s.url}/rest/api/3/search/jql`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ jql: "project = K", maxResults: 2, nextPageToken: "4" }),
      });
      expect(await second.json()).toEqual({ isLast: true, issues: [{ id: "5" }] });
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

describe("page markers the envelope declares", () => {
  it("writes has_more true while a page follows and false on the last", async () => {
    const s = await serving();
    try {
      const first = await fetch(`${s.url}/conversations.history?channel=C1&limit=3`);
      expect(await first.json()).toEqual({
        has_more: true,
        messages: [{ id: "1" }, { id: "2" }, { id: "3" }],
        response_metadata: { next_cursor: "3" },
      });
      const last = await fetch(`${s.url}/conversations.history?channel=C1&limit=3&cursor=3`);
      expect(await last.json()).toEqual({ has_more: false, messages: [{ id: "4" }, { id: "5" }] });
    } finally {
      await s.close();
    }
  });
});

describe("a continuation nested in the envelope", () => {
  it("serves Slack's ok and response_metadata.next_cursor, empty on the last page", async () => {
    const s = await serving();
    try {
      const first = await (await fetch(`${s.url}/conversations.list?limit=3`)).json();
      expect(first).toEqual({
        ok: true,
        channels: [{ id: "1" }, { id: "2" }, { id: "3" }],
        response_metadata: { next_cursor: "3" },
      });
      const last = await (await fetch(`${s.url}/conversations.list?limit=3&cursor=3`)).json();
      expect(last).toEqual({
        ok: true,
        channels: [{ id: "4" }, { id: "5" }],
        response_metadata: { next_cursor: "" },
      });
    } finally {
      await s.close();
    }
  });
});

describe("fields the contract fixes to one value", () => {
  it("fills a page envelope's const, single-member enum, and scalar default fields", async () => {
    const s = await serving();
    try {
      const page = await (await fetch(`${s.url}/drive/v3/files?pageSize=2`)).json();
      // `incompleteSearch` has no fixed value, so it is left to the provider
      // rather than invented.
      expect(page).toEqual({
        kind: "drive#fileList",
        files: [{ id: "1" }, { id: "2" }],
        nextPageToken: "2",
      });
    } finally {
      await s.close();
    }
  });

  it("fills a provider result's fixed fields, never its defaults or its own values", async () => {
    const s = await serving();
    try {
      const res = await fetch(`${s.url}/users.info?user=U1`);
      expect(s.provider.seen[0]?.kind).toBe("read");
      expect(await res.json()).toEqual({ ok: true, user: { id: "U1" } });
    } finally {
      await s.close();
    }
  });
});

describe("OData paging", () => {
  it("serves a followable @odata.nextLink and accepts $skiptoken or $skip as the cursor", async () => {
    const s = await serving();
    try {
      const first = await fetch(`${s.url}/users?$top=2&$filter=x`);
      const page1 = (await first.json()) as Record<string, unknown>;
      expect(page1.value).toEqual([{ id: "1" }, { id: "2" }]);
      const next = new URL(String(page1["@odata.nextLink"]));
      expect(next.origin).toBe(s.url);
      expect(next.pathname).toBe("/users");
      expect(next.searchParams.get("$skiptoken")).toBe("2");
      expect(next.searchParams.get("$top")).toBe("2");
      expect(next.searchParams.get("$filter")).toBe("x");

      const followed = (await (await fetch(next)).json()) as Record<string, unknown>;
      expect(followed.value).toEqual([{ id: "3" }, { id: "4" }]);
      expect(s.provider.seen[1]?.page).toEqual({ cursor: "2", size: 2 });

      const skipped = (await (await fetch(`${s.url}/users?$top=2&$skip=4`)).json()) as Record<
        string,
        unknown
      >;
      expect(skipped).toEqual({ value: [{ id: "5" }] });
      expect(s.provider.seen[2]?.page).toEqual({ cursor: "4", size: 2 });
    } finally {
      await s.close();
    }
  });

  it("drops a $skip the token already covers from the next link", async () => {
    const s = await serving();
    try {
      const page = (await (await fetch(`${s.url}/users?$top=1&$skip=1`)).json()) as Record<
        string,
        unknown
      >;
      const next = new URL(String(page["@odata.nextLink"]));
      expect(next.searchParams.get("$skip")).toBeNull();
      expect(next.searchParams.get("$skiptoken")).toBe("2");
    } finally {
      await s.close();
    }
  });
});

describe("a next-page URL in the response", () => {
  it("writes _links.next as a followable URL carrying the cursor", async () => {
    const s = await serving();
    try {
      const page = (await (await fetch(`${s.url}/wiki/api/v2/pages?limit=2`)).json()) as {
        results: unknown[];
        _links: { next: string };
      };
      expect(page.results).toEqual([{ id: "1" }, { id: "2" }]);
      const next = new URL(page._links.next);
      expect(next.origin).toBe(s.url);
      expect(next.searchParams.get("cursor")).toBe("2");
      const followed = (await (await fetch(next)).json()) as { results: unknown[] };
      expect(followed.results).toEqual([{ id: "3" }, { id: "4" }]);
    } finally {
      await s.close();
    }
  });
});

describe("a response declared as a bare array", () => {
  it("puts the continuation in a Link header as a URL carrying the cursor", async () => {
    const s = await serving();
    try {
      const res = await fetch(`${s.url}/rest/api/3/user/search?query=a&maxResults=2`);
      expect(await res.json()).toEqual([{ id: "1" }, { id: "2" }]);
      const link = /^<([^>]+)>; rel="next"$/.exec(res.headers.get("link") ?? "");
      const next = new URL(link?.[1] ?? "");
      expect(next.origin).toBe(s.url);
      expect(next.searchParams.get("startAt")).toBe("2");
      expect(next.searchParams.get("query")).toBe("a");
      expect(await (await fetch(next)).json()).toEqual([{ id: "3" }, { id: "4" }]);
    } finally {
      await s.close();
    }
  });
});
