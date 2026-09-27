import { z } from "zod";

/**
 * The record of an exposure profile: which operations of the full source
 * contract are the exposed surface, bound to the profile's content digest and
 * to the source digest it was compiled against. The full contract stays the
 * source of truth; the profile only narrows what may be approved and served.
 *
 * `exposedOperations` lists AIR operation ids. An operation outside it is
 * either absent from the AIR (`unexposed: skip`) or compiled but never
 * approvable (`unexposed: compile`).
 */
export const ExposureProfileRecord = z.object({
  id: z.string().min(1),
  /** sha256 over the profile's canonical JSON form. */
  digest: z.string(),
  /** The source digest (`service.source.sourceHash`) the profile was applied to. */
  sourceHash: z.string().optional(),
  /** Where the reviewed contract is published, and its file and content digests, as the profile pins them. */
  source: z
    .object({
      url: z.string().optional(),
      sha256: z.string().optional(),
      contentSha256: z.string().optional(),
    })
    .optional(),
  unexposed: z.enum(["skip", "compile"]),
  /** Operations the full source contract declares, before selection. */
  sourceOperations: z.number().int().nonnegative(),
  exposedOperations: z.array(z.string()),
  /** The schema materialization bounds the compile used. */
  schemaBounds: z.object({
    maxRefDepth: z.number().int().positive(),
    maxSchemaNodes: z.number().int().positive(),
    inheritAllOf: z.boolean(),
    fitToBudget: z.boolean(),
  }),
  /** The profile's declarative approval, when it carried one. */
  approval: z
    .object({
      reviewedBy: z.string().min(1),
      reason: z.string().min(1),
      operations: z.array(z.string()),
    })
    .optional(),
});
export type ExposureProfileRecord = z.infer<typeof ExposureProfileRecord>;
