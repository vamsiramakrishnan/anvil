import { describe, expect, it } from "vitest";
import { approveOperations, compile } from "./compile.js";

const SPEC = `openapi: "3.0.3"
info: { title: Jobs, version: "1.0.0" }
paths:
  /jobs:
    post:
      operationId: createJob
      parameters:
        - name: request_key
          in: query
          schema: { type: string }
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                payload: { type: string }
                body_key: { type: string }
      responses: { "201": { description: created } }
`;

const API_KEY_SPEC = `openapi: "3.0.3"
info: { title: Jobs, version: "1.0.0" }
components:
  securitySchemes:
    ApiKeyAuth:
      type: apiKey
      in: header
      name: X-API-Key
security:
  - ApiKeyAuth: []
paths:
  /jobs:
    post:
      operationId: createJob
      responses: { "201": { description: created } }
`;

describe("idempotency carrier validation", () => {
  it("keeps an exact modeled query carrier approved and projects one safety input", async () => {
    const air = await compile({
      spec: SPEC,
      serviceId: "jobs",
      manifest: `operations:
  createJob:
    idempotency:
      strategy: required_request_key
      key_location: query
      parameter: request_key
    state: approved
`,
    });
    const operation = air.operations[0];
    expect(operation?.state).toBe("approved");
    expect(operation?.idempotency).toMatchObject({
      mode: "required",
      mechanism: "query",
      key: "request_key",
    });
    expect(operation?.retries.mode).toBe("safe");
    expect(operation?.input.schema?.properties).toHaveProperty("idempotency_key");
    expect(operation?.input.schema?.properties).not.toHaveProperty("request_key");
  });

  it("blocks an approved claim when the query coordinate is not in the source contract", async () => {
    const air = await compile({
      spec: SPEC,
      serviceId: "jobs",
      manifest: `operations:
  createJob:
    idempotency:
      strategy: required_request_key
      key_location: query
      parameter: invented_key
    state: approved
`,
    });
    const operation = air.operations[0];
    expect(operation?.state).toBe("blocked");
    expect(operation?.retries).toMatchObject({
      mode: "none",
      basis: "unproven",
      maxAttempts: 1,
    });
    expect(
      air.diagnostics.find((diagnostic) => diagnostic.code === "unsupported_idempotency_carrier"),
    ).toMatchObject({ level: "error", operationId: operation?.id });
  });

  it("preserves a body field spelling instead of treating every key as a header", async () => {
    const air = await compile({
      spec: SPEC,
      serviceId: "jobs",
      manifest: `operations:
  createJob:
    idempotency:
      strategy: required_request_key
      key_location: body
      field: body_key
    state: approved
`,
    });
    expect(air.operations[0]?.idempotency).toMatchObject({
      mode: "required",
      mechanism: "body",
      key: "body_key",
    });
    expect(air.operations[0]?.state).toBe("approved");
  });

  it("blocks derived keys when a modeled carrier requires an incompatible format", async () => {
    const constrained = SPEC.replace(
      "schema: { type: string }",
      "schema: { type: string, format: uuid }",
    );
    const air = await compile({
      spec: constrained,
      serviceId: "jobs",
      manifest: `operations:
  createJob:
    idempotency:
      strategy: key_supported
      key_location: query
      parameter: request_key
    state: approved
`,
    });

    expect(air.operations[0]?.state).toBe("blocked");
    expect(air.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        code: "unsupported_idempotency_carrier",
      }),
    );
    expect(air.diagnostics.map((diagnostic) => diagnostic.message).join("\n")).toMatch(
      /request-fingerprint keys cannot be proven/i,
    );
  });

  it("blocks an idempotency carrier that aliases the declared API-key credential", async () => {
    const air = await compile({
      spec: API_KEY_SPEC,
      serviceId: "jobs",
      manifest: `operations:
  createJob:
    idempotency:
      strategy: required_request_key
      key_location: header
      header: X-API-Key
    state: approved
`,
    });

    expect(air.operations[0]?.state).toBe("blocked");
    expect(air.operations[0]?.retries).toMatchObject({ mode: "none", maxAttempts: 1 });
    expect(air.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        code: "idempotency_auth_carrier_conflict",
      }),
    );
  });

  it("advertises the source constraint for an explicit caller-supplied key", async () => {
    const constrained = SPEC.replace(
      "schema: { type: string }",
      "schema: { type: string, format: uuid, maxLength: 36 }",
    );
    const air = await compile({
      spec: constrained,
      serviceId: "jobs",
      manifest: `operations:
  createJob:
    idempotency:
      strategy: required_request_key
      key_location: query
      parameter: request_key
    state: approved
`,
    });

    const operation = air.operations[0];
    if (!operation) throw new Error("fixture operation missing");
    expect(operation.state).toBe("approved");
    const properties = operation.input.schema?.properties as
      | Record<string, Record<string, unknown>>
      | undefined;
    const keySchema = properties?.idempotency_key;
    expect(keySchema?.allOf).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "string", format: "uuid", maxLength: 36 }),
        expect.objectContaining({ type: "string", minLength: 1, maxLength: 255 }),
      ]),
    );
  });

  it("refuses a later approval when imported AIR has an unprovable carrier", async () => {
    const air = await compile({ spec: SPEC, serviceId: "jobs" });
    const operation = air.operations[0];
    if (!operation) throw new Error("fixture operation missing");
    operation.idempotency = {
      mode: "required",
      mechanism: "path",
      key: "invented_key",
      keyDerivation: "client_supplied",
    };
    approveOperations(air, [operation.id]);
    expect(operation.state).toBe("blocked");
    expect(operation.reviewNotes.at(-1)).toMatch(/Approval refused/);
  });
});
