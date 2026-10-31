import { describe, expect, it } from "vitest";
import {
  assertSemanticBinding,
  transformedSchema,
  transformValue,
  type ValueTransform,
} from "./semantic.js";

const money = {
  type: "integer",
  "x-anvil-semantic": { unit: "dollars", currency: "USD", tenant: "shop", authority: "billing" },
};
const scale: ValueTransform = {
  kind: "scale",
  numerator: 100,
  denominator: 1,
  fromUnit: "dollars",
  toUnit: "cents",
};

describe("reviewed semantic bindings", () => {
  it("converts exact units while preserving currency and authority", () => {
    const result = transformedSchema(money, [scale]);
    expect(result["x-anvil-semantic"]).toEqual({ ...money["x-anvil-semantic"], unit: "cents" });
    expect(transformValue(42, [scale])).toBe(4200);
    expect(() =>
      assertSemanticBinding(result, { ...result, "x-anvil-semantic": { currency: "EUR" } }),
    ).toThrow();
  });
  it.each([
    "entity",
    "tenant",
    "authority",
    "unit",
    "currency",
  ])("rejects missing or mismatched %s even inside objects and arrays", (field) => {
    const target = {
      type: "array",
      items: {
        type: "object",
        properties: {
          value: {
            type: "string",
            "x-anvil-semantic": { [field]: field === "currency" ? "USD" : "first" },
          },
        },
      },
    };
    expect(() => assertSemanticBinding({}, target)).toThrow();
    const source = structuredClone(target);
    source.items.properties.value["x-anvil-semantic"][field] =
      field === "currency" ? "EUR" : "second";
    expect(() => assertSemanticBinding(source, target)).toThrow();
  });
  it("rejects rounded, overflowing or nominal-identity conversions", () => {
    expect(() => transformValue(1, [{ ...scale, numerator: 1, denominator: 3 }])).toThrow(
      /precision/,
    );
    expect(() => transformValue(Number.MAX_SAFE_INTEGER, [scale])).toThrow(/range/);
    expect(() =>
      transformedSchema({ ...money, "x-anvil-semantic": { unit: "dollars", entity: "order" } }, [
        scale,
      ]),
    ).toThrow();
    expect(() => transformedSchema(money, [{ ...scale, fromUnit: "cents" }])).toThrow();
  });
  it("requires a bounded, unambiguous selection", () => {
    const select: ValueTransform = { kind: "select_one", field: "id", equals: "a", maxItems: 2 };
    expect(
      transformValue(
        [
          { id: "a", n: 7 },
          { id: "b", n: 8 },
        ],
        [select],
      ),
    ).toEqual({ id: "a", n: 7 });
    for (const values of [[], [{ id: "a" }, { id: "a" }], [{ id: "a" }, { id: "b" }, { id: "c" }]])
      expect(() => transformValue(values, [select])).toThrow();
  });
});
