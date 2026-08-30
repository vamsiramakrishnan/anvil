import { snakeCase } from "@anvil/air";

/**
 * The routing vocabulary — the ONE set of word/token helpers every surface in
 * this package uses to ask "do these two naming surfaces share vocabulary?".
 *
 * Lifted (not rewritten) from `skills/executor.ts` (`singularize`, `pluralize`,
 * `projectRoutingNames`, `concretePathSegments`) and `detect.ts`
 * (`normalizedWords`), so the resource-contradiction detector, the heuristic
 * executor, and the proposal-grounding validation check all tokenize text the
 * SAME way. Three near-identical tokenizers that drift apart is exactly the
 * cross-surface disagreement this package exists to detect in other people's
 * APIs; it must not grow one of its own.
 */

/** English plural good enough for spec nouns: category→categories, box→boxes, doc→docs. */
export function pluralize(noun: string): string {
  if (noun.length === 0) return noun;
  if (/[^aeiou]y$/.test(noun)) return `${noun.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/.test(noun)) return `${noun}es`;
  return `${noun}s`;
}

/**
 * The inverse, character-for-character identical to the compiler's `singularize`
 * (naming.ts). Duplicated rather than imported: `@anvil/compiler` is a *dev*
 * dependency of this package (the runtime dependency graph runs
 * compiler → refinement, never back), so importing it here would ship a package
 * with an undeclared runtime dependency. Kept byte-compatible so a name this
 * package proposes is the name the compiler would have derived for the same
 * (resource, action) pair — including the compiler's known `-ses`/`-es`
 * over-strip (`releases` → `releas`), which `wordsShareToken`'s callers repair
 * deliberately rather than papering over here.
 */
export function singularize(noun: string): string {
  if (/ies$/.test(noun)) return noun.replace(/ies$/, "y");
  if (/ses$/.test(noun)) return noun.replace(/ses$/, "s");
  if (/s$/.test(noun) && !/(?:ss|us)$/.test(noun)) return noun.replace(/s$/, "");
  return noun;
}

/** Split camelCase / snake_case / kebab-case text into lowercase words. */
export function normalizedWords(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((word) => word.toLowerCase())
    .filter(Boolean);
}

/** Words too common to carry routing signal; stripped before overlap scoring. */
const ROUTING_STOPWORDS: ReadonlySet<string> = new Set([
  "the",
  "a",
  "an",
  "of",
  "for",
  "to",
  "this",
  "is",
  "with",
  "and",
  "or",
  "by",
  "on",
  "in",
]);

/**
 * The corroboration floor: content-word stems of a naming surface. CamelCase and
 * snake_case split, stopwords dropped, each word singularized so `webhooks` and
 * `webhook` count as the same token. Deterministic; returns stems in text order
 * (duplicates included — callers that need a set make one).
 */
export function routingTokens(text: string): string[] {
  return normalizedWords(text)
    .filter((word) => !ROUTING_STOPWORDS.has(word))
    .map((word) => singularize(word));
}

/**
 * Does a proposed resource word ground against a word the operation's own
 * contract (path or name text) states? Plural-insensitive via `singularize`,
 * plus the two literal plural spellings (`release` grounds against `releases`,
 * `branch` against `branches`) so a word whose plural the compiler's
 * `singularize` over-strips is still recognized as the contract's own
 * vocabulary. Deliberately NOT a fuzzy match: a word the contract never spells
 * out (in any of these inflections) does not ground.
 */
export function wordGrounds(proposed: string, contractWord: string): boolean {
  return (
    proposed === contractWord ||
    singularize(proposed) === singularize(contractWord) ||
    contractWord === `${proposed}s` ||
    contractWord === `${proposed}es`
  );
}

/** The concrete (non-templated) segments of a REST path, cleaned of format suffixes. */
export function concretePathSegments(path: string | undefined): string[] {
  if (!path) return [];
  return path
    .split("/")
    .filter((segment) => segment.length > 0 && !segment.startsWith("{"))
    .map((segment) => segment.replace(/\.(json|xml|csv|ya?ml|txt|html?|proto)$/i, ""))
    .filter((segment) => segment.length > 0 && !/^v?\d+(\.\d+)*$/i.test(segment));
}

/**
 * The ONE projection from (service, resource, action) to the three routing
 * surfaces, mirroring the compiler's `projectRoutingNames` exactly (see
 * `singularize` for why it is mirrored rather than imported). Keeping the
 * canonical name singular and the CLI segment as-written is what makes a
 * proposed rename indistinguishable from a compiled one.
 */
export function projectRoutingNames(
  serviceId: string,
  resource: string,
  action: string,
): { canonicalName: string; cliCommand: string; toolName: string } {
  const canonicalName = `${action}_${singularize(resource)}`;
  return {
    canonicalName,
    cliCommand: `${serviceId} ${snakeCase(resource)} ${action}`,
    toolName: `${serviceId}_${canonicalName}`,
  };
}
