import { z } from "zod";
import { AnvilManifest } from "./manifest.js";

/**
 * The manifest's JSON Schema, derived from the same zod schema that parses it,
 * so an editor validating `anvil.yaml` and the compiler reading it can never
 * disagree about what a key means. Emit it with `anvil schema manifest` and
 * point a YAML language server at it:
 *
 *   # yaml-language-server: $schema=./anvil-manifest.schema.json
 *
 * Constraints the schema cannot express (cross-field refinements such as
 * "an idempotency key needs a carrier") stay compiler-side; the schema is the
 * shape, not the whole contract, and says so in its description.
 */
export const MANIFEST_SCHEMA_ID =
  "https://vamsiramakrishnan.github.io/anvil/schemas/anvil-manifest.schema.json";

export function manifestJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(AnvilManifest, {
    target: "draft-2020-12",
    unrepresentable: "any",
    io: "input",
  }) as Record<string, unknown>;
  return {
    $id: MANIFEST_SCHEMA_ID,
    title: "Anvil manifest",
    description:
      "The semantic overlay a reviewer writes for a compiled source: per-operation effect, risk, idempotency, confirmation, naming, auth, retries, and pagination; authored workflows, capability reviews, and query templates. Keys are strict — an unknown key is a compile error. Cross-field rules are enforced by `anvil compile`, not by this schema.",
    ...schema,
  };
}
