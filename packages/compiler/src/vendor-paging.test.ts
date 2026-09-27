import { describe, expect, it } from "vitest";
import { classifyEffect } from "./classify.js";
import { compile } from "./compile.js";
import { classifyPagination } from "./pagination-inference.js";

/**
 * Paging and action shapes taken from real vendor contracts: Jira's enhanced
 * search (a continuation token in the request and response bodies), OData
 * collections (Microsoft Graph's `@odata.nextLink`).
 */
const issueSearchResult = {
  type: "object",
  properties: {
    isLast: { type: "boolean" },
    issues: { type: "array", items: { type: "object", properties: { id: { type: "string" } } } },
    nextPageToken: { type: "string" },
  },
};

function jiraLike(): string {
  return JSON.stringify({
    openapi: "3.0.1",
    info: { title: "Jira-like", version: "1" },
    servers: [{ url: "https://example.atlassian.net" }],
    paths: {
      "/rest/api/3/search/jql": {
        get: {
          operationId: "searchIssues",
          parameters: [
            { name: "jql", in: "query", schema: { type: "string" } },
            { name: "nextPageToken", in: "query", schema: { type: "string" } },
            { name: "maxResults", in: "query", schema: { type: "integer", default: 50 } },
          ],
          responses: {
            "200": {
              description: "ok",
              content: { "application/json": { schema: issueSearchResult } },
            },
          },
        },
        post: {
          operationId: "searchIssuesPost",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    jql: { type: "string" },
                    fields: { type: "array", items: { type: "string" } },
                    maxResults: { type: "integer", default: 50 },
                    nextPageToken: { type: "string" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "ok",
              content: { "application/json": { schema: issueSearchResult } },
            },
          },
        },
      },
    },
  });
}

function graphLike(): string {
  const collection = {
    type: "object",
    properties: {
      "@odata.count": { type: "integer" },
      "@odata.nextLink": { type: "string" },
      value: { type: "array", items: { type: "object", properties: { id: { type: "string" } } } },
    },
  };
  return JSON.stringify({
    openapi: "3.0.4",
    info: { title: "Graph-like", version: "1" },
    servers: [{ url: "https://graph.microsoft.com/v1.0" }],
    paths: {
      "/users": {
        get: {
          operationId: "users.user.ListUser",
          parameters: [
            { name: "$top", in: "query", schema: { type: "integer", minimum: 0 } },
            { name: "$skip", in: "query", schema: { type: "integer", minimum: 0 } },
            { name: "$search", in: "query", schema: { type: "string" } },
          ],
          responses: {
            "2XX": { description: "ok", content: { "application/json": { schema: collection } } },
          },
        },
      },
      "/users/{user-id}/memberOf": {
        get: {
          operationId: "users.ListMemberOf",
          parameters: [
            { name: "user-id", in: "path", required: true, schema: { type: "string" } },
            { name: "$top", in: "query", schema: { type: "integer" } },
          ],
          responses: {
            "2XX": { description: "ok", content: { "application/json": { schema: collection } } },
          },
        },
      },
    },
  });
}

describe("body-token pagination", () => {
  it("pages a POST search whose token rides the request and response bodies", async () => {
    const air = await compile({ spec: jiraLike(), serviceId: "jira" });
    const post = air.operations.find((o) => o.sourceRef.operationId === "searchIssuesPost");
    expect(post?.effect).toMatchObject({ kind: "read", action: "search" });
    expect(post?.pagination).toEqual({
      style: "cursor",
      cursorParam: "nextPageToken",
      in: "body",
      nextField: "nextPageToken",
      itemsField: "issues",
      pageSizeParam: "maxResults",
      defaultPageSize: 50,
    });
  });

  it("pages the GET form with the same token as a query parameter", async () => {
    const air = await compile({ spec: jiraLike(), serviceId: "jira" });
    const get = air.operations.find((o) => o.sourceRef.operationId === "searchIssues");
    expect(get?.pagination).toMatchObject({
      style: "cursor",
      cursorParam: "nextPageToken",
      nextField: "nextPageToken",
      pageSizeParam: "maxResults",
    });
    expect(get?.pagination?.in).toBeUndefined();
  });

  it("does not read a token-named body field as paging without a response token", () => {
    const search = classifyEffect("post", "searchThings /things/search");
    const body = {
      contentType: "application/json",
      required: false,
      projection: "whole" as const,
      fields: [],
      schema: { type: "object", properties: { nextPageToken: { type: "string" } } },
    };
    const out = { type: "object", properties: { things: { type: "array" } } };
    expect(classifyPagination(search.effect, search.effect.action, [], out, body)).toBeUndefined();
  });
});

describe("OData paging", () => {
  it("reads $top/$skip with @odata.nextLink as link paging on $skiptoken", async () => {
    const air = await compile({ spec: graphLike(), serviceId: "graph" });
    const users = air.operations.find((o) => o.sourceRef.path === "/users");
    expect(users?.pagination).toEqual({
      style: "link",
      cursorParam: "$skiptoken",
      nextField: "@odata.nextLink",
      itemsField: "value",
      pageSizeParam: "$top",
    });
    const memberOf = air.operations.find((o) => o.sourceRef.path === "/users/{user-id}/memberOf");
    expect(memberOf?.pagination).toMatchObject({ style: "link", nextField: "@odata.nextLink" });
  });
});

