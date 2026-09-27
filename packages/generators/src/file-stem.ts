import { createHash } from "node:crypto";

/**
 * Longest operation-derived file stem written as-is. A filesystem name is at
 * most 255 bytes, and a stem also carries a suffix such as `.schema.json`.
 */
const MAX_STEM = 200;

/**
 * The file stem for a per-operation artifact. Ids up to 200 characters are
 * used verbatim, so every existing bundle keeps its paths. A longer one (a
 * Microsoft Graph navigation path compiles to ids of 250 characters and more)
 * keeps a readable prefix and ends in a digest of the whole id, so two long
 * ids that share a prefix still land in different files.
 */
export function operationFileStem(id: string): string {
  if (id.length <= MAX_STEM) return id;
  const digest = createHash("sha256").update(id).digest("hex").slice(0, 12);
  return `${id.slice(0, MAX_STEM - 13)}-${digest}`;
}
