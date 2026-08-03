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
 */

import { Parser } from "node-sql-parser";

/** Anvil dialect → node-sql-parser `database` option. */
const DIALECT_TO_DATABASE: Record<string, string> = {
  ansi: "postgresql", // the portable subset; postgres is the strictest common parser
  postgres: "postgresql",
  mysql: "mysql",
  // Future families plug in here: bigquery, snowflake, redshift, hive, mariadb…
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
  code: "unsupported_dialect" | "parse_failed" | "multiple_statements" | "placeholder_position";
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
  // A `:name` bind marker is a value-only token in every SQL grammar, so the
  // parser itself enforces "placeholders live in literal positions".
  const probed = template.replace(PLACEHOLDER, (_m, name: string) => `:${name}`);
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
    tables = parser.tableList(probed, { database }).map((t) => {
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
