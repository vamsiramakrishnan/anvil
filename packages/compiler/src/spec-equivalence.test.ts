import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AirDocument, Operation } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { compile } from "./compile.js";
import { parseSpec } from "./parse.js";

/**
 * PR 2 acceptance: equivalent Swagger 2.0 and OpenAPI 3.0 specs must produce
 * semantically equivalent AIR. The fixtures describe the same payments-like API
 * in each dialect; the comparison covers everything an agent acts on and
 * excludes only provenance (service.source.kind, sourceRef internals).
 */

const fixture = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../fixtures/${rel}`, import.meta.url)), "utf8");

const swagger2 = fixture("payments-swagger2.yaml");
const openapi3 = fixture("payments-openapi3.yaml");

/** Everything semantically meaningful about one operation, provenance stripped. */
function operationView(op: Operation) {
  return {
    id: op.id,
    canonicalName: op.canonicalName,
    displayName: op.displayName,
    description: op.description,
    tags: [...op.tags].sort(),
    effect: op.effect,
    idempotency: op.idempotency,
    retries: {
      mode: op.retries.mode,
      basis: op.retries.basis,
      maxAttempts: op.retries.maxAttempts,
    },
    confirmation: { required: op.confirmation.required, risk: op.confirmation.risk },
    params: op.input.params
      .map((p) => ({ name: p.name, in: p.in, required: p.required, schema: p.schema }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    body: op.input.body
      ? {
          contentType: op.input.body.contentType,
          required: op.input.body.required,
          projection: op.input.body.projection,
          schema: op.input.body.schema,
          fields: op.input.body.fields
            .map((f) => ({ name: f.name, required: f.required, schema: f.schema }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        }
      : undefined,
    inputSchema: op.input.schema,
    output: op.output.schema,
    errors: op.errors
      .map((e) => ({ code: e.code, status: e.upstream?.httpStatus }))
      .sort((a, b) => (a.status ?? 0) - (b.status ?? 0)),
    auth: { type: op.auth.type, scopes: op.auth.scopes, principal: op.auth.principal },
    deprecated: op.deprecated,
    state: op.state,
    cliCommand: op.cli.command,
    mcpToolName: op.mcp.toolName,
    capabilityId: op.capabilityId,
  };
}

/** The whole document's semantic view, order-normalized. */
function semanticView(air: AirDocument) {
  return {
    serviceVersion: air.service.version,
    servers: air.service.servers.map((s) => s.url),
    serviceAuth: {
      type: air.service.auth.type,
      scopes: air.service.auth.scopes,
      principal: air.service.auth.principal,
    },
    schemas: Object.keys(air.schemas).sort(),
    capabilities: air.capabilities
      .map((c) => ({ id: c.id, source: c.source, operationIds: [...c.operationIds].sort() }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    operations: air.operations.map(operationView).sort((a, b) => a.id.localeCompare(b.id)),
  };
}

describe("Swagger 2.0 / OpenAPI 3.0 equivalence", () => {
  it("compiles equivalent specs to semantically equivalent AIR", async () => {
    const fromSwagger = await compile({ spec: swagger2, serviceId: "payments" });
    const fromOpenapi = await compile({ spec: openapi3, serviceId: "payments" });
    // Provenance is the one permitted difference.
    expect(fromSwagger.service.source.kind).toBe("swagger");
    expect(fromOpenapi.service.source.kind).toBe("openapi");
    expect(semanticView(fromSwagger)).toEqual(semanticView(fromOpenapi));
  });

  it("carries host/basePath/schemes into the same server URL as 3.0 servers", async () => {
    const air = await compile({ spec: swagger2, serviceId: "payments" });
    expect(air.service.servers.map((s) => s.url)).toEqual(["https://payments.example.com/v1"]);
  });

  it("converts a 2.0 body parameter into the preserved body model", async () => {
    const air = await compile({ spec: swagger2, serviceId: "payments" });
    const refund = air.operations.find((o) => o.canonicalName === "create_refund");
    expect(refund?.input.body?.contentType).toBe("application/json");
    expect(refund?.input.body?.required).toBe(true);
    expect(refund?.input.body?.projection).toBe("fields");
    expect(refund?.input.body?.fields.map((f) => f.name).sort()).toEqual([
      "amount",
      "currency",
      "reason",
    ]);
    // Body fields never leak into params.
    expect(refund?.input.params.every((p) => p.in !== "body")).toBe(true);
  });

  it("converts required formData into a required urlencoded body (upgrade gap closed)", async () => {
    const air = await compile({ spec: swagger2, serviceId: "payments" });
    const receipt = air.operations.find((o) => o.canonicalName === "email_receipt");
    expect(receipt?.input.body?.contentType).toBe("application/x-www-form-urlencoded");
    // The upgrader drops body-level requiredness for formData; parseSpec restores it.
    expect(receipt?.input.body?.required).toBe(true);
    expect(receipt?.input.body?.fields.find((f) => f.name === "email")?.required).toBe(true);
    expect(receipt?.input.body?.fields.find((f) => f.name === "note")?.required).toBe(false);
  });

  it("maps 2.0 securityDefinitions to the same auth semantics as 3.0", async () => {
    const air = await compile({ spec: swagger2, serviceId: "payments" });
    const refund = air.operations.find((o) => o.canonicalName === "create_refund");
    expect(refund?.auth.type).toBe("oauth2_client_credentials");
    expect(refund?.auth.scopes).toEqual(["payments.read"]);
    expect(refund?.auth.principal).toBe("service");
  });

  it("derives the same idempotency from x-idempotent in both dialects", async () => {
    for (const spec of [swagger2, openapi3]) {
      const air = await compile({ spec, serviceId: "payments" });
      const receipt = air.operations.find((o) => o.canonicalName === "email_receipt");
      // Declared idempotent: retries become provably safe...
      expect(receipt?.idempotency.mode).toBe("natural");
      expect(receipt?.retries.mode).toBe("safe");
      expect(receipt?.retries.basis).toBe("natural_idempotent");
      // ...but a risky (comms) mutation still confirms — the extension never
      // loosens the approval gate.
      expect(receipt?.confirmation.required).toBe(true);
      // The declaration is recorded as spec-sourced evidence, reviewable later.
      const claim = receipt?.evidence.claims.find(
        (c) => c.predicate === "idempotency.mode" && c.source === "spec",
      );
      expect(claim?.value).toBe("natural");
    }
  });

  it("preserves deprecation and tag-based capability grouping across dialects", async () => {
    for (const spec of [swagger2, openapi3]) {
      const air = await compile({ spec, serviceId: "payments" });
      const reports = air.operations.find((o) => o.canonicalName === "export_reports");
      expect(reports?.deprecated).toBe(true);
      expect(air.capabilities.map((c) => c.id).sort()).toEqual([
        "payments.customers",
        "payments.payments",
        "payments.receipts",
        "payments.refunds",
        "payments.reports",
      ]);
    }
  });
});

describe("stable operation identity", () => {
  /** Reverse the `paths` key order without touching anything else. */
  function reversePaths(specText: string): string {
    const doc = parseYaml(specText) as { paths: Record<string, unknown> };
    doc.paths = Object.fromEntries(Object.entries(doc.paths).reverse());
    return stringifyYaml(doc);
  }

  it("derives the same ids when the spec's paths are reordered", async () => {
    const original = await compile({ spec: swagger2, serviceId: "payments" });
    const reordered = await compile({ spec: reversePaths(swagger2), serviceId: "payments" });
    const ids = (air: AirDocument) => air.operations.map((o) => o.id).sort();
    expect(ids(reordered)).toEqual(ids(original));
    // The op without an operationId derives its id from service+method+path.
    expect(ids(original)).toContain("payments.payments.list");
  });

  it("keeps collision disambiguation independent of source ordering", async () => {
    // Two DELETEs that collide on command AND share every concrete path
    // segment, forcing the method/index fallback — the worst case for
    // order-sensitivity.
    const specFor = (paths: string[]) => `openapi: 3.0.0
