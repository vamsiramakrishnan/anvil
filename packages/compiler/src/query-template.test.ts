import { type Operation, Operation as OperationSchema } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { AnvilManifest, buildQueryTemplates } from "./manifest.js";

/** A read operation carrying an unconstrained query param — the template base. */
function queryOp(overrides: Record<string, unknown> = {}): Operation {
  return OperationSchema.parse({
    id: "warehouse.reports.query",
    canonicalName: "run_query",
    displayName: "Run query",
    sourceRef: { kind: "openapi", path: "/reports/query", method: "get" },
    effect: { kind: "read", action: "search", resource: "report", risk: "low", reversible: true },
    input: {
      params: [{ name: "sql", in: "query", required: true, schema: { type: "string" } }],
    },
    idempotency: { mode: "natural" },
    retries: { mode: "safe", maxAttempts: 3, backoff: "exponential_jitter", retryOn: ["timeout"] },
    confirmation: { required: false },
    auth: { type: "api_key", scopes: [] },
    cli: { command: "warehouse reports query" },
    mcp: { toolName: "warehouse_run_query" },
    skill: { intentExamples: [] },
    state: "approved",
    ...overrides,
  });
}

const template = {
  operation: "run_query",
  template: "SELECT name FROM accounts WHERE branch = '{branch}' LIMIT 10",
  target_param: "sql",
  params: { branch: { schema: { type: "string", pattern: "^[A-Z0-9]+$" } } },
  read_only: true as const,
};

describe("QueryTemplateManifest validation", () => {
  const manifest = (tpl: Record<string, unknown>) => ({
    operations: {},
    workflows: {},
    capabilities: {},
    query_templates: { branch_names: tpl },
  });

  it("rejects a placeholder with no params entry", () => {
    expect(() => AnvilManifest.parse(manifest({ ...template, params: {} }))).toThrow(
      /placeholder '\{branch\}'/,
    );
  });

  it("rejects a declared param never used in the template", () => {
    expect(() =>
      AnvilManifest.parse(
        manifest({
          ...template,
          params: { ...template.params, orphan: { schema: { type: "string" } } },
        }),
      ),
    ).toThrow(/'orphan' is declared but never used/);
  });

  it("rejects read_only: false — templates cannot wrap writes", () => {
    expect(() => AnvilManifest.parse(manifest({ ...template, read_only: false }))).toThrow();
  });
});

describe("buildQueryTemplates", () => {
  const manifest = AnvilManifest.parse({
    operations: {},
    workflows: {},
    capabilities: {},
    query_templates: { branch_names: template },
  });

  it("derives a review_required search operation bound to the base op", () => {
    const { operations, diagnostics } = buildQueryTemplates(manifest, [queryOp()], []);
    expect(diagnostics).toEqual([]);
    expect(operations).toHaveLength(1);
    const derived = operations[0];
    expect(derived?.id).toBe("warehouse.reports.query.tpl.branch_names");
    expect(derived?.effect).toMatchObject({ kind: "read", action: "search" });
    expect(derived?.archetype).toBe("search");
    expect(derived?.state).toBe("review_required");
    expect(derived?.queryTemplate).toEqual({
      baseOperationId: "warehouse.reports.query",
      template: template.template,
      targetParam: "sql",
    });
    // Template params are all required, typed inputs — never optional.
    expect(derived?.input.params).toHaveLength(1);
    expect(derived?.input.params[0]).toMatchObject({ name: "branch", required: true });
    // A derived read must not ship the retry_basis_unproven deficiency shape.
    expect(derived?.retries.basis).toBe("read_safe");
  });

  it("refuses a template on a mutation base operation with a diagnostic, not a throw", () => {
    const mutationBase = queryOp({
      effect: { kind: "mutation", action: "create", resource: "report", risk: "medium" },
    });
    const { operations, diagnostics } = buildQueryTemplates(manifest, [mutationBase], []);
    expect(operations).toEqual([]);
    expect(diagnostics).toMatchObject([
      { level: "error", code: "query_template_mutation_invalid" },
    ]);
  });

  it("reports an unresolved base operation and derives nothing", () => {
    const { operations, diagnostics } = buildQueryTemplates(manifest, [], []);
    expect(operations).toEqual([]);
    expect(diagnostics).toMatchObject([
      { level: "error", code: "query_template_operation_unresolved" },
    ]);
  });
});
