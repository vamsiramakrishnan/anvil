import { describe, expect, it } from "vitest";
import { compile } from "./compile.js";

/**
 * Wire fidelity at compile time: what the source declared about how a request
 * is put on the wire has to survive lowering, and what the runtime will refuse
 * has to be said here first, so a reviewer never approves a tool that can only
 * ever fail.
 */
const spec = (paths: string) => `
openapi: 3.0.3
info: { title: Fidelity, version: "1.0.0" }
servers: [{ url: https://api.example.com }]
paths:
${paths}
`;

describe("parameter serialization survives lowering", () => {
  it("carries a declared style and explode, and leaves an undeclared one absent", async () => {
    const air = await compile({
      serviceId: "fid",
      spec: spec(`
  /items:
    get:
      operationId: listItems
      parameters:
        - name: ids
          in: query
          style: pipeDelimited
          explode: false
          schema: { type: array, items: { type: string } }
        - name: filter
          in: query
          style: deepObject
          schema: { type: object, additionalProperties: { type: string } }
        - name: tags
          in: query
          schema: { type: array, items: { type: string } }
        - name: bogus
          in: query
          style: somethingElse
          schema: { type: string }
      responses:
        "200": { description: ok }
`),
    });
    const op = air.operations.find((o) => o.sourceRef.operationId === "listItems");
    const param = (name: string) => op?.input.params.find((p) => p.name === name);
    expect(param("ids")?.style).toBe("pipeDelimited");
    expect(param("ids")?.explode).toBe(false);
    expect(param("filter")?.style).toBe("deepObject");
    expect(param("filter")?.explode).toBeUndefined();
    // Absent stays absent: the runtime fills OpenAPI's per-location default at
    // bind time, and a document from before the field hashes exactly as before.
    expect(param("tags")?.style).toBeUndefined();
    expect(param("tags")?.explode).toBeUndefined();
    expect("style" in (param("tags") ?? {})).toBe(false);
    // A style OpenAPI does not define is dropped, not lowered into a value no
    // serializer could act on.
    expect(param("bogus")?.style).toBeUndefined();
  });
});

describe("request body content types", () => {
  it("prefers JSON, then any encodable type, then the source's first declaration", async () => {
    const air = await compile({
      serviceId: "fid",
      spec: spec(`
  /a:
    post:
      operationId: jsonWins
      requestBody:
        content:
          text/plain: { schema: { type: string } }
          application/json: { schema: { type: object, properties: { x: { type: string } } } }
      responses: { "200": { description: ok } }
  /b:
    post:
      operationId: formWins
      requestBody:
        content:
          application/octet-stream: { schema: { type: string, format: binary } }
          application/x-www-form-urlencoded: { schema: { type: object, properties: { x: { type: string } } } }
      responses: { "200": { description: ok } }
  /c:
    post:
      operationId: octetOnly
      requestBody:
        content:
          application/octet-stream: { schema: { type: string, format: binary } }
      responses: { "200": { description: ok } }
`),
    });
    const body = (id: string) =>
      air.operations.find((o) => o.sourceRef.operationId === id)?.input.body;
    expect(body("jsonWins")?.contentType).toBe("application/json");
    expect(body("jsonWins")?.projection).toBe("fields");
    expect(body("formWins")?.contentType).toBe("application/x-www-form-urlencoded");
    expect(body("formWins")?.fields.map((f) => f.name)).toEqual(["x"]);
    // Kept verbatim, so the diagnostic and the runtime refusal name the type
    // the source actually declared rather than one Anvil substituted.
    expect(body("octetOnly")?.contentType).toBe("application/octet-stream");
  });

  it("diagnoses a body the runtime cannot encode and holds the operation for review", async () => {
    const air = await compile({
      serviceId: "fid",
      spec: spec(`
  /upload:
    post:
      operationId: uploadRaw
      requestBody:
        required: true
        content:
          application/octet-stream: { schema: { type: string, format: binary } }
      responses: { "200": { description: ok } }
  /form:
    post:
      operationId: submitForm
      requestBody:
        content:
          application/x-www-form-urlencoded: { schema: { type: object, properties: { x: { type: string } } } }
      responses: { "200": { description: ok } }
  /files:
    post:
      operationId: uploadFile
      requestBody:
        content:
          multipart/form-data:
            schema:
              type: object
              properties:
                file: { type: string, format: binary }
                note: { type: string }
      responses: { "200": { description: ok } }
`),
    });
    const raw = air.operations.find((o) => o.sourceRef.operationId === "uploadRaw");
    const diagnostics = air.diagnostics.filter((d) => d.code === "body_content_type_unsupported");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.operationId).toBe(raw?.id);
    expect(diagnostics[0]?.level).toBe("warning");
    expect(diagnostics[0]?.message).toContain("application/octet-stream");
    expect(raw?.state).toBe("review_required");
    expect(raw?.reviewNotes.join(" ")).toContain("cannot be encoded");
    // The encodable ones are not flagged.
    for (const id of ["submitForm", "uploadFile"]) {
      const op = air.operations.find((o) => o.sourceRef.operationId === id);
      expect(op?.reviewNotes.join(" ")).not.toContain("cannot be encoded");
    }
  });

  it("does not override a manifest's explicit decision, so the human decision stands", async () => {
    const air = await compile({
      serviceId: "fid",
      spec: spec(`
  /upload:
    post:
      operationId: uploadRaw
      requestBody:
        content:
          text/plain: { schema: { type: string } }
      responses: { "200": { description: ok } }
`),
      manifest: `
operations:
  uploadRaw:
    state: blocked
`,
    });
    const raw = air.operations.find((o) => o.sourceRef.operationId === "uploadRaw");
    expect(raw?.state).toBe("blocked");
    expect(air.diagnostics.some((d) => d.code === "body_content_type_unsupported")).toBe(true);
  });
});
