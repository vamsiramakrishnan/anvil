import { type AirDocument, AirDocument as AirSchema, airFromYaml, airToYaml } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { parseDocument, stringify } from "yaml";
import { approveOperations, compileSource } from "./compile.js";
import { type ExposureProfile, parseExposureProfile, selectDocument } from "./profile.js";
import { materializeWithin } from "./schema-bounds.js";
import { ephemeralCompilerSource } from "./source/compiler-source.js";
import { parseSourceText } from "./source/detect.js";
import { fastParseSpecText } from "./source/fast-parse.js";

/**
 * A synthetic vendor-scale spec, generated here rather than checked in:
 * `resources` resources, each with a collection and an item path (list,
 * create, get, update, delete), an entity schema that inherits `entity`
 * through `allOf` (the Microsoft Graph shape), a collection envelope, and a
 * navigation property to the next resource so the schema graph is cyclic.
 */
function syntheticSpec(resources: number): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  const schemas: Record<string, unknown> = {
    entity: {
      type: "object",
      properties: { id: { type: "string", description: "Stable identifier." } },
      discriminator: {
        propertyName: "@odata.type",
        mapping: Object.fromEntries(
          Array.from({ length: resources }, (_, i) => [`#r${i}`, `#/components/schemas/r${i}`]),
        ),
      },
    },
    orphan: { type: "object", properties: { unused: { type: "string" } } },
  };
  for (let i = 0; i < resources; i++) {
    const name = `r${i}`;
    const next = `r${(i + 1) % resources}`;
    const ref = { $ref: `#/components/schemas/${name}` };
    schemas[name] = {
      allOf: [
        { $ref: "#/components/schemas/entity" },
        {
          type: "object",
          properties: {
            label: { type: "string", description: `Label of resource ${i}, 1_000 and 0b101.` },
            count: { type: "integer" },
            next: { $ref: `#/components/schemas/${next}` },
          },
        },
      ],
    };
    schemas[`${name}Collection`] = {
      type: "object",
      properties: { value: { type: "array", items: ref }, nextLink: { type: "string" } },
    };
    const tag = `group${i % 10}`;
    const ok = (schema: unknown) => ({
      "2XX": { description: "ok", content: { "application/json": { schema } } },
    });
    paths[`/${name}`] = {
      get: {
        operationId: `${name}.list`,
        tags: [tag],
        responses: ok({ $ref: `#/components/schemas/${name}Collection` }),
      },
      post: {
        operationId: `${name}.create`,
        tags: [tag],
        requestBody: { content: { "application/json": { schema: ref } } },
        responses: ok(ref),
      },
    };
    paths[`/${name}/{id}`] = {
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      get: { operationId: `${name}.get`, tags: [tag], responses: ok(ref) },
      patch: {
        operationId: `${name}.update`,
        tags: [tag],
        requestBody: { content: { "application/json": { schema: ref } } },
        responses: ok(ref),
      },
      delete: {
        operationId: `${name}.delete`,
        tags: [tag],
        responses: { "204": { description: "gone" } },
      },
    };
  }
  return {
    openapi: "3.0.3",
    info: { title: "Synthetic Estate", version: "1.0.0" },
    servers: [{ url: "https://api.example.test" }],
    paths,
    components: { schemas },
  };
}

const RESOURCES = 400;
const SPEC = syntheticSpec(RESOURCES);
const JSON_TEXT = JSON.stringify(SPEC, null, 2);
const YAML_TEXT = stringify(SPEC, { aliasDuplicateObjects: false });

function profile(text: string): ExposureProfile {
  const parsed = parseExposureProfile(text);
  if (!parsed.ok) throw new Error(parsed.issues.join("\n"));
  return parsed.profile;
}

const SCOPED = profile(`
profile: synthetic-scope
select:
  - operation_id: [r1.get, r1.list]
  - tag: group2
    method: get
  - path: "/r3/**"
exclude:
  - method: delete
approve:
  reviewed_by: reviewer@example.test
  reason: Reads reviewed.
  select:
    - method: get
`);

