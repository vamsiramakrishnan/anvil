import { describe, expect, it } from "vitest";
import { compile } from "./compile.js";
import { adaptDiscovery } from "./protocols/discovery.js";

function contract(bodyProperties: Record<string, unknown>, parameterName = "orgUnitPath") {
  return JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Directory", version: "1" },
    servers: [{ url: "https://directory.example.test" }],
    paths: {
      [`/units/{${parameterName}}`]: {
        patch: {
          operationId: "updateUnit",
          parameters: [
            { name: parameterName, in: "path", required: true, schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: { type: "object", properties: bodyProperties } },
            },
          },
          responses: { "200": { description: "Updated" } },
        },
      },
    },
  });
}

describe("enterprise contract regressions", () => {
  it("retains OPTIONS operations used by upload preflight and event discovery APIs", async () => {
    const spec = JSON.parse(contract({ name: { type: "string" } }));
    spec.paths = {
      "/files/content": {
        options: {
          operationId: "getUploadPreflight",
          responses: { "200": { description: "Upload constraints" } },
        },
      },
    };
    const air = await compile({ spec: JSON.stringify(spec) });
    expect(air.operations).toHaveLength(1);
    expect(air.operations[0]?.sourceRef).toMatchObject({
      method: "options",
      path: "/files/content",
      operationId: "getUploadPreflight",
    });
    expect(air.operations[0]?.effect.kind).toBe("read");
    expect(air.operations[0]?.state).not.toBe("approved");
  });
  it("preserves distinct path and body values when their agent names would collide", async () => {
    const air = await compile({
      spec: contract({ orgUnitPath: { type: "string" }, name: { type: "string" } }),
    });
    const op = air.operations[0];
    expect(op?.input.body?.projection).toBe("whole");
    expect(op?.input.schema).toMatchObject({
      properties: {
        org_unit_path: { type: "string" },
        body: {
          type: "object",
          properties: { orgUnitPath: { type: "string" }, name: { type: "string" } },
        },
      },
    });
    expect(air.diagnostics.filter((d) => d.level === "error")).toEqual([]);
    expect(op?.state).not.toBe("approved");
    expect(op?.idempotency.mode).toBe("none");
  });

  it("preserves body keys whose normalized spellings collide without merging them", async () => {
    const air = await compile({
      spec: contract({ externalId: { type: "string" }, external_id: { type: "integer" } }),
    });
    expect(air.operations[0]?.input.body).toMatchObject({
      projection: "whole",
      schema: { properties: { externalId: { type: "string" }, external_id: { type: "integer" } } },
    });
  });

  it("retains convenient field flags for unambiguous scalar bodies", async () => {
    const air = await compile({ spec: contract({ displayName: { type: "string" } }) });
    expect(air.operations[0]?.input.body?.projection).toBe("fields");
  });

  it("blocks an existing parameter that would collide with the whole-body envelope", async () => {
    const air = await compile({ spec: contract({ body: { type: "string" } }, "body") });
    expect(air.diagnostics).toContainEqual(
      expect.objectContaining({ code: "duplicate_agent_input_name", level: "error" }),
    );
    expect(air.operations[0]?.state).toBe("blocked");
  });

  it("refuses a lossy Discovery lowering when two methods share a resource template", async () => {
    const spec = JSON.stringify({
      kind: "discovery#restDescription",
      name: "places",
      version: "v1",
      rootUrl: "https://places.example.test/",
      resources: {
        places: {
          methods: {
            get: {
              id: "places.get",
              path: "v1/{+name}",
              httpMethod: "GET",
              parameters: { name: { type: "string", location: "path" } },
            },
          },
          resources: {
            photos: {
              methods: {
                getMedia: {
                  id: "photos.getMedia",
                  path: "v1/{+name}",
                  httpMethod: "GET",
                  parameters: { name: { type: "string", location: "path" } },
                },
              },
            },
          },
        },
      },
    });
    expect(() => adaptDiscovery(spec)).toThrow(/places.get.*photos.getMedia/);
    const air = await compile({ spec });
    expect(air.diagnostics).toContainEqual(
      expect.objectContaining({ code: "discovery_endpoint_collision", level: "error" }),
    );
  });

  it("retains root-level Discovery methods as well as resource methods", () => {
    const doc = adaptDiscovery(
      JSON.stringify({
        kind: "discovery#restDescription",
        name: "root",
        version: "v1",
        methods: { get: { id: "root.get", path: "v1/status", httpMethod: "GET" } },
        resources: {
          jobs: { methods: { list: { id: "jobs.list", path: "v1/jobs", httpMethod: "GET" } } },
        },
      }),
    );
    expect(doc.paths?.["/v1/status"]?.get).toBeDefined();
    expect(doc.paths?.["/v1/jobs"]?.get).toBeDefined();
  });

  it("preserves Discovery field masks and typed global defaults without exposing OAuth credentials", () => {
    const doc = adaptDiscovery(
      JSON.stringify({
        kind: "discovery#restDescription",
        name: "drive",
        version: "v3",
        auth: { oauth2: { scopes: { readonly: { description: "Read" } } } },
        parameters: {
          fields: { type: "string", location: "query" },
          prettyPrint: { type: "boolean", location: "query", default: "true" },
          quotaUser: { type: "string", location: "query" },
          access_token: { type: "string", location: "query" },
        },
        methods: {
          get: {
            id: "drive.about.get",
            path: "about",
            httpMethod: "GET",
            parameters: { fields: { type: "string", required: true, location: "query" } },
          },
        },
      }),
    );
    const op = doc.paths?.["/about"]?.get as { parameters: Array<Record<string, unknown>> };
    expect(op.parameters).toContainEqual(
      expect.objectContaining({ name: "fields", required: true }),
    );
    expect(op.parameters).toContainEqual(
      expect.objectContaining({ name: "prettyPrint", schema: { type: "boolean", default: true } }),
    );
    expect(op.parameters.map((p) => p.name)).not.toContain("access_token");
  });
});
