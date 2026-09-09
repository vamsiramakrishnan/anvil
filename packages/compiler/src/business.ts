import {
  AirDocument,
  type BusinessAction,
  type BusinessBinding,
  BusinessDefinition,
  type BusinessPlan,
  hashCanonical,
  Operation,
  operationInputSchema,
  operationSafetyInputKeys,
  validateBusinessValue,
} from "@anvil/air";

const JSON_KEYS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
  "description",
  "title",
  "examples",
  "default",
  "$schema",
]);
function schemaCheck(schema: Record<string, unknown>, label: string): void {
  for (const key of Object.keys(schema)) {
    if (!JSON_KEYS.has(key))
      throw new Error(
        `${label}: unsupported schema keyword ${key}; resolve unions and references before authoring.`,
      );
  }
  if (!schema.type) throw new Error(`${label}: an explicit JSON Schema type is required.`);
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.includes("object")) {
    if (schema.additionalProperties !== false)
      throw new Error(`${label}: object schemas must declare additionalProperties: false.`);
    for (const [key, child] of Object.entries(
      (schema.properties ?? {}) as Record<string, Record<string, unknown>>,
    )) {
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(key))
        throw new Error(`${label}: use portable snake_case field names.`);
      schemaCheck(child, `${label}/${key}`);
    }
  }
  if (types.includes("array")) schemaCheck(schema.items as Record<string, unknown>, `${label}/*`);
  // Building the validator also rejects unsupported constraints and malformed schemas.
  validateBusinessValue(schema, undefined);
}

function schemaAt(schema: Record<string, unknown>, pointer: string): Record<string, unknown> {
  let current = schema;
  for (const part of pointer === "" ? [] : pointer.slice(1).split("/")) {
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    const child =
      current.type === "array" && /^\d+$/.test(key)
        ? current.items
        : (current.properties as Record<string, unknown> | undefined)?.[key];
    if (!child || typeof child !== "object" || Array.isArray(child))
      throw new Error(`Binding pointer ${pointer} is not declared in its source schema.`);
    current = child as Record<string, unknown>;
  }
  return current;
}

function bindingSchema(
  binding: BusinessBinding,
  action: BusinessAction,
  previous: Map<string, Operation>,
): Record<string, unknown> | undefined {
  if (binding.from === "literal") return undefined;
  if (binding.from === "context") return { type: "string" };
  if (binding.from === "input") return schemaAt(action.input, binding.pointer);
  const op = previous.get(binding.step);
  if (!op)
    throw new Error(
      `Binding references unavailable step ${binding.step}; forward references are forbidden.`,
    );
  if (!op.output.schema) throw new Error(`Step ${binding.step} needs a declared output schema.`);
  return schemaAt(op.output.schema, binding.pointer);
}

function checkBinding(
  binding: BusinessBinding,
  target: Record<string, unknown>,
  action: BusinessAction,
  previous: Map<string, Operation>,
): void {
  const source = bindingSchema(binding, action, previous);
  if (!source) {
    if (binding.from === "literal" && !validateBusinessValue(target, binding.value))
      throw new Error("Literal binding does not satisfy its destination schema.");
    return;
  }
  const targetTypes = Array.isArray(target.type) ? target.type : [target.type];
  const sourceTypes = Array.isArray(source.type) ? source.type : [source.type];
  if (
    target.type &&
    (!source.type ||
      sourceTypes.some(
        (t) => !targetTypes.includes(t) && !(t === "integer" && targetTypes.includes("number")),
      ))
  ) {
    throw new Error("Binding types do not match; use an explicit adapter to convert values.");
  }
}

function publicOperation(
  action: BusinessAction,
  sources: Record<string, AirDocument>,
  caller: "service" | "end_user",
): Operation {
  const members = action.steps.map(
    (s) => sources[s.source]?.operations.find((op) => op.id === s.operationId) as Operation,
  );
  const writes = members.filter((op) => op.effect.kind === "mutation");
  const riskOrder = ["none", "low", "medium", "high", "financial", "destructive"];
  const risk = members.reduce(
    (acc, op) =>
      riskOrder.indexOf(op.effect.risk) > riskOrder.indexOf(acc) ? op.effect.risk : acc,
    "none" as Operation["effect"]["risk"],
  );
  return Operation.parse({
    id: action.id,
    canonicalName: action.id,
    displayName: action.id.replaceAll("_", " "),
    description: `${action.description}${writes.length ? ` Effects: ${action.steps.flatMap((s) => s.effect ?? []).join("; ")}. Inspect status and completed_effects before reporting success.` : ""}`,
    sourceRef: {
      kind: "openapi",
      method: "post",
      path: `/business/${action.id}`,
      operationId: action.id,
    },
    effect: {
      kind: writes.length ? "mutation" : "read",
      risk,
      reversible: members.every((op) => op.effect.reversible),
    },
    input: {
      params: [],
      body: {
        required: true,
        projection: "fields",
        schema: action.input,
        fields: Object.entries(
          action.input.properties as Record<string, Record<string, unknown>>,
        ).map(([name, schema]) => ({
          name,
          schema,
          required: (action.input.required as string[] | undefined)?.includes(name) ?? false,
        })),
      },
    },
    output: { schema: businessResultSchema(action.output) },
    idempotency: writes.length
      ? {
          mode: "required",
          mechanism: "header",
          key: "Idempotency-Key",
          keyDerivation: "client_supplied",
        }
      : { mode: "natural" },
    retries: { mode: "none" },
    confirmation: { required: writes.length > 0, humanApproval: action.humanApproval },
    auth: {
      type: caller === "end_user" ? "oauth2_authorization_code" : "jwt_bearer",
      scopes: action.requiredScopes,
      principal: caller,
    },
    cli: { command: action.id.replaceAll("_", " ") },
    mcp: { toolName: action.id },
    skill: { intentExamples: action.guidance.intents },
    state: action.state === "approved" ? "approved" : "review_required",
  });
}

