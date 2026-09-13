import { z } from "zod";
import { materializeSchemaBranches } from "./schema-branches.js";

const Name = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const Pointer = z
  .string()
  .refine((s) => s === "" || /^\/(?:[^~]|~[01])*$/.test(s), "Use a JSON pointer");
const Schema = z.record(z.string(), z.unknown());

/** Values have explicit provenance. No expressions, inferred joins, or executable templates. */
export const BusinessBinding = z.discriminatedUnion("from", [
  z.strictObject({ from: z.literal("input"), pointer: Pointer }),
  z.strictObject({
    from: z.literal("context"),
    field: z.enum(["tenant", "principal", "policyVersion"]),
  }),
  z.strictObject({ from: z.literal("step"), step: Name, pointer: Pointer }),
  z.strictObject({ from: z.literal("literal"), value: z.json() }),
]);
export type BusinessBinding = z.infer<typeof BusinessBinding>;

export const BusinessGuidance = z.strictObject({
  intents: z.array(z.string().min(1)).min(1),
  counterIntents: z.array(z.string().min(1)).default([]),
  clarify: z.array(z.string().min(1)).default([]),
  escalate: z.array(z.string().min(1)).min(1),
});

export const BusinessAction = z.strictObject({
  id: Name,
  description: z.string().min(1),
  state: z.enum(["proposed", "approved"]).default("proposed"),
  guidance: BusinessGuidance,
  input: Schema,
  output: Schema,
  requiredScopes: z.array(z.string().min(1)).default([]),
  humanApproval: z.boolean().default(false),
  steps: z
    .array(
      z.strictObject({
        id: Name,
        source: Name,
        operationId: z.string().min(1),
        /** Reviewable reason this system is authoritative for the fact or effect. */
        authority: z.string().min(1),
        input: z.record(Name, BusinessBinding),
        preconditions: z
          .array(
            z.strictObject({
              value: BusinessBinding,
              equals: BusinessBinding,
              message: z.string().min(1),
            }),
          )
          .default([]),
        /** Consequential business effect; required for every mutation by the compiler. */
        effect: z.string().min(1).optional(),
        failure: z.strictObject({ message: z.string().min(1), nextAction: z.string().min(1) }),
      }),
    )
    .min(1)
    .max(32),
  result: z.record(Name, BusinessBinding),
});
export type BusinessAction = z.infer<typeof BusinessAction>;

export const BusinessDefinition = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  version: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().min(1),
  gatewayUrl: z.url(),
  /** Authentication posture of the public gateway, independent of backend credentials. */
  caller: z.enum(["service", "end_user"]).default("service"),
  actions: z.array(BusinessAction).min(1).max(20),
});
export type BusinessDefinition = z.infer<typeof BusinessDefinition>;

/** Safe to disclose. The private source AIR and choreography never enter this view. */
export const BusinessSurface = z.object({
  planDigest: z.string(),
  actions: z.array(
    z.object({
      id: Name,
      guidance: BusinessGuidance,
      effects: z.array(z.string()),
    }),
  ),
});
export type BusinessSurface = z.infer<typeof BusinessSurface>;

/** JSON pointer lookup uses own properties only, including for literal input objects. */
export function businessPointer(value: unknown, pointer: string): unknown {
  let current = value;
  for (const part of pointer === "" ? [] : pointer.slice(1).split("/")) {
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, key)) {
      throw new Error(`Unresolved business binding ${pointer}`);
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Compile validators once per schema in the host; never silently ignore schema conversion errors. */
const validators = new WeakMap<object, z.ZodType>();
export function validateBusinessValue(schema: Record<string, unknown>, value: unknown): boolean {
  let validator = validators.get(schema);
  if (!validator) {
    validator = z.fromJSONSchema(
      materializeSchemaBranches(schema) as Parameters<typeof z.fromJSONSchema>[0],
    );
    validators.set(schema, validator);
  }
  return validator.safeParse(value).success;
}
