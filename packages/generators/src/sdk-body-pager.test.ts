import { approveOperations, compile } from "@anvil/compiler";
import { describe, expect, it } from "vitest";
import { sdkPlan } from "./sdk/index.js";

/**
 * A POST search that pages with a token in its request body. An SDK pager can
 * set the token only when the body is projected into fields; a whole body has
 * no argument a pager could fill, so no pager is promised.
 */
const spec = (bodyProps: Record<string, unknown>) =>
  JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Body pager", version: "1" },
    servers: [{ url: "https://api.example.test" }],
    paths: {
      "/search": {
        post: {
          operationId: "searchIssues",
          requestBody: {
            content: { "application/json": { schema: { type: "object", properties: bodyProps } } },
          },
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      issues: { type: "array", items: { type: "object" } },
                      nextPageToken: { type: "string" },
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

async function pagerFor(bodyProps: Record<string, unknown>) {
  const compiled = await compile({ spec: spec(bodyProps), serviceId: "tracker" });
  const air = approveOperations(
    compiled,
    compiled.operations.map((o) => o.id),
  );
  const op = sdkPlan(air).operations[0];
  expect(op, "the search operation is approved and planned").toBeDefined();
  return { op, pagination: air.operations[0]?.pagination };
}

describe("SDK pagers for body-carried continuation tokens", () => {
  it("pages through the projected body field", async () => {
    const { op, pagination } = await pagerFor({
      text: { type: "string" },
      maxResults: { type: "integer" },
      nextPageToken: { type: "string" },
    });
    expect(pagination?.in).toBe("body");
    expect(op?.pager).toMatchObject({ style: "cursor", cursorParam: "nextPageToken" });
    expect(op?.body?.fields.map((f) => f.key)).toContain(op?.pager?.cursorKey);
  });

  it("promises no pager when the token sits inside a whole body", async () => {
    const { op, pagination } = await pagerFor({
      text: { type: "string" },
      fields: { type: "array", items: { type: "string" } },
      nextPageToken: { type: "string" },
    });
    expect(pagination?.in).toBe("body");
    expect(op?.body?.projection).toBe("whole");
    expect(op?.pager).toBeUndefined();
  });
});
