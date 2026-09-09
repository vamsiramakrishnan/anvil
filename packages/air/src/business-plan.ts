import { z } from "zod";
import { BusinessDefinition } from "./business-contract.js";
import { hashCanonical } from "./hash.js";
import { AirDocument } from "./schema.js";

/** Private operator artifact. Never serve this through MCP resources or copy it into SDKs. */
export const BusinessPlan = z.strictObject({
  definition: BusinessDefinition,
  sources: z.record(z.string(), AirDocument),
  digest: z.string(),
});
export type BusinessPlan = z.infer<typeof BusinessPlan>;

export function loadBusinessPlan(value: unknown, expectedDigest?: string): BusinessPlan {
  const plan = BusinessPlan.parse(value);
  const digest = hashCanonical({ definition: plan.definition, sources: plan.sources });
  if (digest !== plan.digest || (expectedDigest !== undefined && digest !== expectedDigest)) {
    throw new Error("Business execution plan does not match its reviewed public contract.");
  }
  return plan;
}
