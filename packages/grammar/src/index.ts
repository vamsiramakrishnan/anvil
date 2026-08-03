/**
 * `@anvil/grammar` — dependency-free grammar awareness for query-passthrough
 * surfaces. A security-focused SQL tokenizer, a structural policy validator that
 * proves what a query *cannot* do, and a context-aware template renderer that
 * makes injection grammatically impossible rather than merely discouraged.
 *
 * The whole package fails closed: an unparseable query, an unresolvable
 * template position, or a value that cannot render as a safe literal is
 * refused, never sent.
 */

export {
  checkQuery,
  type PolicyResult,
  type PolicyViolation,
  type QueryPolicy,
  type StatementClass,
} from "./policy.js";
export {
  analyzeTemplate,
  escapeStringLiteralBody,
  type PlaceholderContext,
  type PlaceholderSite,
  type RenderErr,
  type RenderOk,
  type RenderResult,
  renderTemplate,
  type TemplateAnalysis,
} from "./template.js";
export {
  type SqlDialect,
  significantTokens,
  type Token,
  type TokenizeErr,
  type TokenizeOk,
  type TokenizeResult,
  type TokenKind,
  tokenize,
} from "./tokenize.js";
