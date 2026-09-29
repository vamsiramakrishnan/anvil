import { readFileSync } from "node:fs";
import type { AirDocument } from "@anvil/air";
import { approveOperations, compile } from "@anvil/compiler";
import { beforeAll, describe, expect, it } from "vitest";
import { simulatorDefinitionFor } from "./define.js";
import type { ProviderRequest } from "./provider.js";
import { invalidRequest } from "./request-validation.js";
import { Simulator } from "./runtime.js";

/**
 * The simulator checks a call's values against the schema AIR declares for
 * them, so it refuses what the served tool refuses. The fixture's page write
 * types `body` as a oneOf of two open objects; the manifest narrows it on
 * `createPage` only.
 */
const SPEC = readFileSync(
  new URL("../../../examples/fixtures/page-body-union.yaml", import.meta.url),
  "utf8",
);
const MANIFEST = [
  "operations:",
  "  createPage:",
  "    params:",
  "      body:",
  "        one_of: PageBodyWrite",
  "        properties: { representation: { enum: [storage] } }",
  "        required: [representation, value]",
].join("\n");

const STORAGE = { representation: "storage", value: "<p>Hello</p>" };
const NESTED = { storage: STORAGE };

let air: AirDocument;
beforeAll(async () => {
  const compiled = await compile({ spec: SPEC, manifest: MANIFEST, serviceId: "pages" });
  air = approveOperations(
    compiled,
    compiled.operations.map((o) => o.id),
  );
});

const opNamed = (id: string) => air.operations.find((o) => o.sourceRef.operationId === id);
const tool = (id: string) => opNamed(id)?.mcp.toolName as string;
const page = (body: unknown) => ({ body: { spaceId: "S1", title: "Hello", body } });

describe("simulator request validation", () => {
  it("serves a storage body once the union is narrowed, and refuses the nested form", async () => {
    const seen: ProviderRequest[] = [];
    const sim = new Simulator(air, simulatorDefinitionFor(air), {
      provider: {
        invoke: (req) => {
          seen.push(req);
          return { ok: true, result: { id: "P-1" } };
        },
      },
    });
    const ok = await sim.invokeAsync(tool("createPage"), page(STORAGE), { confirm: true });
    expect(ok).toMatchObject({ ok: true });
    const refused = await sim.invokeAsync(tool("createPage"), page(NESTED), { confirm: true });
    expect(refused).toMatchObject({ ok: false, error: { code: "validation_error" } });
    // A refused call never reaches the state behind the simulator.
    expect(seen).toHaveLength(1);
  });

  it("still refuses every body on the operation the manifest left as a strict oneOf", () => {
    const update = opNamed("updatePage");
    if (!update) throw new Error("no updatePage");
    for (const body of [STORAGE, NESTED]) {
      expect(invalidRequest(update, { id: "P-1", ...page(body) })).toMatch(
        /^Request body does not match its declared schema at 'body'/,
      );
    }
  });

  it("clamps rather than refuses a page size past its ceiling", () => {
    const list = opNamed("getPages");
    if (!list) throw new Error("no getPages");
    const paged = {
      ...list,
      pagination: { style: "cursor" as const, pageSizeParam: "limit" },
      input: {
        ...list.input,
        params: [
          ...list.input.params,
          {
            name: "limit",
            in: "query" as const,
            required: false,
            inferred: false,
            schema: { type: "integer", maximum: 5 },
          },
        ],
      },
    };
    expect(invalidRequest(paged, { limit: 50 })).toBeUndefined();
    expect(invalidRequest(paged, { body_format: "html" })).toMatch(/Parameter 'body-format'/);
  });
});
