import { z } from "zod";
import { BusinessDefinition } from "./business-contract.js";
import { AirDocument } from "./schema.js";

export const BusinessProject = z.strictObject({
  schemaVersion: z.literal(1),
  definition: BusinessDefinition,
  sources: z.record(z.string(), AirDocument),
  tasks: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
        action: z.string().min(1),
        prompt: z.string().min(1),
        /** Adapter-owned fixture and oracle inputs, never disclosed to the agent. */
        fixture: z.record(z.string(), z.json()).default({}),
        expected: z.record(z.string(), z.json()).default({}),
      }),
    )
    .max(100)
    .default([]),
});
export type BusinessProject = z.infer<typeof BusinessProject>;
