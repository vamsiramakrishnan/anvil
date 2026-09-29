import { readFileSync } from "node:fs";
import type { AirDocument, Operation } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { compile } from "./compile.js";
import { makeOverlay } from "./contract/overlay.js";
import { compileContract } from "./contract/snapshot.js";
import { narrowToAlternative } from "./schema-alternatives.js";
import { ephemeralCompilerSource } from "./source/compiler-source.js";

/**
 * Narrowing a union input to one alternative by manifest. The fixture is a
 * page write shaped like Confluence's v2 contract: `body` is a oneOf of two
 * alternatives that both accept any object, so a strict oneOf refuses every
 * body the service accepts.
 */
const SPEC = readFileSync(
  new URL("../../../examples/fixtures/page-body-union.yaml", import.meta.url),
  "utf8",
);

const STORAGE = [
  "      body:",
  "        one_of: PageBodyWrite",
  "        properties: { representation: { enum: [storage] } }",
  "        required: [representation, value]",
];

async function compiled(...entries: string[][]): Promise<AirDocument> {
  return compile({
    spec: SPEC,
    serviceId: "pages",
    manifest: ["operations:", ...entries.flat()].join("\n"),
  });
}

const opNamed = (air: AirDocument, id: string) =>
  air.operations.find((o) => o.sourceRef.operationId === id) as Operation;

const bodyProp = (op: Operation) =>
  (op.input.body?.schema.properties as Record<string, Record<string, unknown>> | undefined)?.body;

const notes = (op: Operation) => op.reviewNotes.join("\n");

describe("manifest params: narrowing a union to one alternative", () => {
  it("narrows by component name, tightening the alternative, and records why", async () => {
    const air = await compiled(["  createPage:", "    params:", ...STORAGE]);
    const create = opNamed(air, "createPage");
    const body = bodyProp(create);
    expect(body?.oneOf).toBeUndefined();
    expect(body?.type).toBe("object");
    expect(body?.required).toEqual(["representation", "value"]);
    const props = body?.properties as Record<string, Record<string, unknown>>;
    expect(props.representation?.enum).toEqual(["storage"]);
    // The description the source gave the property survives the narrowing.
    expect(props.representation?.description).toContain("representation");
    expect(notes(create)).toContain(
      "Input 'body' narrowed by manifest to oneOf[0] (PageBodyWrite).",
    );
    // The assembled input schema every surface reads carries the narrowed body.
    const inputProps = create.input.schema?.properties as
      | Record<string, Record<string, unknown>>
      | undefined;
    const served = inputProps?.body;
    expect(JSON.stringify(served)).not.toContain("PageNestedBodyWrite");
    expect(JSON.stringify(served)).toContain('"enum":["storage"]');
  });

  it("leaves an operation the manifest does not name exactly as the source typed it", async () => {
    const air = await compiled(["  createPage:", "    params:", ...STORAGE]);
    const update = opNamed(air, "updatePage");
    expect(bodyProp(update)?.oneOf).toHaveLength(2);
    expect(notes(update)).not.toContain("narrowed");
  });

  it("writes no union member name into AIR, with or without a manifest", async () => {
    // The name is bookkeeping for selecting an alternative while patches
    // apply; nothing an agent or client reads may carry it.
    const plain = await compile({ spec: SPEC, serviceId: "pages" });
    expect(JSON.stringify(plain)).not.toContain("x-anvil-component");
    const narrowed = await compiled(["  createPage:", "    params:", ...STORAGE]);
    expect(JSON.stringify(narrowed)).not.toContain("x-anvil-component");
    expect(JSON.stringify(bodyProp(opNamed(narrowed, "createPage")))).not.toContain(
      "x-anvil-component",
    );
    // The name the narrowing selected by survives only in its review note.
    expect(notes(opNamed(narrowed, "createPage"))).toContain("(PageBodyWrite)");
  });

  it("names the same alternative by $ref, by index, or by component name alike", async () => {
    const by = async (selector: string) =>
      bodyProp(
        opNamed(
          await compiled(["  createPage:", "    params:", `      body: { one_of: ${selector} }`]),
          "createPage",
        ),
      );
    const byName = await by("PageBodyWrite");
    expect(await by("'#/components/schemas/PageBodyWrite'")).toEqual(byName);
    expect(await by("0")).toEqual(byName);
    expect(byName?.properties).toBeDefined();
  });

  it("narrows a query parameter's union too", async () => {
    const air = await compiled([
      "  getPages:",
      "    params:",
      "      body-format: { one_of: 0, properties: {} }",
    ]);
    const param = opNamed(air, "getPages").input.params.find((p) => p.name === "body-format");
    expect(param?.schema).toEqual({
      type: "string",
      enum: ["storage", "atlas_doc_format", "view"],
    });
  });

  it("refuses to widen: a value the alternative does not allow leaves the input untouched", async () => {
    const air = await compiled([
      "  createPage:",
      "    params:",
      "      body:",
      "        one_of: PageBodyWrite",
      "        properties: { representation: { enum: [storage, markdown] } }",
    ]);
    const create = opNamed(air, "createPage");
    expect(bodyProp(create)?.oneOf).toHaveLength(2);
    expect(notes(create)).toContain(
      "params manifest patch for 'body' left unset: 'representation' would admit \"markdown\"",
    );
  });

  it("declines with a review note when there is no union or no such alternative", async () => {
    const air = await compiled([
      "  createPage:",
      "    params:",
      "      body: { one_of: PageBodyMarkdown }",
      "      title: { one_of: 0 }",
      "      subtitle: { one_of: 0 }",
      "  updatePage:",
      "    params:",
      "      body: { one_of: 5 }",
    ]);
    const create = notes(opNamed(air, "createPage"));
    expect(create).toContain(
      "params manifest patch for 'body' left unset: the union has no alternative named " +
        "'PageBodyMarkdown'; it offers oneOf[0] (PageBodyWrite), oneOf[1] (PageNestedBodyWrite).",
    );
    expect(create).toContain(
      "params manifest patch for 'title' left unset: the input is not a oneOf/anyOf union.",
    );
    expect(create).toContain(
      "params manifest patch for 'subtitle' left unset: the operation has no",
    );
    expect(notes(opNamed(air, "updatePage"))).toContain("the union has no alternative 5");
  });

  it("declines a property or requirement the alternative does not declare", async () => {
    const air = await compiled([
      "  createPage:",
      "    params:",
      "      body: { one_of: PageBodyWrite, properties: { format: { enum: [x] } } }",
      "  updatePage:",
      "    params:",
      "      body: { one_of: PageBodyWrite, required: [format] }",
    ]);
    expect(notes(opNamed(air, "createPage"))).toContain(
      "the alternative declares no property 'format' to narrow",
    );
    expect(notes(opNamed(air, "updatePage"))).toContain(
      "the alternative declares no 'format' to require",
    );
    expect(bodyProp(opNamed(air, "updatePage"))?.oneOf).toHaveLength(2);
  });

  it("rejects a params entry that is neither a retype nor a narrowing", async () => {
    await expect(
      compiled(["  createPage:", "    params:", "      body: { one_of: -1 }"]),
    ).rejects.toThrow();
    await expect(
      compiled([
        "  createPage:",
        "    params:",
        "      body: { one_of: 0, additional_properties: true }",
      ]),
    ).rejects.toThrow();
  });
});