info: { title: things, version: 1.0.0 }
paths:
${paths.join("\n")}
`;
    const a = `  /things/{a}:
    delete:
      responses: { "204": { description: gone } }`;
    const b = `  /things/{a}/{b}:
    delete:
      responses: { "204": { description: gone } }`;
    const forward = await compile({ spec: specFor([a, b]), serviceId: "things" });
    const backward = await compile({ spec: specFor([b, a]), serviceId: "things" });
    const ids = (air: AirDocument) => air.operations.map((o) => o.id).sort();
    expect(ids(forward)).toEqual(ids(backward));
  });
});

describe("OpenAPI 3.1", () => {
  const spec31 = `openapi: 3.1.0
info: { title: Ledger, version: 1.0.0 }
servers:
  - url: https://ledger.example.com
paths:
  /entries:
    post:
      operationId: createEntry
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [amount]
              properties:
                amount: { type: integer }
                memo:
                  # JSON Schema 2020-12 union type — invalid in 3.0, legal in 3.1.
                  type: [string, "null"]
      responses:
        "201": { description: Created. }
  /entries/{entry_id}:
    get:
      operationId: getEntry
      parameters:
        - name: entry_id
          in: path
          required: true
          schema: { type: string }
      responses:
        "200": { description: The entry. }
`;

  it("parses a 3.1 document (JSON Schema 2020-12 keywords intact)", async () => {
    const parsed = await parseSpec(spec31);
    expect(parsed.kind).toBe("openapi");
    const air = await compile({ spec: spec31, serviceId: "ledger" });
    expect(air.operations.map((o) => o.canonicalName).sort()).toEqual([
      "create_entry",
      "get_entry",
    ]);
    const create = air.operations.find((o) => o.canonicalName === "create_entry");
    // A union-typed field is not flag-projectable, so the body is preserved
    // whole — nothing is lost, it is just supplied as --body JSON.
    expect(create?.input.body?.projection).toBe("whole");
    const props = (create?.input.body?.schema.properties ?? {}) as Record<
      string,
      { type?: unknown }
    >;
    expect(props.memo?.type).toEqual(["string", "null"]);
  });
});
