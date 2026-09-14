import { type AirDocument, hashCanonical } from "@anvil/air";
import { curatedCatalog, lexicalRoute } from "./benchmark/routing.js";
import { scoreFamily } from "./evals/families.js";

export interface RepairCheck {
  id: string;
  passed: boolean;
}

/** Semantic refinements may enrich these annotations, never the wire contract or grants. */
export function repairInvariantHash(air: AirDocument): string {
  const value = structuredClone(air);
  const omit = (node: object, keys: string[]) => {
    for (const key of keys) delete (node as Record<string, unknown>)[key];
  };
  for (const op of value.operations) {
    omit(op, ["description", "canonicalName"]);
    omit(op.cli, ["command"]);
    omit(op.mcp, ["toolName"]);
    omit(op.skill, ["intentExamples"]);
    for (const field of [...op.input.params, ...(op.input.body?.fields ?? [])]) {
      omit(field, ["description", "agentName", "aliases", "example"]);
      omit(field.schema, ["examples"]);
    }
    for (const error of op.errors) omit(error, ["message", "recoveryAction"]);
  }
  for (const capability of value.capabilities) omit(capability, ["description", "intentExamples"]);
  return hashCanonical(value);
}

/**
 * Cases come from the ORIGINAL AIR, including its intent phrases. Candidate-authored
 * examples cannot add, remove or replace evaluation tasks. These are deterministic
 * semantic proxies, not a claim of live vendor execution or agent accuracy.
 */
export function evaluateRepairCases(baseline: AirDocument, candidate: AirDocument): RepairCheck[] {
  const checks: RepairCheck[] = [];
  const byId = new Map(candidate.operations.map((op) => [op.id, op]));
  const catalog = curatedCatalog(candidate.operations);
  for (const original of baseline.operations) {
    const op = byId.get(original.id);
    checks.push({ id: `${original.id}:present`, passed: op !== undefined });
    if (!op) continue;
    const single = { ...candidate, operations: [op] };
    checks.push({
      id: `${original.id}:safety`,
      passed: scoreFamily(single, "unsafe_operation_refusal").score === 1,
    });
    original.skill.intentExamples.forEach((phrase, index) => {
      checks.push({
        id: `${original.id}:routing:${index}`,
        passed: lexicalRoute(phrase, catalog) === op.mcp.toolName,
      });
    });
    const fields = [
      ...op.input.params,
      ...(op.input.body?.projection === "fields" ? op.input.body.fields : []),
    ];
    const originalFields = [
      ...original.input.params,
      ...(original.input.body?.projection === "fields" ? original.input.body.fields : []),
    ];
    originalFields.forEach((field, index) => {
      const current = fields[index];
      const narrowed = {
        ...single,
        operations: [
          {
            ...op,
            input: {
              ...op.input,
              body: undefined,
              params: current ? [{ inferred: false, ...current, in: "query" as const }] : [],
            },
          },
        ],
      };
      if (field.required)
        checks.push({
          id: `${original.id}:argument:${index}`,
          passed: !!current && scoreFamily(narrowed, "argument_mapping").score === 1,
        });
      checks.push({
        id: `${original.id}:field:${index}`,
        passed: !!current && scoreFamily(narrowed, "field_interpretation").score === 1,
      });
    });
    original.errors.forEach((_, index) => {
      const error = op.errors[index];
      checks.push({
        id: `${original.id}:error:${index}`,
        passed:
          !!error &&
          scoreFamily({ ...single, operations: [{ ...op, errors: [error] }] }, "error_recovery")
            .score === 1,
      });
    });
  }
  return checks;
}
