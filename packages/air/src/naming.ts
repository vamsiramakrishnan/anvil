/**
 * Naming helpers shared by the compiler and every generator so that CLI flags,
 * MCP properties, operation ids, and code identifiers are derived one way.
 * Drift in naming is drift in the tool surface, so it lives in one place.
 */

const splitWords = (s: string): string[] =>
  s
    // split camelCase / PascalCase boundaries
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    // any non-alphanumeric run is a separator
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());

export const snakeCase = (s: string): string => splitWords(s).join("_");

export const kebabCase = (s: string): string => splitWords(s).join("-");

export const camelCase = (s: string): string => {
  const words = splitWords(s);
  return words.map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1))).join("");
};

export const pascalCase = (s: string): string => {
  const c = camelCase(s);
  return c.charAt(0).toUpperCase() + c.slice(1);
};

/** A CLI flag for a parameter name, e.g. paymentId -> --payment-id. */
export const cliFlag = (name: string): string => `--${kebabCase(name)}`;

/** An MCP/JSON property key for a parameter name, e.g. paymentId -> payment_id. */
export const propKey = (name: string): string => snakeCase(name);
