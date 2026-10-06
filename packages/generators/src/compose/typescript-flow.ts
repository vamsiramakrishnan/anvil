/**
 * The flow half of the TypeScript composite runtime: `Flow`, its run
 * record, and the compensation plan. Appended to the core in
 * `typescript.ts`; one module on disk, two here only to keep each file small.
 */
export const TYPESCRIPT_FLOW = String.raw`// -- flows ------------------------------------------------------------------------

export interface StepOptions {
  connector?: string;
  after?: Array<string | StepHandle>;
  when?: Record<string, unknown>;
  confirm?: boolean;
  idempotencyKey?: string;
}

export interface StepRecord {
  operation: string;
  connector: string;
  status: "ok" | "failed" | "skipped" | "not_run";
  result?: unknown;
  error?: Record<string, unknown>;
  calls_completed?: number;
}

export interface CompensationEntry {
  step: string;
  call: number;
  connector: string;
  operation: string;
  effect_class: string;
  undo?: { kind: string; operation: string; arguments: Record<string, unknown> };
  reason?: string;
}

export interface FlowRun {
  schema: typeof RUN_SCHEMA;
  flow: string;
  dry_run: boolean;
  status: "succeeded" | "failed" | "refused";
  ok: boolean;
  order: string[];
  failed_step: string | null;
  error: Record<string, unknown> | null;
  steps: Record<string, StepRecord>;
  compensation: CompensationEntry[];
}

function errorJson(error: unknown): Record<string, unknown> {
  if (error instanceof ComposeError) return error.toJSON();
  const e = error as { code?: unknown; message?: unknown; details?: unknown; error?: { code?: unknown } };
  if (typeof e?.code === "string") {
    return { code: e.code, message: String(e.message ?? ""), details: (e.details as object) ?? {} };
  }
  return { code: "internal_error", message: String((error as Error)?.message ?? error), details: {} };
}

/**
 * A DAG of connector calls. Build it with step()/map(); read it with plan(),
 * validate(), mermaid(), toJSON(); exercise it with dryRun(); execute it with
 * run(); undo what a run did, when you decide to, with compensate().
 */
export class Flow {
  private readonly steps: FlowStep[] = [];
  constructor(
    readonly composite: Composite,
    readonly name: string,
  ) {}

  /** @internal */
  add(step: FlowStep): StepHandle {
    if (this.steps.some((s) => s.id === step.id)) {
      throw new ComposeError("duplicate_step", "step id '" + step.id + "' is used twice", { step: step.id });
    }
    this.steps.push(step);
    return new StepHandle(step.id);
  }

  step(id: string, operation: string, args: Record<string, unknown> = {}, options: StepOptions = {}): StepHandle {
    const step: FlowStep = { id, operation, args: encode(args) as Record<string, Json> };
    if (options.connector) step.connector = options.connector;
    const after = (options.after ?? []).map((a) => (a instanceof StepHandle ? a.id : a));
    if (after.length > 0) step.after = after;
    if (options.when) step.when = encode(options.when) as Record<string, Json>;
    if (options.confirm) step.confirm = true;
    if (options.idempotencyKey !== undefined) step.idempotency_key = options.idempotencyKey;
    return this.add(step);
  }

  /** One call per element of over (a list); item() is the element. The result is the list of results. */
  map(
    id: string,
    operation: string,
    over: StepHandle | Ref,
    args: Record<string, unknown> = {},
    options: StepOptions = {},
  ): StepHandle {
    const handle = this.step(id, operation, args, options);
    (this.steps[this.steps.length - 1] as FlowStep).for_each = encode(
      over instanceof Ref ? over : ref(over),
    ) as Record<string, Json>;
    return handle;
  }

  toJSON(): FlowDocument {
    return { schema: FLOW_SCHEMA, name: this.name, steps: JSON.parse(JSON.stringify(this.steps)) };
  }

  private dependsOn(step: FlowStep): string[] {
    const deps: string[] = [];
    for (const dep of [...refsIn(step.args), ...refsIn(step.for_each), ...refsIn(step.when), ...(step.after ?? [])]) {
      if (!deps.includes(dep)) deps.push(dep);
    }
    return deps;
  }

  private order(): { order: string[]; waves: string[][] } {
    const ids = this.steps.map((s) => s.id);
    const deps = new Map(this.steps.map((s) => [s.id, this.dependsOn(s).filter((d) => ids.includes(d))]));
    const done: string[] = [];
    const waves: string[][] = [];
    let remaining = [...ids];
    while (remaining.length > 0) {
      const wave = remaining.filter((id) => (deps.get(id) ?? []).every((d) => done.includes(d)));
      if (wave.length === 0) {
        throw new ComposeError("cycle", "steps " + remaining.join(", ") + " depend on each other", {
          steps: remaining,
        });
      }
      waves.push(wave);
      done.push(...wave);
      remaining = remaining.filter((id) => !wave.includes(id));
    }
    return { order: done, waves };
  }

  /** Findings; any "error" stops run() before a call is sent. */
  validate(): Finding[] {
    const findings: Finding[] = [];
    const add = (level: Finding["level"], code: string, step: string | null, message: string) =>
      findings.push({ level, code, step, message });
    const ids = this.steps.map((s) => s.id);
    for (const step of this.steps) {
      for (const dep of this.dependsOn(step)) {
        if (!ids.includes(dep)) add("error", "unknown_step", step.id, "depends on step '" + dep + "', which is not in the flow");
        else if (dep === step.id) add("error", "cycle", step.id, "depends on itself");
      }
      let op: Op;
      try {
        op = this.composite.resolve(step.operation, step.connector)[1];
      } catch (error) {
        const e = errorJson(error);
        add("error", String(e.code), step.id, String(e.message));
        continue;
      }
      if (usesItem(step.args) && !step.for_each) add("error", "item_outside_map", step.id, "uses item() but is not a map step");
      let given: Set<string>;
      try {
        given = new Set(Object.keys(normalise(op, step.args ?? {})));
      } catch (error) {
        const e = errorJson(error);
        add("error", String(e.code), step.id, String(e.message));
        given = new Set(Object.keys(step.args ?? {}));
      }
      for (const input of op.inputs) {
        if (input.required && !given.has(input.key)) add("error", "missing_input", step.id, op.id + " needs input '" + input.key + "'");
      }
      if (op.confirm && !step.confirm) {
        add(
          "error",
          "confirmation_required",
          step.id,
          op.id + " needs confirmation; set confirm on the step only if the task asks for this effect",
        );
      }
      if (op.idempotencyKeyRequired && !step.idempotency_key && !step.for_each) {
        add("error", "idempotency_required", step.id, op.id + " needs an idempotency_key");
      }
      if (op.effect === "mutation" && op.effectClass === "irreversible") {
        add("warning", "irreversible", step.id, op.id + " cannot be undone; a later failure cannot be compensated for this step");
      }
      if (op.effect === "mutation" && step.for_each && op.idempotencyKeyRequired) {
        add("error", "idempotency_required", step.id, op.id + " needs a key per call, and a map step has one key; split the step");
      }
    }
    try {
      this.order();
    } catch (error) {
      add("error", "cycle", null, (error as Error).message);
    }
    return findings;
  }

  /** The DAG as data: nodes, edges, waves. Nothing is sent. */
  plan(): Record<string, unknown> {
    const nodes: Array<Record<string, unknown>> = [];
    const edges: string[][] = [];
    for (const step of this.steps) {
      const deps = this.dependsOn(step);
      const node: Record<string, unknown> = { id: step.id, operation: step.operation, depends_on: deps };
      try {
        const [connector, op] = this.composite.resolve(step.operation, step.connector);
        Object.assign(node, {
          connector,
          qualified: connector + ":" + op.id,
          effect: op.effect,
          effect_class: op.effectClass,
          confirm: op.confirm,
          undo: op.undo ? op.undo.kind : null,
        });
      } catch (error) {
        node.error = errorJson(error);
      }
      if (step.for_each) node.for_each = step.for_each;
      if (step.when) node.when = step.when;
      nodes.push(node);
      for (const dep of deps) edges.push([dep, step.id]);
    }
    let waves: string[][] = [];
    try {
      waves = this.order().waves;
    } catch {
      waves = [];
    }
    const writes = nodes.filter((n) => n.effect === "mutation");
    return {
      schema: PLAN_SCHEMA,
      name: this.name,
      nodes,
      edges,
      waves,
      connectors: [...new Set(nodes.map((n) => n.connector).filter((c): c is string => typeof c === "string"))].sort(),
      summary: {
        steps: nodes.length,
        reads: nodes.length - writes.length,
        writes: writes.length,
        irreversible: writes.filter((n) => n.effect_class === "irreversible").map((n) => n.id),
      },
    };
  }

  mermaid(): string {
    const safe = (id: string) => id.replace(/\W/g, "_");
    const lines = ["flowchart TD"];
    for (const node of this.plan().nodes as Array<Record<string, unknown>>) {
      const label = String(node.id) + "<br/>" + String(node.qualified ?? node.operation);
      lines.push("  " + safe(String(node.id)) + (node.effect === "mutation" ? "[[" + label + "]]" : "[" + label + "]"));
      for (const dep of node.depends_on as string[]) lines.push("  " + safe(dep) + " --> " + safe(String(node.id)));
    }
    return lines.join("\n");
  }

  /** Every step through its SDK's gates with dryRun, in order; refs to results become placeholders. */
  dryRun(): Promise<FlowRun> {
    return this.execute(true);
  }

  /**
   * Validate, then call each step in dependency order; stop at the first
   * failure. A failed run carries compensation: the undo of each completed
   * write, newest first. Nothing is undone; call compensate() to do that.
   */
  run(): Promise<FlowRun> {
    return this.execute(false);
  }

  private async execute(dryRun: boolean): Promise<FlowRun> {
    const result: FlowRun = {
      schema: RUN_SCHEMA,
      flow: this.name,
      dry_run: dryRun,
      status: "succeeded",
      ok: true,
      order: [],
      failed_step: null,
      error: null,
      steps: {},
      compensation: [],
    };
    const errors = this.validate().filter((f) => f.level === "error");
    if (errors.length > 0) {
      return {
        ...result,
        status: "refused",
        ok: false,
        error: { code: "invalid_flow", message: "the flow has " + errors.length + " error(s)", details: { findings: errors } },
      };
    }
    const outputs = new Map<string, unknown>();
    const completed: Array<{ step: string; connector: string; op: Op; calls: Array<[Record<string, unknown>, unknown]> }> = [];
    const byId = new Map(this.steps.map((s) => [s.id, s]));
    for (const id of this.order().order) {
      const step = byId.get(id) as FlowStep;
      const [connector, op] = this.composite.resolve(step.operation, step.connector);
      const record: StepRecord = { operation: op.id, connector, status: "not_run" };
      result.steps[id] = record;
      if (result.failed_step !== null) continue;
      result.order.push(id);
      if (step.when && !dryRun && !conditionHolds(step.when, outputs)) {
        record.status = "skipped";
        continue;
      }
      const calls: Array<[Record<string, unknown>, unknown]> = [];
      const callOnce = async (element: Found) => {
        const args = resolve(step.args ?? {}, outputs, element, dryRun) as Record<string, unknown>;
        const answer = await this.composite.call(op.id, args, {
          connector,
          confirm: !!step.confirm,
          ...(step.idempotency_key !== undefined ? { idempotencyKey: step.idempotency_key } : {}),
          dryRun,
        });
        calls.push([args, answer]);
        return answer;
      };
      try {
        if (step.for_each) {
          let items = resolve(step.for_each, outputs, MISSING, dryRun);
          if (dryRun && !Array.isArray(items)) items = [MISSING];
          if (!Array.isArray(items)) throw new ComposeError("not_a_list", "step '" + id + "' maps over a value that is not a list");
          const answers: unknown[] = [];
          for (const element of items) answers.push(await callOnce(element));
          outputs.set(id, answers);
        } else {
          outputs.set(id, await callOnce(MISSING));
        }
        record.status = "ok";
        record.result = outputs.get(id);
        if (!dryRun && op.effect === "mutation") completed.push({ step: id, connector, op, calls });
      } catch (error) {
        if (!dryRun && op.effect === "mutation" && calls.length > 0) completed.push({ step: id, connector, op, calls });
        record.status = "failed";
        record.error = errorJson(error);
        record.calls_completed = calls.length;
        result.status = "failed";
        result.ok = false;
        result.failed_step = id;
        result.error = record.error;
      }
    }
    if (result.status === "failed") result.compensation = compensation(completed);
    return result;
  }

  /**
   * Run the undo calls a failed run reported, newest first. Your decision,
   * never automatic. An undo that itself needs confirmation is refused unless
   * confirm is true. Entries with no undo are reported, not run.
   */
  async compensate(
    run: FlowRun,
    options: { confirm?: boolean; dryRun?: boolean } = {},
  ): Promise<Array<CompensationEntry & { status: string; result?: unknown; error?: Record<string, unknown> }>> {
    const outcomes: Array<CompensationEntry & { status: string; result?: unknown; error?: Record<string, unknown> }> = [];
    for (const entry of run.compensation) {
      if (!entry.undo) {
        outcomes.push({ ...entry, status: "not_undoable" });
        continue;
      }
      try {
        const answer = await this.composite.call(entry.undo.operation, entry.undo.arguments, {
          connector: entry.connector,
          confirm: options.confirm ?? false,
          dryRun: options.dryRun ?? false,
        });
        outcomes.push({ ...entry, status: "ok", result: answer });
      } catch (error) {
        outcomes.push({ ...entry, status: "failed", error: errorJson(error) });
      }
    }
    return outcomes;
  }
}

function source(value: unknown, request: Record<string, unknown>, response: unknown): Found {
  if (isObject(value) && "const" in value) return value.const;
  let text = String(value);
  const optional = text.endsWith("?");
  if (optional) text = text.slice(0, -1);
  const dot = text.indexOf(".");
  const root = dot < 0 ? text : text.slice(0, dot);
  const path = dot < 0 ? "" : text.slice(dot + 1);
  const found = root === "request" ? walk(request, path) : root === "response" ? walk(response, path) : MISSING;
  return found === MISSING && optional ? null : found;
}

function compensation(
  completed: Array<{ step: string; connector: string; op: Op; calls: Array<[Record<string, unknown>, unknown]> }>,
): CompensationEntry[] {
  const plan: CompensationEntry[] = [];
  for (const { step, connector, op, calls } of [...completed].reverse()) {
    for (let index = calls.length - 1; index >= 0; index--) {
      const [request, response] = calls[index] as [Record<string, unknown>, unknown];
      const entry: CompensationEntry = { step, call: index, connector, operation: op.id, effect_class: op.effectClass };
      if (!op.undo) {
        entry.reason = op.id + " is " + op.effectClass + ": nothing undoes it";
        plan.push(entry);
        continue;
      }
      const args: Record<string, unknown> = {};
      let gap: string | undefined;
      for (const [name, from] of Object.entries(op.undo.arguments)) {
        const value = source(from, request, response);
        if (value === MISSING) {
          gap = JSON.stringify(from) + " names nothing in this call";
          break;
        }
        if (value !== null) args[name] = value;
      }
      if (gap) entry.reason = "undo unavailable: " + gap;
      else entry.undo = { kind: op.undo.kind, operation: op.undo.operation, arguments: args };
      plan.push(entry);
    }
  }
  return plan;
}
`;