describe("narrowToAlternative", () => {
  const union = {
    description: "The page body.",
    oneOf: [
      { type: "object", properties: { value: { type: "string", const: "x" } } },
      { type: "object", properties: { n: { type: "integer" } }, additionalProperties: true },
    ],
    discriminator: { propertyName: "kind" },
  };

  it("keeps the union's own keywords and drops the discriminator of the dropped branches", () => {
    const narrowed = narrowToAlternative(union, { one_of: 1, additional_properties: false });
    expect(narrowed).toEqual({
      ok: true,
      alternative: "oneOf[1]",
      schema: {
        type: "object",
        properties: { n: { type: "integer" } },
        additionalProperties: false,
        description: "The page body.",
      },
    });
  });

  it("checks a narrowed value against the property's type and const", () => {
    expect(
      narrowToAlternative(union, { one_of: 1, properties: { n: { enum: [1.5] } } }),
    ).toMatchObject({ ok: false });
    expect(
      narrowToAlternative(union, { one_of: 0, properties: { value: { enum: ["y"] } } }),
    ).toMatchObject({ ok: false });
    expect(
      narrowToAlternative(union, { one_of: 0, properties: { value: { enum: ["x"] } } }),
    ).toMatchObject({ ok: true });
  });

  it("keeps a union keyword that contradicts the alternative side by side instead of overwriting it", () => {
    const narrowed = narrowToAlternative(
      { type: "object", required: ["a"], anyOf: [{ type: "object", required: ["b"] }] },
      { one_of: 0 },
    );
    expect(narrowed).toEqual({
      ok: true,
      alternative: "anyOf[0]",
      schema: { type: "object", required: ["a"], allOf: [{ type: "object", required: ["b"] }] },
    });
  });
});

describe("params narrowing through the overlay model", () => {
  const source = () => ephemeralCompilerSource(SPEC, "openapi.yaml");
  const narrowing = (representation: string) =>
    makeOverlay({
      origin: "operator",
      assertions: [
        {
          target: { scope: "operation", ref: "createPage" },
          predicate: "params",
          operation: "set",
          value: {
            body: {
              one_of: "PageBodyWrite",
              properties: { representation: { enum: [representation] } },
            },
          },
          evidenceRefs: [],
        },
      ],
    });

  it("two overlays that narrow the same input differently raise a conflict", async () => {
    const result = await compileContract(source(), [narrowing("storage"), narrowing("wiki")]);
    expect(result.status).toBe("conflicted");
    if (result.status !== "conflicted") throw new Error("expected a conflict");
    const conflict = result.conflicts.find((c) => c.predicate === "params");
    expect(conflict?.sides).toHaveLength(2);
    // Neither narrowing is picked by array order: the input keeps its union.
    const create = result.partialContract.air.operations.find(
      (o) => o.sourceRef.operationId === "createPage",
    );
    expect(create && bodyProp(create)?.oneOf).toHaveLength(2);
  });

  it("two overlays that agree resolve to the one narrowing", async () => {
    const result = await compileContract(source(), [narrowing("storage"), narrowing("storage")]);
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") throw new Error("expected a resolved contract");
    const create = result.contract.air.operations.find(
      (o) => o.sourceRef.operationId === "createPage",
    );
    const props =
      create && (bodyProp(create)?.properties as Record<string, Record<string, unknown>>);
    expect(props?.representation?.enum).toEqual(["storage"]);
  });
});
