import { z } from "zod";

const ProjectionPath = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_$-]+(?:\.[A-Za-z0-9_$-]+)*$/, "must be a dotted property path");

/**
 * A deterministic, contract-owned response view for agents. It can select,
 * remove, or rename existing fields; it cannot synthesize values or execute an
 * expression. Wire responses remain unchanged at the transport boundary.
 */
export const AgentProjection = z
  .object({
    include: z.array(ProjectionPath).min(1).optional(),
    exclude: z.array(ProjectionPath).min(1).optional(),
    rename: z.record(ProjectionPath, ProjectionPath).optional(),
  })
  .superRefine((projection, ctx) => {
    if (!projection.include && !projection.exclude && !projection.rename) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "projection must define a change" });
    }
    const included = new Set(projection.include ?? []);
    for (const path of projection.exclude ?? []) {
      if (included.has(path)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `projection cannot both include and exclude '${path}'`,
          path: ["exclude"],
        });
      }
    }
    for (const paths of [projection.include ?? [], projection.exclude ?? []]) {
      for (const path of paths) {
        const overlaps = paths.some(
          (candidate) => candidate !== path && candidate.startsWith(`${path}.`),
        );
        if (overlaps) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `projection paths beneath '${path}' are redundant`,
          });
        }
      }
    }
    const destinations = Object.values(projection.rename ?? {});
    if (new Set(destinations).size !== destinations.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "projection rename destinations must be unique",
        path: ["rename"],
      });
    }
    for (const [source, destination] of Object.entries(projection.rename ?? {})) {
      if (source === destination) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `projection rename '${source}' must change the field name`,
          path: ["rename", source],
        });
      }
      const sourceParent = source.split(".").slice(0, -1).join(".");
      const destinationParent = destination.split(".").slice(0, -1).join(".");
      if (sourceParent !== destinationParent) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `projection rename '${source}' must stay within its parent object`,
          path: ["rename", source],
        });
      }
    }
  });
export type AgentProjection = z.infer<typeof AgentProjection>;

function schemaAtPath(
  schema: Record<string, unknown> | undefined,
  path: string,
): Record<string, unknown> | undefined {
  let current = schema;
  for (const segment of path.split(".")) {
    if (current?.type === "array") {
      const items = current.items;
      if (!items || typeof items !== "object" || Array.isArray(items)) return undefined;
      current = items as Record<string, unknown>;
    }
    const properties = current?.properties;
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
      return undefined;
    }
    const next = (properties as Record<string, unknown>)[segment];
    if (!next || typeof next !== "object" || Array.isArray(next)) return undefined;
    current = next as Record<string, unknown>;
  }
  return current;
}

/** Validate a projection against the response schema it will actually transform. */
export function agentProjectionIssues(
  projection: AgentProjection,
  schema: Record<string, unknown> | undefined,
): string[] {
  if (!schema) return ["operation has no response schema to project"];
  const issues: string[] = [];
  const sources = [
    ...(projection.include ?? []),
    ...(projection.exclude ?? []),
    ...Object.keys(projection.rename ?? {}),
  ];
  const missing = sources.filter((path) => !schemaAtPath(schema, path));
  if (missing.length > 0)
    issues.push(`projection source path(s) do not resolve: ${missing.join(", ")}`);

  const excluded = projection.exclude ?? [];
  for (const [source, destination] of Object.entries(projection.rename ?? {})) {
    if (excluded.some((path) => source === path || source.startsWith(`${path}.`))) {
      issues.push(`rename source '${source}' is excluded first`);
    }
    if (
      projection.include &&
      !projection.include.some(
        (path) => source === path || source.startsWith(`${path}.`) || path.startsWith(`${source}.`),
      )
    ) {
      issues.push(`rename source '${source}' is not included`);
    }
    if (schemaAtPath(schema, destination)) {
      issues.push(`rename destination '${destination}' already exists in the response schema`);
    }
  }
  return issues;
}
