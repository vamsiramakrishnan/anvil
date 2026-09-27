import { describe, expect, it } from "vitest";
import { classifyEffect } from "./classify.js";
import { compile } from "./compile.js";
import { classifyPagination } from "./pagination-inference.js";

/**
 * Paging and action shapes taken from real vendor contracts: Jira's enhanced
 * search, a continuation token in the request and response bodies.
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
