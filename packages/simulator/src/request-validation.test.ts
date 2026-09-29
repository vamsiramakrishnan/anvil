import { readFileSync } from "node:fs";
import type { AirDocument } from "@anvil/air";
import { approveOperations, compile } from "@anvil/compiler";
import { beforeAll, describe, expect, it } from "vitest";
import { simulatorDefinitionFor } from "./define.js";
import type { ProviderRequest } from "./provider.js";
import { invalidRequest } from "./request-validation.js";
import { Simulator } from "./runtime.js";
import type { TraceEntry } from "./trace.js";

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

function recording(validateValues: boolean) {
  const seen: ProviderRequest[] = [];
  const traced: TraceEntry[] = [];
  const sim = new Simulator(air, simulatorDefinitionFor(air), {
    provider: {
      invoke: (req) => {
        seen.push(req);
        return { ok: true, result: { id: "P-1" } };
      },
    },
    trace: { write: (entry) => traced.push(entry) },
    ...(validateValues ? { validateValues: true } : {}),
  });
  return { sim, seen, traced };
}

describe("simulator request validation", () => {
  it("with validateValues, serves a storage body once narrowed and refuses the nested form", async () => {
    const { sim, seen, traced } = recording(true);
    const ok = await sim.invokeAsync(tool("createPage"), page(STORAGE), { confirm: true });
    expect(ok).toMatchObject({ ok: true });
    const refused = await sim.invokeAsync(tool("createPage"), page(NESTED), { confirm: true });
    expect(refused).toMatchObject({ ok: false, error: { code: "validation_error" } });
    // A refused call never reaches the state behind the simulator.
    expect(seen).toHaveLength(1);
    // The trace records that values were checked.
    expect(traced.map((e) => e.validateValues)).toEqual([true, true]);
  });

  it("by default checks required presence only, so an over-strict spec still reaches the provider", async () => {
    const { sim, seen, traced } = recording(false);
    // `spaceId` is required by the declared body schema but missing here; the
    // nested form does not match the narrowed alternative. Neither is refused.
    const overStrict = { body: { title: "Hello", body: NESTED } };
    expect(await sim.invokeAsync(tool("createPage"), overStrict, { confirm: true })).toMatchObject({
      ok: true,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.body).toEqual(overStrict.body);
    expect(traced[0]).not.toHaveProperty("validateValues");
    // A missing required input is still refused, as it always was.
    expect(await sim.invokeAsync(tool("createPage"), {}, { confirm: true })).toMatchObject({
      ok: false,
      error: { code: "validation_error", message: "Missing required request body." },
    });
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
