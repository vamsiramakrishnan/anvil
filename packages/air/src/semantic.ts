import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

/** Nominal meaning belongs to a reviewed schema, never inferred from a field name. */
export const SemanticType = z
  .strictObject({
    entity: z.string().min(1).optional(),
    unit: z.string().min(1).optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    tenant: z.string().min(1).optional(),
    authority: z.string().min(1).optional(),
  })
  .refine((v) => Object.values(v).some((value) => value !== undefined), "Empty semantic type");
export type SemanticType = z.infer<typeof SemanticType>;
export type SemanticSchema = Record<string, unknown>;

export function assertSemanticBinding(source: SemanticSchema, target: SemanticSchema): void {
  if (target["x-anvil-semantic"] !== undefined) {
    const wanted = SemanticType.parse(target["x-anvil-semantic"]);
    const actual = SemanticType.parse(source["x-anvil-semantic"]);
    for (const key of Object.keys(wanted) as Array<keyof SemanticType>) {
      if (actual[key] !== wanted[key]) throw new Error(`Semantic binding mismatch: ${key}`);
    }
  }
  const props = target.properties as Record<string, SemanticSchema> | undefined;
  const from = source.properties as Record<string, SemanticSchema> | undefined;
  for (const [key, value] of Object.entries(props ?? {})) {
    assertSemanticBinding(from?.[key] ?? {}, value);
  }
  if (target.items && typeof target.items === "object")
    assertSemanticBinding((source.items ?? {}) as SemanticSchema, target.items as SemanticSchema);
}

export const ValueTransform = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("scale"),
    numerator: z.number().int().positive().safe(),
    denominator: z.number().int().positive().safe(),
    fromUnit: z.string().min(1),
    toUnit: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("select_one"),
    field: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
    equals: z.json(),
    maxItems: z.number().int().min(1).max(1000),
  }),
]);
export type ValueTransform = z.infer<typeof ValueTransform>;

export function transformedSchema(
  raw: SemanticSchema,
  transforms: ValueTransform[],
): SemanticSchema {
  let schema = structuredClone(raw);
  for (const rawTransform of transforms) {
    const t = ValueTransform.parse(rawTransform);
    if (t.kind === "select_one") {
      if (schema.type !== "array" || !schema.items || typeof schema.items !== "object")
        throw new Error("Selection requires an array with declared items");
      schema = structuredClone(schema.items as SemanticSchema);
      if (!Object.hasOwn((schema.properties ?? {}) as object, t.field))
        throw new Error("Selector field is not declared");
      const field = (schema.properties as Record<string, SemanticSchema>)[t.field]!;
      if (
        !z.fromJSONSchema(field as Parameters<typeof z.fromJSONSchema>[0]).safeParse(t.equals)
          .success
      )
        throw new Error("Selector value does not satisfy the declared field type");
    } else {
      const semantic = SemanticType.parse(schema["x-anvil-semantic"]);
      if (schema.type !== "integer" || semantic.entity || semantic.unit !== t.fromUnit)
        throw new Error("Scaling requires an integer quantity with the declared source unit");
      schema = { type: "integer", "x-anvil-semantic": { ...semantic, unit: t.toUnit } };
    }
  }
  return schema;
}

export function transformValue(value: unknown, transforms: ValueTransform[]): unknown {
  let out = value;
  for (const raw of transforms) {
    const t = ValueTransform.parse(raw);
    if (t.kind === "select_one") {
      if (!Array.isArray(out) || out.length > t.maxItems)
        throw new Error("Selection bound exceeded");
      const found = out.filter(
        (v) =>
          v &&
          typeof v === "object" &&
          Object.hasOwn(v, t.field) &&
          isDeepStrictEqual(v[t.field], t.equals),
      );
      if (found.length !== 1)
        throw new Error("Selection requires exactly one match; clarify the request");
      out = found[0];
    } else {
      if (!Number.isSafeInteger(out)) throw new Error("Scaling requires a safe integer");
      const product = BigInt(out as number) * BigInt(t.numerator);
      if (product % BigInt(t.denominator) !== 0n) throw new Error("Scaling would lose precision");
      const number = Number(product / BigInt(t.denominator));
      if (!Number.isSafeInteger(number))
        throw new Error("Scaled value exceeds the safe integer range");
      out = number;
    }
  }
  return structuredClone(out);
}
