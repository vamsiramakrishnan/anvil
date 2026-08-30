import type { AirDocument, JsonSchema, Operation } from "@anvil/air";

/**
 * A structural candidate for a `Workflow`: calling `toOperationId` right after
 * `fromOperationId`, threading each of `toOperation`'s required input params from
 * a same-named leaf field in `fromOperation`'s output schema. Purely deterministic
 * — no evidence, no MCP connectivity — the same "propose a candidate, never a
 * fact" discipline as `capability compose`'s structural overlap detection.
 * Anvil does not fabricate the business meaning of the sequence; it only proves
 * that the *data* lines up. Whether the sequence is real is what enrichment then
 * asks a connected source to corroborate.
 */
export interface WorkflowCandidate {
  fromOperationId: string;
  toOperationId: string;
  /** toOperation's input param name -> JSON Pointer into fromOperation's output. */
  bindings: Record<string, string>;
  /**
   * Operation ids this candidate PROPOSES the composite should replace on the
   * MCP tool surface (`Workflow.supersedes`). A proposal and nothing more:
   * nothing here applies it, `reconcileWorkflow` carries it into a manifest
   * entry that is always `state: "review_required"`, and only a human approving
   * that workflow lets `@anvil/mcp-runtime` act on it. Suppressing a tool is a
   * tightening — the cheap direction under asymmetric trust — but it can still
   * break a caller that legitimately invoked the operation on its own, and that
   * is a judgement about callers Anvil cannot observe.
   */
  supersedes: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One level of leaf field names from a JSON Schema object, descending through a
 * single array wrapper (a list/search operation's real payload is `items[].field`,
 * not the envelope itself). Deliberately shallow: a deep walk would start
 * matching on coincidental nested names, exactly the structural-noise problem
 * `capability compose` already has at the leaf level.
 */
function leafFieldNames(schema: JsonSchema | undefined): Set<string> {
  const out = new Set<string>();
  if (!isRecord(schema)) return out;
  const properties = isRecord(schema.properties) ? schema.properties : undefined;
  if (properties) {
    for (const key of Object.keys(properties)) out.add(key);
    return out;
  }
  if (schema.type === "array" && isRecord(schema.items)) {
    return leafFieldNames(schema.items as JsonSchema);
  }
  return out;
}

/** toOperation's required, name-matchable input params (path/query only — a body field isn't a simple binding target here). */
function requiredParamNames(op: Operation): string[] {
  return op.input.params.filter((p) => p.required && p.in !== "header").map((p) => p.name);
}

/**
 * Candidate (from, to) pairs within the same capability where `to`'s entire set
 * of required params resolves against a same-named leaf field of `from`'s output.
 * A partial match (some but not all required params bound) is not a candidate —
 * `to` still couldn't actually be called from `from`'s output alone.
 */
export function detectWorkflowCandidates(air: AirDocument): WorkflowCandidate[] {
  const byCapability = new Map<string, Operation[]>();
  for (const op of air.operations) {
    if (!op.capabilityId) continue;
    const list = byCapability.get(op.capabilityId) ?? [];
    list.push(op);
    byCapability.set(op.capabilityId, list);
  }

  const out: WorkflowCandidate[] = [];
  for (const ops of byCapability.values()) {
    for (const fromOp of ops) {
      if (fromOp.effect.kind !== "read") continue;
      const outputFields = leafFieldNames(fromOp.output.schema);
      if (outputFields.size === 0) continue;

      for (const toOp of ops) {
        if (toOp.id === fromOp.id) continue;
        const required = requiredParamNames(toOp);
        if (required.length === 0) continue;
        if (!required.every((name) => outputFields.has(name))) continue;

        const bindings: Record<string, string> = {};
        for (const name of required) bindings[name] = `$.output.${name}`;
        // Propose superseding `to` only, never `from`.
        //
        // This is read straight off the structural fact the detector just
        // proved, not off a preference: EVERY required param of `to` is bound
        // from `from`'s output, so within this pairing `to` is not callable
        // from anything the agent already holds — the composite genuinely
        // stands in for it. `from` is the opposite: a read an agent reaches
        // independently, whose output is the entry point to this sequence and
        // to others the detector never looked at. Suppressing it would remove a
        // tool the composite does not replace.
        out.push({
          fromOperationId: fromOp.id,
          toOperationId: toOp.id,
          bindings,
          supersedes: [toOp.id],
        });
      }
    }
  }
  return out;
}