describe("fast parse path", () => {
  it("reads a large JSON spec with JSON.parse and a YAML one with js-yaml", () => {
    expect(JSON_TEXT.length).toBeGreaterThan(400_000);
    const json = fastParseSpecText(JSON_TEXT);
    const yaml = fastParseSpecText(YAML_TEXT);
    expect(json.ok && yaml.ok).toBe(true);
    // Both readers agree with the `yaml` document parser the fallback uses.
    const reference = parseDocument(YAML_TEXT, { strict: true }).toJS();
    expect(parseSourceText(JSON_TEXT).doc).toEqual(reference);
    expect(parseSourceText(YAML_TEXT).doc).toEqual(reference);
  });

  it("resolves plain scalars exactly as the YAML 1.2 core schema does", () => {
    const text = [
      "a: 1_000",
      "b: 0b101",
      "c: 0o17",
      "d: 0x1F",
      "e: 1e3",
      "f: .inf",
      "g: ~",
      "h: True",
      "i: 2024-01-01",
      "j: +12",
      "k: 1.50",
      "l: yes",
      "200: ok",
    ].join("\n");
    const fast = fastParseSpecText(text);
    expect(fast.ok).toBe(true);
    expect(fast.ok && fast.value).toEqual(parseDocument(text, { strict: true }).toJS());
  });

  it("declines documents the fallback must read: anchors, merge keys, and syntax errors", () => {
    expect(fastParseSpecText("a: &x {b: 1}\nc: *x\n").ok).toBe(false);
    expect(fastParseSpecText("a:\n  <<: {b: 1}\n").ok).toBe(false);
    expect(fastParseSpecText("").ok).toBe(false);
    // A JSON syntax error still comes back located by the `yaml` parser.
    const broken = JSON_TEXT.replace('"openapi": "3.0.3",', '"openapi": "3.0.3"');
    const result = parseSourceText(broken);
    expect(result.doc).toBeUndefined();
    expect(result.errors[0]?.line).toBeGreaterThan(1);
  });
});

describe("exposure profiles", () => {
  it("rejects an unknown key and an empty selector", () => {
    const bad = parseExposureProfile("profile: x\nselect:\n  - {}\nexpose: all\n");
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.issues.join("\n")).toMatch(/expose|at least one/);
  });

  it("gives the same digest to the same profile however it is formatted", () => {
    const a = parseExposureProfile("profile: p\nselect: all\n");
    const b = parseExposureProfile('{"select": "all", "profile": "p"}');
    expect(a.ok && b.ok && a.digest === b.digest).toBe(true);
  });

  it("prunes unselected operations and every component only they reach", () => {
    const { document, sourceOperations, selectedOperations } = selectDocument(
      structuredClone(SPEC) as never,
      SCOPED,
    );
    expect(sourceOperations).toBe(RESOURCES * 5);
    // r1: get, list. group2 reads: r2, r12, …, r392 (40 resources × 2). r3: 4 non-delete.
    expect(selectedOperations).toBe(2 + (RESOURCES / 10) * 2 + 4);
    const kept = Object.keys(document.components?.schemas ?? {});
    expect(kept).not.toContain("orphan");
    expect(kept).toContain("entity");
  });

  it("compiles only the selected surface, approves its reads, and records the profile", async () => {
    const source = ephemeralCompilerSource(JSON_TEXT);
    const air = await compileSource(source, { profile: SCOPED });
    const record = air.service.source.profile;
    expect(air.operations).toHaveLength(2 + (RESOURCES / 10) * 2 + 4);
    expect(record?.id).toBe("synthetic-scope");
    expect(record?.sourceOperations).toBe(RESOURCES * 5);
    expect(record?.sourceHash).toBe(source.sourceHash);
    expect(record?.exposedOperations).toHaveLength(air.operations.length);
    const approved = air.operations.filter((op) => op.state === "approved");
    expect(approved.length).toBeGreaterThan(0);
    expect(approved.every((op) => op.sourceRef.method === "get")).toBe(true);
    expect(record?.approval?.operations.sort()).toEqual(approved.map((op) => op.id).sort());
    expect(air.operations.some((op) => op.sourceRef.method === "delete")).toBe(false);
  });

  it("keeps the rest compiled but unapprovable under unexposed: compile", async () => {
    const compiled = profile(`
profile: compile-mode
select:
  - path: "/r5"
unexposed: compile
`);
    const manifest = "operations:\n  r6.get:\n    state: approved\n";
    const air: AirDocument = await compileSource(ephemeralCompilerSource(JSON_TEXT), {
      profile: compiled,
      manifest,
    });
    expect(air.operations).toHaveLength(RESOURCES * 5);
    const r6 = air.operations.find((op) => op.sourceRef.operationId === "r6.get");
    expect(r6?.state).toBe("review_required");
    expect(air.diagnostics.map((d) => d.code)).toContain("profile/approval_outside_profile");
    const inside = air.operations.find((op) => op.sourceRef.operationId === "r5.list");
    approveOperations(air, [r6?.id ?? "", inside?.id ?? ""]);
    expect(r6?.state).toBe("review_required");
    expect(inside?.state).toBe("approved");
  });

  it("refuses a profile pinned to another source", async () => {
    const pinned = profile(
      `profile: pinned\nselect: all\nsource:\n  digest: sha256:${"0".repeat(64)}\n`,
    );
    await expect(
      compileSource(ephemeralCompilerSource(JSON_TEXT), { profile: pinned }),
    ).rejects.toThrow(/pinned to source/);
  });

  it("materializes an inherited entity's own fields and a collection's element type", async () => {
    const air = await compileSource(ephemeralCompilerSource(JSON_TEXT), { profile: SCOPED });
    const get = air.operations.find((op) => op.sourceRef.operationId === "r1.get");
    const list = air.operations.find((op) => op.sourceRef.operationId === "r1.list");
    const getText = JSON.stringify(get?.output.schema);
    expect(getText).toContain("Stable identifier.");
    expect(getText).not.toContain("mapping");
    expect(JSON.stringify(list?.output.schema)).toContain("Stable identifier.");
    expect(air.service.source.profile?.schemaBounds).toMatchObject({ fitToBudget: true });
  });

  it("falls back to one hop when a deeper schema would pass the node budget", () => {
    const named = SPEC.components as { schemas: Record<string, unknown> };
    const bounds = { maxRefDepth: 3, maxSchemaNodes: 40, inheritAllOf: true, fitToBudget: true };
    const { schema } = materializeWithin(
      { $ref: "#/components/schemas/r0" },
      named.schemas,
      bounds,
    );
    expect(JSON.stringify(schema)).toContain("nested one level deep");
  });
});

