import { z } from "zod";

/**
 * Canonical service identifier. It is safe as one path/CLI segment; generators
 * project it into stricter provider-specific slugs (npm, Skills, GCP) without
 * changing this identity, because changing an established id breaks overlays,
 * approval history, and drift lineage.
 */
export const ServiceId = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z](?:[a-z0-9_-]{0,62}[a-z0-9])?$/,
    "service id must be a safe lowercase slug (1-64 chars), start with a letter, and end with a letter or digit",
  );
export type ServiceId = z.infer<typeof ServiceId>;
