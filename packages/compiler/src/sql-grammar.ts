/**
 * Authoring-time SQL grammar analysis, backed by a real parser (node-sql-parser).
 *
 * This is the deep, accurate half of Anvil's grammar awareness — it runs at
 * COMPILE time (never in the deployed runtime, which stays lean with the
 * dependency-free `@anvil/grammar` tokenizer). A real AST lets Anvil validate a
 * declared template or policy far more precisely than heuristics: exact
 * statement typing, exact table extraction (including qualified names), and a
 * fail-closed placeholder-position check. node-sql-parser bundles ~15 SQL
 * dialects, so this is also the seam that scales the SQL grammar family across
 * Postgres, MySQL, BigQuery, Snowflake, Redshift, Hive, and friends.
 *
 * node-sql-parser is ~89MB (it bundles every dialect grammar), so it is loaded
 * LAZILY via `require` — only when a query template actually needs validating.
 * The overwhelming majority of compiles have no SQL templates and must not pay
 * that module-load cost just for importing the compiler.
 */

// A NAMESPACE import of node:module (not a named import): a browser bundler
// externalizes `node:module` to an empty stub, and a named `createRequire`
// import would then fail to resolve at build time. Namespace access is resolved
// at runtime, so the browser docs playground bundles cleanly and simply finds
// `createRequire` undefined — at which point analyzeSqlTemplate falls back to
// the lean tokenizer analyzer. node-sql-parser is loaded via runtime `require`,
// so it is never followed into a browser bundle.
import * as nodeModule from "node:module";

// biome-ignore lint/suspicious/noExplicitAny: node-sql-parser ships no ESM types we consume here.
type ParserCtor = new () => any;
let parserCtor: ParserCtor | undefined;

/** True when a real Node `require` is reachable (false in a browser bundle). */
function parserAvailable(): boolean {
  return typeof (nodeModule as { createRequire?: unknown }).createRequire === "function";
}

function loadParser(): ParserCtor {
  if (!parserCtor) {
    const createRequire = (nodeModule as { createRequire: (url: string) => NodeRequire })
      .createRequire;
    const require = createRequire(import.meta.url);
    parserCtor = (require("node-sql-parser") as { Parser: ParserCtor }).Parser;
  }
  return parserCtor;
}

/**
 * Anvil dialect → node-sql-parser `database` option. Each warehouse maps to the
 * grammar node-sql-parser actually ships for it, so a declared template/policy
 * is validated against real BigQuery/Snowflake/Redshift syntax — not a generic
 * approximation. `databricks` has no dedicated grammar; Databricks SQL derives
 * from Spark/Hive, so it maps to the `hive` grammar as the closest available
 * (an authoring-time approximation only — the runtime guard is grammar-neutral).
 */
const DIALECT_TO_DATABASE: Record<string, string> = {
  ansi: "postgresql", // the portable subset; postgres is the strictest common parser
  postgres: "postgresql",
  mysql: "mysql",
  bigquery: "bigquery",
  snowflake: "snowflake",
  redshift: "redshift",
  databricks: "hive", // closest shipped grammar (Databricks SQL ⊃ Spark ⊃ Hive)
};

interface SqlTemplateAnalysisOk {
  ok: true;
  /** Statement class read from the AST (e.g. "select"). */
  statementType: string;
  /** Fully-qualified tables the query touches, `schema.table` (schema omitted when none). */
  tables: string[];
}
interface SqlTemplateAnalysisErr {
  ok: false;
  code:
    | "unsupported_dialect"
    | "parser_unavailable"
    | "parse_failed"
    | "multiple_statements"
    | "placeholder_position";
  message: string;
}
export type SqlTemplateAnalysis = SqlTemplateAnalysisOk | SqlTemplateAnalysisErr;

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Validate a query template with a real parser. Every `{param}` is replaced by a
 * bind-parameter marker (`:param`), which a real SQL grammar accepts ONLY in a
 * value position — so a placeholder in an identifier position (`FROM {table}`)
 * makes the parse throw, and we surface that as a precise error. Multi-statement
 * templates and unparseable templates are refused. Returns the statement type
 * and the real table list for downstream use (policy defaulting, schema cards).
 */
export function analyzeSqlTemplate(template: string, dialect: string): SqlTemplateAnalysis {
  const database = DIALECT_TO_DATABASE[dialect];
  if (!database) {
    return {
      ok: false,
      code: "unsupported_dialect",
      message: `SQL dialect '${dialect}' is not supported by the grammar analyzer.`,
    };
  }
  if (!parserAvailable()) {
    // Browser bundle (docs playground) — no Node require. The caller falls back
    // to the lean tokenizer analyzer, so validation still happens, just without
    // the deep AST checks.
    return {
      ok: false,
      code: "parser_unavailable",
      message: "The SQL parser is not available in this environment.",
    };
  }
  // A `:name` bind marker is a value-only token in every SQL grammar, so the
  // parser itself enforces "placeholders live in literal positions".
  const probed = template.replace(PLACEHOLDER, (_m, name: string) => `:${name}`);
  const Parser = loadParser();
  const parser = new Parser();
  let ast: unknown;
  try {
    ast = parser.astify(probed, { database });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A throw at a `:param` marker means it sat somewhere a value cannot go.
    const placeholderish = /Expected|Unexpected|:/i.test(message) && PLACEHOLDER.test(template);
    return {
      ok: false,
      code: placeholderish ? "placeholder_position" : "parse_failed",
      message: `Template did not parse as a single ${dialect} statement: ${message}`,
    };
  }
  const statements = Array.isArray(ast) ? ast : [ast];
  if (statements.length !== 1) {
    return {
      ok: false,
      code: "multiple_statements",
      message: "A template must be a single statement.",
    };
  }
  const first = statements[0] as { type?: string };
  const statementType = first.type ?? "unknown";
  let tables: string[] = [];
  try {
    // tableList entries are "type::schema::table"; project to schema.table.
    const rawTables = parser.tableList(probed, { database }) as string[];
    tables = rawTables.map((t: string) => {
      const [, schema, table] = t.split("::");
      return schema && schema !== "null" ? `${schema}.${table}` : (table ?? t);
    });
  } catch {
    tables = [];
  }
  return { ok: true, statementType, tables };
}

/** The SQL dialects the authoring-time analyzer understands today. */
export function supportedSqlDialects(): string[] {
  return Object.keys(DIALECT_TO_DATABASE);
}
