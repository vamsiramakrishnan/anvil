import { describe, expect, it } from "vitest";
import {
  resolveParamSerialization,
  serializeQueryParam,
  serializeSimpleParam,
} from "./param-style.js";

/**
 * The parameter serialization table, asserted against the literal text OpenAPI
 * defines rather than against anything recomputed from the same code — an
 * oracle derived from the implementation moves with the bug instead of
 * catching it.
 */
describe("parameter serialization", () => {
  it("fills in OpenAPI's per-location defaults", () => {
    expect(resolveParamSerialization({ in: "query", name: "q" })).toEqual({
      style: "form",
      explode: true,
    });
    expect(resolveParamSerialization({ in: "cookie", name: "q" })).toEqual({
      style: "form",
      explode: true,
    });
    expect(resolveParamSerialization({ in: "path", name: "q" })).toEqual({
      style: "simple",
      explode: false,
    });
    expect(resolveParamSerialization({ in: "header", name: "q" })).toEqual({
      style: "simple",
      explode: false,
    });
    // A declared style keeps explode's default keyed to the style, not the location.
    expect(resolveParamSerialization({ in: "query", name: "q", style: "pipeDelimited" })).toEqual(
      { style: "pipeDelimited", explode: false },
    );
    expect(resolveParamSerialization({ in: "query", name: "q", explode: false })).toEqual({
      style: "form",
      explode: false,
    });
  });

  it("serializes query arrays per style", () => {
    const ids = ["a", "b", "c"];
    expect(serializeQueryParam({ in: "query", name: "id" }, ids)).toEqual({
      ok: true,
      pairs: [
        ["id", "a"],
        ["id", "b"],
        ["id", "c"],
      ],
    });
    expect(serializeQueryParam({ in: "query", name: "id", explode: false }, ids)).toEqual({
      ok: true,
      pairs: [["id", "a,b,c"]],
    });
    expect(
      serializeQueryParam({ in: "query", name: "id", style: "spaceDelimited" }, ids),
    ).toEqual({ ok: true, pairs: [["id", "a b c"]] });
    expect(serializeQueryParam({ in: "query", name: "id", style: "pipeDelimited" }, ids)).toEqual(
      { ok: true, pairs: [["id", "a|b|c"]] },
    );
    // Numbers and booleans are atoms, never quoted or JSON-encoded.
    expect(serializeQueryParam({ in: "query", name: "n" }, [1, true])).toEqual({
      ok: true,
      pairs: [
        ["n", "1"],
        ["n", "true"],
      ],
    });
  });

  it("serializes query objects per style, and never as [object Object]", () => {
    const point = { x: 1, y: "two" };
    expect(serializeQueryParam({ in: "query", name: "p" }, point)).toEqual({
      ok: true,
      pairs: [
        ["x", "1"],
        ["y", "two"],
      ],
    });
    expect(serializeQueryParam({ in: "query", name: "p", explode: false }, point)).toEqual({
      ok: true,
      pairs: [["p", "x,1,y,two"]],
    });
    expect(serializeQueryParam({ in: "query", name: "p", style: "deepObject" }, point)).toEqual({
      ok: true,
      pairs: [
        ["p[x]", "1"],
        ["p[y]", "two"],
      ],
    });
    // Absent properties are simply not sent, as with a top-level parameter.
    expect(serializeQueryParam({ in: "query", name: "p" }, { x: 1, y: null })).toEqual({
      ok: true,
      pairs: [["x", "1"]],
    });
  });

  it("refuses the shapes no style gives a meaning to", () => {
    const refused = (p: Parameters<typeof serializeQueryParam>[0], value: unknown) => {
      const result = serializeQueryParam(p, value);
      expect(result.ok).toBe(false);
      return result.ok ? "" : result.reason;
    };
    expect(refused({ in: "query", name: "p" }, { a: { b: 1 } })).toContain("nested object");
    expect(refused({ in: "query", name: "p" }, [{ a: 1 }])).toContain("array of objects");
    expect(refused({ in: "query", name: "p", style: "spaceDelimited" }, { a: 1 })).toContain(
      "no defined encoding for an object",
    );
    expect(refused({ in: "query", name: "p", style: "pipeDelimited" }, { a: 1 })).toContain(
      "no defined encoding for an object",
    );
    expect(refused({ in: "query", name: "p", style: "deepObject" }, ["a"])).toContain(
      "encodes objects only",
    );
    expect(refused({ in: "query", name: "p" }, () => 1)).toContain("function");
    for (const result of [
      serializeSimpleParam({ in: "path", name: "p" }, { a: [1] }),
      serializeSimpleParam({ in: "header", name: "p" }, [[1]]),
    ]) {
      expect(result.ok).toBe(false);
    }
  });

  it("serializes path and header values in the simple style", () => {
    expect(serializeSimpleParam({ in: "path", name: "id" }, "x y")).toEqual({
      ok: true,
      text: "x y",
    });
    expect(serializeSimpleParam({ in: "path", name: "id" }, ["a", "b"])).toEqual({
      ok: true,
      text: "a,b",
    });
    expect(serializeSimpleParam({ in: "header", name: "h" }, { x: 1, y: 2 })).toEqual({
      ok: true,
      text: "x,1,y,2",
    });
    expect(serializeSimpleParam({ in: "header", name: "h", explode: true }, { x: 1, y: 2 })).toEqual(
      { ok: true, text: "x=1,y=2" },
    );
    // The encoder is applied per atom, so a path keeps its separating commas
    // literal while every item inside them is still percent-encoded.
    expect(
      serializeSimpleParam({ in: "path", name: "id" }, ["a/b", "c,d"], encodeURIComponent),
    ).toEqual({ ok: true, text: "a%2Fb,c%2Cd" });
  });
});
