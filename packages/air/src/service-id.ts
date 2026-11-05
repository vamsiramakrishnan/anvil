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

/**
 * A Simple Icons slug for a connector (`github`): lower-case letters and digits,
 * words joined by single hyphens, at most 64 characters. Anvil ships no image and
 * fetches none; a console maps the slug to a mark and shows a generic one for a
 * slug it does not know.
 */
export const ServiceIcon = z
  .string()
  .max(64, "service.icon is at most 64 characters")
  .regex(
    /^[a-z0-9]+(-[a-z0-9]+)*$/,
    "service.icon is a Simple Icons slug: lower-case letters and digits, words joined by single hyphens (for example `github`)",
  );
export type ServiceIcon = z.infer<typeof ServiceIcon>;