export function businessResultSchema(result: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["status", "trace_id", "completed_effects"],
    properties: {
      status: {
        type: "string",
        enum: ["completed", "rejected", "partial", "reconciliation_required", "approval_required"],
      },
      result,
      trace_id: { type: "string" },
      completed_effects: { type: "array", items: { type: "string" } },
      message: { type: "string" },
      next_action: { type: "string" },
      approval_digest: { type: "string" },
    },
  };
}

/** Compile a reviewed business contract against explicit, immutable source snapshots. */
export function compileBusiness(
  definitionInput: unknown,
  sourceInputs: Record<string, unknown>,
): { air: AirDocument; plan: BusinessPlan } {
  const definition = BusinessDefinition.parse(definitionInput);
  const sources = Object.fromEntries(
    Object.entries(sourceInputs).map(([id, input]) => [id, AirDocument.parse(input)]),
  );
  const ids = new Set<string>();
  for (const action of definition.actions) {
    if (ids.has(action.id)) throw new Error(`Duplicate business action ${action.id}.`);
    ids.add(action.id);
    schemaCheck(action.input, `${action.id} input`);
    schemaCheck(action.output, `${action.id} output`);
    if (action.input.type !== "object" || action.output.type !== "object")
      throw new Error("Business input and output must be objects.");
    const previous = new Map<string, Operation>();
    for (const step of action.steps) {
      const op = sources[step.source]?.operations.find((op) => op.id === step.operationId);
      if (op?.state !== "approved")
        throw new Error(`Step ${step.id} must bind an explicitly approved source operation.`);
      if (sources[step.source]?.business)
        throw new Error(
          "Nested business gateways need an explicit external adapter; recursive plans are not supported.",
        );
      if (previous.has(step.id)) throw new Error(`Duplicate step ${step.id}.`);
      if (op.longRunning || op.streaming)
        throw new Error(
          `Step ${step.id}: asynchronous operations need a separate submit/status business contract.`,
        );
      if (op.effect.kind === "mutation" && !step.effect)
        throw new Error(`Step ${step.id} must disclose its business effect.`);
      if (op.confirmation.humanApproval && !action.humanApproval)
        throw new Error(`Action ${action.id} cannot weaken source human approval.`);
      const schema = operationInputSchema(op);
      const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
      const safety = operationSafetyInputKeys(op);
      for (const [key, binding] of Object.entries(step.input)) {
        if (!Object.hasOwn(props, key) || key === safety.confirm || key === safety.idempotencyKey)
          throw new Error(`Step ${step.id}: binding ${key} is not a business input.`);
        checkBinding(binding, props[key] as Record<string, unknown>, action, previous);
      }
      for (const key of (schema.required ?? []) as string[]) {
        if (
          key !== safety.confirm &&
          key !== safety.idempotencyKey &&
          !Object.hasOwn(step.input, key)
        )
          throw new Error(`Step ${step.id}: missing required binding ${key}.`);
      }
      for (const guard of step.preconditions) {
        const left = bindingSchema(guard.value, action, previous);
        const right = bindingSchema(guard.equals, action, previous);
        if (left) checkBinding(guard.equals, left, action, previous);
        else if (right) checkBinding(guard.value, right, action, previous);
      }
      previous.set(step.id, op);
    }
    const properties = (action.output.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const [key, binding] of Object.entries(action.result)) {
      if (!Object.hasOwn(properties, key))
        throw new Error(`Undeclared business result field ${key}.`);
      checkBinding(binding, properties[key] as Record<string, unknown>, action, previous);
    }
    for (const key of (action.output.required ?? []) as string[]) {
      if (!Object.hasOwn(action.result, key))
        throw new Error(`Missing business result binding ${key}.`);
    }
  }
  const plan = { definition, sources, digest: hashCanonical({ definition, sources }) };
  const business = {
    planDigest: plan.digest,
    actions: definition.actions
      .filter((a) => a.state === "approved")
      .map((a) => ({
        id: a.id,
        guidance: a.guidance,
        effects: a.steps.flatMap((s) => s.effect ?? []),
      })),
  };
  const air = AirDocument.parse({
    service: {
      id: definition.id,
      version: definition.version,
      displayName: definition.displayName,
      source: { kind: "openapi", sourceHash: plan.digest },
      servers: [{ url: definition.gatewayUrl }],
    },
    business,
    operations: definition.actions.map((action) => ({
      ...publicOperation(action, sources, definition.caller),
      capabilityId: definition.id,
    })),
    capabilities: [
      {
        id: definition.id,
        displayName: definition.displayName,
        description: definition.description,
        operationIds: definition.actions.map((a) => a.id),
        intentExamples: definition.actions.flatMap((a) => a.guidance.intents),
        state: definition.actions.every((a) => a.state === "approved")
          ? "approved"
          : "review_required",
        lifecycle: definition.actions.every((a) => a.state === "approved")
          ? "approved"
          : "proposed",
      },
    ],
  });
  return { air, plan };
}