describe("whole-source compile of a large spec", () => {
  it("emits chunked YAML byte-identical to a whole-document emission", async () => {
    // 102 resources × 5 operations: just past the chunking threshold.
    const air = await compileSource(ephemeralCompilerSource(JSON.stringify(syntheticSpec(102))), {
      profile: profile("profile: everything\nselect: all\n"),
    });
    expect(air.operations.length).toBeGreaterThan(500);
    const chunked = airToYaml(air);
    const whole = stringify(AirSchema.parse(air), { lineWidth: 100, aliasDuplicateObjects: false });
    expect(chunked).toBe(whole);
    expect(airFromYaml(chunked).operations).toHaveLength(air.operations.length);
  });
});

describe("service auth over alternative security requirements", () => {
  const spec = JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Alternatives", version: "1" },
    servers: [{ url: "https://api.example.test" }],
    components: {
      securitySchemes: {
        basicAuth: { type: "http", scheme: "basic" },
        oauth: {
          type: "oauth2",
          flows: {
            authorizationCode: {
              authorizationUrl: "https://auth.example.test/authorize",
              tokenUrl: "https://auth.example.test/token",
              scopes: { read: "read" },
            },
          },
        },
      },
    },
    security: [{ basicAuth: [] }, { oauth: ["read"] }],
    paths: {
      "/things": {
        get: { operationId: "listThings", responses: { "200": { description: "ok" } } },
      },
    },
  });

  it("blocks without a choice and lifts to review when the manifest names one", async () => {
    const blocked = await compileSource(ephemeralCompilerSource(spec));
    expect(blocked.operations[0]?.state).toBe("blocked");
    const chosen = await compileSource(ephemeralCompilerSource(spec), {
      manifest: "auth:\n  type: basic\n",
    });
    const op = chosen.operations[0];
    expect(op?.auth.type).toBe("basic");
    expect(op?.state).toBe("review_required");
    expect(chosen.diagnostics.map((d) => d.code)).toContain(
      "auth/alternative_selected_by_manifest",
    );
  });

  it("names the legacy oauth2 type, not a missing carrier, as the reason it stays blocked", async () => {
    const legacy = await compileSource(ephemeralCompilerSource(spec), {
      manifest:
        "auth:\n  type: oauth2\n  scopes: [read]\noperations:\n  listThings: { state: approved }\n",
    });
    const op = legacy.operations[0];
    expect(op?.state).toBe("blocked");
    expect(op?.reviewNotes.some((n) => n.includes("Legacy service auth type oauth2"))).toBe(true);
    expect(legacy.diagnostics.filter((d) => d.code === "auth/service_oauth2_ambiguous")).toEqual([
      expect.objectContaining({ level: "error", operationId: op?.id }),
    ]);
  });
});
