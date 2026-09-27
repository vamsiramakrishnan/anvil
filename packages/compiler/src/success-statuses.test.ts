import { describe, expect, it } from "vitest";
import { compile } from "./compile.js";

/**
 * Declared success statuses, and the sub-resource state action they reveal:
 * Jira's `POST /issue/{id}/transitions` answers 204 and creates nothing.
 */
const withBody = { "application/json": { schema: { type: "object" } } };
const idParam = { name: "issueIdOrKey", in: "path", required: true, schema: { type: "string" } };
const spec = JSON.stringify({
  openapi: "3.0.1",
  info: { title: "Jira-like", version: "1" },
  servers: [{ url: "https://example.atlassian.net" }],
  paths: {
    "/rest/api/3/issue/{issueIdOrKey}": {
      put: {
        operationId: "editIssue",
        parameters: [idParam],
        requestBody: { content: withBody },
        responses: {
          "200": { description: "returnIssue=true", content: withBody },
          "204": { description: "ok" },
        },
      },
    },
    "/rest/api/3/issue/{issueIdOrKey}/transitions": {
      post: {
        operationId: "doTransition",
        parameters: [idParam],
        requestBody: { content: withBody },
        responses: { "204": { description: "ok" }, "404": { description: "missing" } },
      },
    },
    "/rest/api/3/issue/{issueIdOrKey}/comment": {
      post: {
        operationId: "addComment",
        parameters: [idParam],
        requestBody: { content: withBody },
        responses: { "201": { description: "created", content: withBody } },
      },
    },
    "/rest/api/3/issue": {
      post: {
        operationId: "createIssue",
        requestBody: { content: withBody },
        responses: { "204": { description: "created elsewhere" } },
      },
    },
  },
});

describe("declared success statuses and sub-resource actions", () => {
  it("classifies a 204 POST under an item as an action, not a create", async () => {
    const air = await compile({ spec, serviceId: "jira" });
    const byId = (id: string) => air.operations.find((o) => o.sourceRef.operationId === id);
    expect(byId("doTransition")?.effect).toMatchObject({ kind: "mutation", action: "other" });
    expect(byId("doTransition")?.confirmation).toEqual(byId("addComment")?.confirmation);
    expect(byId("doTransition")?.output.successStatuses).toEqual([204]);
    // A POST that answers 201 with a body is still a create, and so is a 204
    // POST to a collection: only a literal segment under an item is an action.
    expect(byId("addComment")?.effect.action).toBe("create");
    expect(byId("addComment")?.output.successStatuses).toEqual([201]);
    expect(byId("createIssue")?.effect.action).toBe("create");
  });

  it("records every exact 2xx code an operation declares, ascending", async () => {
    const air = await compile({ spec, serviceId: "jira" });
    const edit = air.operations.find((o) => o.sourceRef.operationId === "editIssue");
    expect(edit?.output.successStatuses).toEqual([200, 204]);
  });
});

describe("declared success headers", () => {
  it("records every 2xx response's headers once, as first spelled, without Content-Type", async () => {
    const air = await compile({
      spec: JSON.stringify({
        openapi: "3.0.1",
        info: { title: "Table API", version: "1" },
        servers: [{ url: "https://instance.example" }],
        paths: {
          "/api/now/table/incident": {
            get: {
              responses: {
                "200": {
                  description: "ok",
                  headers: {
                    Link: { schema: { type: "string" } },
                    "X-Total-Count": { schema: { type: "integer" } },
                    "Content-Type": { schema: { type: "string" } },
                  },
                  content: withBody,
                },
                "206": {
                  description: "partial",
                  headers: { link: { schema: { type: "string" } } },
                },
                "429": { description: "slow down", headers: { "Retry-After": {} } },
              },
            },
          },
          "/plain": { get: { responses: { "200": { description: "ok", content: withBody } } } },
        },
      }),
      serviceId: "table",
    });
    const headers = (path: string) =>
      air.operations.find((o) => o.sourceRef.path === path)?.output.headers;
    expect(headers("/api/now/table/incident")).toEqual(["Link", "X-Total-Count"]);
    expect(headers("/plain")).toBeUndefined();
  });
});