describe("a next-page URL in the response", () => {
  it("reads a cursor handed back in _links.next as link paging", async () => {
    const spec = JSON.stringify({
      openapi: "3.0.1",
      info: { title: "Confluence-like", version: "2" },
      servers: [{ url: "https://example.atlassian.net/wiki/api/v2" }],
      paths: {
        "/pages": {
          get: {
            operationId: "getPages",
            parameters: [
              { name: "cursor", in: "query", schema: { type: "string" } },
              { name: "limit", in: "query", schema: { type: "integer", maximum: 250 } },
            ],
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        results: { type: "array", items: { type: "object" } },
                        _links: {
                          type: "object",
                          properties: { next: { type: "string" }, base: { type: "string" } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    const air = await compile({ spec, serviceId: "confluence" });
    expect(air.operations[0]?.pagination).toEqual({
      style: "link",
      cursorParam: "cursor",
      nextField: "_links.next",
      itemsField: "results",
      pageSizeParam: "limit",
      maxPageSize: 250,
    });
  });
});

describe("reads that return one resource", () => {
  const spec = (paths: Record<string, unknown>) =>
    JSON.stringify({
      openapi: "3.0.1",
      info: { title: "Singletons", version: "1" },
      servers: [{ url: "https://api.example.test" }],
      paths,
    });
  const get = (schema: unknown) => ({
    get: {
      responses: { "200": { description: "ok", content: { "application/json": { schema } } } },
    },
  });
  const user = {
    type: "object",
    properties: {
      id: { type: "string" },
      businessPhones: { type: "array", items: { type: "string" } },
      imAddresses: { type: "array", items: { type: "string" } },
    },
  };

  it("reads GET /me and Slack's users.info as get, and a collection as list", async () => {
    const air = await compile({
      spec: spec({
        "/me": get(user),
        "/me/drive": get({
          allOf: [
            { properties: { id: { type: "string" } } },
            { properties: { name: { type: "string" } } },
          ],
        }),
        "/users.info": get({ type: "object", properties: { ok: { type: "boolean" }, user } }),
        "/users": get({ type: "object", properties: { value: { type: "array", items: user } } }),
        "/tags": get({ type: "array", items: { type: "string" } }),
        "/ping": get({ type: "object" }),
      }),
      serviceId: "people",
    });
    const action = (path: string) =>
      air.operations.find((o) => o.sourceRef.path === path)?.effect.action;
    expect(action("/me")).toBe("get");
    expect(action("/me/drive")).toBe("get");
    expect(action("/users.info")).toBe("get");
    expect(action("/users")).toBe("list");
    expect(action("/tags")).toBe("list");
    // Nothing declared: no evidence either way, so the default stands.
    expect(action("/ping")).toBe("list");
  });
});

describe("reads with no path id that return one object or a stream", () => {
  // Slack declares a field that is one of several objects as a draft-04 tuple
  // with no type; the Swagger 2.0 converter makes it an untyped items union.
  const union = (...branches: unknown[]) => ({ items: branches });
  const user = union(
    { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } },
    { type: "object", properties: { id: { type: "string" }, is_bot: { type: "boolean" } } },
  );

  it("reads Slack's users.info and conversations.info as get", async () => {
    const swagger = JSON.stringify({
      swagger: "2.0",
      info: { title: "Slack", version: "1" },
      host: "slack.com",
      basePath: "/api",
      produces: ["application/json"],
      paths: {
        "/users.info": {
          get: {
            operationId: "users_info",
            parameters: [{ name: "user", in: "query", type: "string" }],
            responses: {
              "200": {
                description: "ok",
                schema: {
                  type: "object",
                  properties: { ok: { type: "boolean", enum: [true] }, user },
                },
              },
            },
          },
        },
        "/conversations.info": {
          get: {
            operationId: "conversations_info",
            parameters: [{ name: "channel", in: "query", type: "string" }],
            responses: {
              "200": {
                description: "ok",
                schema: {
                  type: "object",
                  properties: { ok: { type: "boolean", enum: [true] }, channel: user },
                },
              },
            },
          },
        },
        "/users.list": {
          get: {
            operationId: "users_list",
            responses: {
              "200": {
                description: "ok",
                schema: {
                  type: "object",
                  properties: { ok: { type: "boolean" }, members: { type: "array", items: user } },
                },
              },
            },
          },
        },
      },
    });
    const air = await compile({ spec: swagger, serviceId: "slack" });
    const action = (path: string) =>
      air.operations.find((o) => o.sourceRef.path === path)?.effect.action;
    expect(action("/users.info")).toBe("get");
    expect(action("/conversations.info")).toBe("get");
    expect(action("/users.list")).toBe("list");
  });

  it("reads a content stream as get", async () => {
    const air = await compile({
      spec: JSON.stringify({
        openapi: "3.0.1",
        info: { title: "Drive items", version: "1" },
        servers: [{ url: "https://graph.example.test" }],
        paths: {
          "/drives/{drive-id}/items/{driveItem-id}/content": {
            parameters: [
              { name: "drive-id", in: "path", required: true, schema: { type: "string" } },
              { name: "driveItem-id", in: "path", required: true, schema: { type: "string" } },
            ],
            get: {
              responses: {
                "2XX": {
                  description: "Retrieved media content",
                  content: {
                    "application/octet-stream": { schema: { type: "string", format: "binary" } },
                  },
                },
              },
            },
          },
          "/reports/{id}/pdf": {
            get: {
              parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
              responses: { "200": { description: "ok", content: { "application/pdf": {} } } },
            },
          },
        },
      }),
      serviceId: "files",
    });
    const action = (path: string) =>
      air.operations.find((o) => o.sourceRef.path === path)?.effect.action;
    expect(action("/drives/{drive-id}/items/{driveItem-id}/content")).toBe("get");
    expect(action("/reports/{id}/pdf")).toBe("get");
  });
});
