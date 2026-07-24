import { describe, expect, it } from "vitest";
import { compile } from "./compile.js";

const spec = `openapi: 3.0.3
info: { title: Workspace BFF, version: 1.0.0 }
paths:
  /workspace/dashboard-view:
    get:
      operationId: getWorkspaceDashboard
      summary: Get the workspace dashboard screen
      responses:
        "200":
          description: Dashboard envelope
          content:
            application/json:
              schema:
                type: object
                properties:
                  pageTitle: { type: string }
                  columns:
                    type: array
                    items: { type: string }
                  content:
                    type: object
                    properties:
                      featureFlags:
                        type: object
                        additionalProperties: { type: boolean }
                      actions:
                        type: array
                        items:
                          type: object
                          properties:
                            href: { type: string }
`;

describe("compiler preserves UI-projection evidence without classifying it", () => {
  it("retains the source path and materialized response envelope for downstream audit", async () => {
    const air = await compile({ spec, serviceId: "workspace" });
    const operation = air.operations[0];

    expect(operation?.sourceRef).toMatchObject({
      path: "/workspace/dashboard-view",
      method: "get",
      operationId: "getWorkspaceDashboard",
    });
    expect(operation?.output.schema).toMatchObject({
      type: "object",
      properties: {
        pageTitle: { type: "string" },
        columns: { type: "array" },
        content: {
          type: "object",
          properties: {
            featureFlags: { type: "object" },
            actions: { type: "array" },
          },
        },
      },
    });
    // The compiler preserves facts. The refinement detector owns the question
    // of whether this screen projection is a stable agent capability.
    expect(air.diagnostics.some((diagnostic) => diagnostic.code === "ui_projection_contract")).toBe(
      false,
    );
  });
});
