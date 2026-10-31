import { type AirDocument, hashCanonical, type Operation, operationInputSchema } from "@anvil/air";
import { decideGrant, type Principal, principalHasScopes } from "@anvil/runtime";

export interface TaskCatalogOptions {
  query: string;
  principal: Principal;
  connector?: string;
  maxTokens: number;
  /** True only when the host has negotiated dynamic catalog support with this client. */
  dynamicLists: boolean;
}
const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]+/g) ?? []);

/** Workflow and resource authority must be reviewed independently of operation discovery. */
export function taskCatalogView(air: AirDocument, options: TaskCatalogOptions): AirDocument {
  const catalog = taskCatalog(air, options);
  const ids = new Set(catalog.operations.map((op) => op.id));
  return {
    ...air,
    operations: catalog.operations,
    workflows: [],
    capabilities: air.capabilities.map((c) => ({
      ...c,
      operationIds: c.operationIds.filter((id) => ids.has(id)),
    })),
  };
}

/** Discovery is scoped before ranking. It grants no execution authority. */
export function taskCatalog(air: AirDocument, options: TaskCatalogOptions) {
  if (
    !options.principal.id ||
    options.query.length > 8192 ||
    !Number.isSafeInteger(options.maxTokens) ||
    options.maxTokens < 128 ||
    options.maxTokens > 100_000
  )
    throw new Error("Invalid task catalog context or budget");
  const allowed = air.operations.filter(
    (op) =>
      op.state === "approved" &&
      principalHasScopes(options.principal, op.auth.scopes) &&
      (options.principal.grants === undefined ||
        decideGrant(options.principal.grants, options.connector ?? "", op, air.service.id).allowed),
  );
  const query = words(options.query);
  const ranked = allowed
    .map((op) => {
      const terms = words(
        [op.canonicalName, op.description ?? "", ...op.skill.intentExamples].join(" "),
      );
      const score = [...query].filter((word) => terms.has(word)).length;
      // Explicit estimate; provider usage is metered separately, never inferred from this number.
      const estimatedTokens = Math.ceil(
        JSON.stringify({
          name: op.mcp.toolName,
          description: op.description,
          input: operationInputSchema(op),
        }).length / 4,
      );
      return { op, score, estimatedTokens };
    })
    .sort((a, b) => b.score - a.score || a.op.id.localeCompare(b.op.id));
  let remaining = options.maxTokens;
  const selected: Operation[] = [];
  for (const row of ranked) {
    if (!options.dynamicLists || row.estimatedTokens <= remaining) {
      selected.push(structuredClone(row.op));
      remaining -= row.estimatedTokens;
    }
  }
  const ids = new Set(selected.map((op) => op.id));
  return {
    operations: selected,
    authorizedIds: allowed.map((op) => op.id).sort(),
    omittedIds: allowed
      .filter((op) => !ids.has(op.id))
      .map((op) => op.id)
      .sort(),
    estimatedTokens: options.maxTokens - remaining,
    reason: !options.dynamicLists
      ? "client-flat-fallback"
      : selected.length < allowed.length
        ? "budgeted"
        : "complete",
    digest: hashCanonical({
      contract: air,
      query: options.query,
      principal: options.principal,
      connector: options.connector ?? null,
      budget: options.maxTokens,
      dynamic: options.dynamicLists,
      ids: [...ids],
    }),
  };
}
