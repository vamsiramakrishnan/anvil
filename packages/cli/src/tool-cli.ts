import { readFileSync } from "node:fs";
import {
  type AirDocument,
  cliFlag,
  type JsonSchema,
  type Operation,
  operationInputSchema,
  propKey,
} from "@anvil/air";
import {
  type CredentialResolver,
  EnvCredentialResolver,
  type ExecuteContext,
  execute,
  FetchTransport,
  loadRuntimeConfig,
  resolveLedger,
  type Transport,
} from "@anvil/runtime";
import { parseArgs } from "./args.js";
import { discover, explain, riskSummary } from "./explain.js";
import { type CliIO, processIO } from "./io.js";

export interface ToolCliDeps {
  transport?: Transport;
  credentials?: CredentialResolver;
  /** Override the idempotency ledger (tests inject a durable one). */
  ledger?: ExecuteContext["ledger"];
  io?: CliIO;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}

/**
 * The shared CLI engine that drives a generated per-service tool. The same
 * engine backs `anvil run`, so the CLI never drifts from AIR. Returns an exit
 * code; all output goes through the injected IO so it is fully testable.
 */
export async function runToolCli(
  air: AirDocument,
  argv: string[],
  deps: ToolCliDeps = {},
): Promise<number> {
  const io = deps.io ?? processIO;
  const svc = air.service.id;
  const { positionals, flags } = parseArgs(argv);
  const head = positionals[0];

  if (!head || head === "help" || flags.help === true) {
    if (positionals.length > 0 && head !== "help") {
      // fallthrough handled below (operation-level help)
    } else {
      io.out(serviceHelp(air));
      return 0;
    }
  }

  switch (head) {
    case "catalog":
      io.out(flags.json ? JSON.stringify(catalog(air), null, 2) : catalogTable(air));
      return 0;
    case "discover": {
      const intent = positionals.slice(1).join(" ");
      const hits = discover(air, intent);
      if (hits.length === 0) {
        io.err(`No operation matches "${intent}". Try \`${svc} catalog\`.`);
        return 1;
      }
      io.out(
        hits.map((op) => `${op.cli.command}  —  ${op.description || op.displayName}`).join("\n"),
      );
      return 0;
    }
    case "explain": {
      const op = findById(air, positionals[1]);
      if (!op) return notFound(io, air, positionals[1]);
      io.out(explain(op));
      return 0;
    }
    case "inspect-risk": {
      const op = findById(air, positionals[1]);
      if (!op) return notFound(io, air, positionals[1]);
      io.out(riskSummary(op));
      return 0;
    }
    case "validate-input": {
      const op = findById(air, positionals[1]);
      if (!op) return notFound(io, air, positionals[1]);
      const input = readInput(flags, deps);
      const missing = requiredMissing(op, input);
      if (missing.length) {
        io.err(JSON.stringify({ valid: false, missing }, null, 2));
        return 1;
      }
      io.out(JSON.stringify({ valid: true }, null, 2));
      return 0;
    }
    case "capabilities": {
      const which = positionals[1];
      if (!which) {
        io.out(flags.json ? JSON.stringify(air.capabilities, null, 2) : capabilitiesTable(air));
        return 0;
      }
      const cap = findCapability(air, which);
      if (!cap) {
        io.err(`No capability "${which}". Try \`${svc} capabilities\`.`);
        return 1;
      }
      io.out(flags.json ? JSON.stringify(cap, null, 2) : capabilityDetail(air, cap));
      return 0;
    }
    case "workflows": {
      const which = positionals[1];
      if (!which) {
        io.out(flags.json ? JSON.stringify(air.workflows, null, 2) : workflowsTable(air));
        return 0;
      }
      const wf = findWorkflow(air, which);
      if (!wf) {
        io.err(`No workflow "${which}". Try \`${svc} workflows\`.`);
        return 1;
      }
      io.out(flags.json ? JSON.stringify(wf, null, 2) : workflowDetail(air, wf));
      return 0;
    }
  }

  // Operation invocation: match the longest command tail against positionals.
  const op = matchOperation(air, positionals);
  if (!op) {
    io.err(
      `Unknown command: ${positionals.join(" ")}\nTry \`${svc} --help\` or \`${svc} discover "<intent>"\`.`,
    );
    return 1;
  }

  // Progressive disclosure short-circuits (spec §7).
  if (flags.help === true) {
    io.out(explain(op));
    return 0;
  }
  if (flags.schema === true) {
    io.out(JSON.stringify(op.input.schema ?? operationInputSchema(op), null, 2));
    return 0;
  }
  if (flags.examples === true) {
    io.out(JSON.stringify(exampleInvocation(op), null, 2));
    return 0;
  }
  if (flags.explain === true) {
    io.out(explain(op));
    return 0;
  }

  return invoke(op, air, flags, deps, io);
}

async function invoke(
  op: Operation,
  air: AirDocument,
  flags: Record<string, string | boolean>,
  deps: ToolCliDeps,
  io: CliIO,
): Promise<number> {
  const env = deps.env ?? process.env;
  const config = loadRuntimeConfig(env);
  const input = buildInput(op, flags, deps);

  const baseUrl = (flags["base-url"] as string) ?? air.service.servers[0]?.url ?? "";
  const allowedHosts = config.allowedHosts.length
    ? config.allowedHosts
    : hostOf(baseUrl)
      ? [hostOf(baseUrl) as string]
      : [];

  const ctx: ExecuteContext = {
    transport: deps.transport ?? new FetchTransport(),
    credentials: deps.credentials ?? new EnvCredentialResolver(env),
    // Wire the idempotency ledger so replay protection actually works from the
    // CLI. ANVIL_LEDGER selects a durable backend; without one the executor
    // fails closed on required-idempotency mutations outside dev.
    ledger: deps.ledger ?? resolveLedger(config.ledger),
    baseUrl,
    authProfile: (flags["auth-profile"] as string) ?? config.authProfile,
    allowedHosts,
    env: config.env,
    retries: flags["no-retries"] === true ? false : undefined,
    timeoutMs: flags.timeout ? Number(flags.timeout) : undefined,
    sleep: deps.sleep,
    now: deps.now,
  };

  const result = await execute(
    op,
    {
      input,
      confirm: flags.confirm === true,
      idempotencyKey: (flags["idempotency-key"] as string) ?? undefined,
      dryRun: flags["dry-run"] === true,
    },
    ctx,
  );

  if (result.outcome === "success") {
    io.out(flags.json === true ? JSON.stringify(result.data, null, 2) : humanSuccess(result.data));
    if (flags.trace === true) io.err(`trace_id=${result.record.traceId}`);
    return 0;
  }
  if (result.outcome === "dry_run") {
    io.out(JSON.stringify(result.plan, null, 2));
    return 0;
  }
  io.err(JSON.stringify(result.envelope, null, 2));
  return 1;
}

/* --------------------------------- helpers -------------------------------- */

function matchOperation(air: AirDocument, positionals: string[]): Operation | undefined {
  const svc = air.service.id;
  // op.cli.command === "<svc> <resource> <action>"; strip the service prefix.
  let best: Operation | undefined;
  let bestLen = 0;
  for (const op of air.operations) {
    const tail = op.cli.command.split(" ").slice(1);
    if (tail.length > positionals.length) continue;
    const matches = tail.every((t, i) => positionals[i] === t);
    if (matches && tail.length > bestLen) {
      best = op;
      bestLen = tail.length;
    }
  }
  void svc;
  return best;
}

function findById(air: AirDocument, id?: string): Operation | undefined {
  if (!id) return undefined;
  return air.operations.find((o) => o.id === id || o.canonicalName === id || o.mcp.toolName === id);
}

function coerce(value: string | boolean, schema: JsonSchema): unknown {
  if (typeof value === "boolean") return value;
  switch (schema.type) {
    case "integer":
      return Number.parseInt(value, 10);
    case "number":
      return Number(value);
    case "boolean":
      return value === "true";
    default:
      return value;
  }
}

function buildInput(
  op: Operation,
  flags: Record<string, string | boolean>,
  deps: ToolCliDeps,
): Record<string, unknown> {
  const base = readInput(flags, deps);
  for (const p of op.input.params) {
    const flagName = cliFlag(p.name).slice(2);
    if (flags[flagName] !== undefined)
      base[propKey(p.name)] = coerce(flags[flagName] as string, p.schema);
  }
  // Body projection: flat scalar fields become individual flags; a `whole` body
  // is supplied as JSON via --body '<json>' (structure preserved end to end).
  const body = op.input.body;
  if (body?.projection === "fields") {
    for (const f of body.fields) {
      const flagName = cliFlag(f.name).slice(2);
      if (flags[flagName] !== undefined)
        base[propKey(f.name)] = coerce(flags[flagName] as string, f.schema);
    }
  } else if (body && typeof flags.body === "string") {
    base.body = JSON.parse(flags.body);
  }
  return base;
}

function readInput(
  flags: Record<string, string | boolean>,
  deps: ToolCliDeps,
): Record<string, unknown> {
  const file = flags.input as string | undefined;
  if (!file) return {};
  void deps;
  return JSON.parse(readFileSync(file, "utf8"));
}

function requiredMissing(op: Operation, input: Record<string, unknown>): string[] {
  const keys = op.input.params.filter((p) => p.required).map((p) => propKey(p.name));
  const body = op.input.body;
  if (body?.projection === "fields") {
    for (const f of body.fields) if (f.required) keys.push(propKey(f.name));
  } else if (body?.required) {
    keys.push("body");
  }
  return keys.filter((k) => input[k] === undefined || input[k] === null || input[k] === "");
}

function exampleInvocation(op: Operation): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of op.input.params) out[propKey(p.name)] = p.example ?? sample(p.schema);
  const body = op.input.body;
  if (body?.projection === "fields") {
    for (const f of body.fields) out[propKey(f.name)] = sample(f.schema);
  } else if (body) {
    out.body = sampleSchema(body.schema);
  }
  if (op.idempotency.mode === "required") out.idempotency_key = `${op.canonicalName}-key`;
  if (op.confirmation.required) out.confirm = true;
  return out;
}

/** A minimal example value for an arbitrary JSON Schema (used for whole bodies). */
function sampleSchema(schema: JsonSchema): unknown {
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  const props = schema.properties as Record<string, JsonSchema> | undefined;
  if (schema.type === "object" && props) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props)) out[k] = sampleSchema(v);
    return out;
  }
  if (schema.type === "array") return [sampleSchema((schema.items as JsonSchema) ?? {})];
  return sample(schema);
}

function sample(schema: JsonSchema): unknown {
  switch (schema.type) {
    case "integer":
      return typeof schema.minimum === "number" ? schema.minimum : 1;
    case "number":
      return 1;
    case "boolean":
      return true;
    default:
      return "example";
  }
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function humanSuccess(data: unknown): string {
  if (data === null || data === undefined) return "OK";
  if (typeof data === "object") return JSON.stringify(data, null, 2);
  return String(data);
}

function notFound(io: CliIO, air: AirDocument, id?: string): number {
  io.err(`No operation "${id ?? ""}". Try \`${air.service.id} catalog\`.`);
  return 1;
}

function catalog(air: AirDocument) {
  return {
    capabilities: air.capabilities.map((c) => ({
      id: c.id,
      displayName: c.displayName,
      operations: c.operationIds.length,
      workflows: c.workflowIds.length,
      state: c.state,
    })),
    operations: air.operations.map((op) => ({
      command: op.cli.command,
      id: op.id,
      capability: op.capabilityId,
      effect: op.effect.kind,
      risk: op.effect.kind === "mutation" ? op.effect.risk : undefined,
      state: op.state,
    })),
  };
}

function findCapability(air: AirDocument, key: string) {
  return air.capabilities.find(
    (c) =>
      c.id === key || c.id.endsWith(`.${key}`) || c.displayName.toLowerCase() === key.toLowerCase(),
  );
}

function findWorkflow(air: AirDocument, key: string) {
  return air.workflows.find(
    (w) =>
      w.id === key || w.id.endsWith(`.${key}`) || w.displayName.toLowerCase() === key.toLowerCase(),
  );
}

function capabilitiesTable(air: AirDocument): string {
  if (air.capabilities.length === 0) return "  (no capabilities)";
  return air.capabilities
    .map((c) => {
      const name = c.id.split(".").slice(1).join(".") || c.id;
      const wf = c.workflowIds.length ? `, ${c.workflowIds.length} workflow(s)` : "";
      return `  ${name.padEnd(20)} ${String(c.operationIds.length).padStart(2)} op(s)${wf}  —  ${c.displayName}`;
    })
    .join("\n");
}

function capabilityDetail(air: AirDocument, cap: AirDocument["capabilities"][number]): string {
  const ops = cap.operationIds
    .map((id) => air.operations.find((o) => o.id === id))
    .filter((o): o is Operation => Boolean(o))
    .map(
      (o) =>
        `  ${o.cli.command.padEnd(34)} ${o.effect.kind}${o.confirmation.required ? " ⚠ confirm" : ""}`,
    );
  const wfs = cap.workflowIds
    .map((id) => air.workflows.find((w) => w.id === id))
    .filter((w): w is AirDocument["workflows"][number] => Boolean(w))
    .map((w) => `  ${w.id.split(".").pop()}  —  ${w.displayName} (${w.steps.length} steps)`);
  return [
    `${cap.displayName} — ${cap.id}`,
    cap.description ? `\n${cap.description}` : "",
    `\nGrouping: ${cap.source} (confidence ${cap.evidence.confidence.toFixed(2)})`,
    `\nOperations:\n${ops.join("\n") || "  (none)"}`,
    wfs.length ? `\nWorkflows:\n${wfs.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function workflowsTable(air: AirDocument): string {
  if (air.workflows.length === 0) {
    return "  (no workflows authored — declare them in the Anvil manifest)";
  }
  return air.workflows
    .map((w) => {
      const name = w.id.split(".").pop() ?? w.id;
      return `  ${name.padEnd(24)} ${String(w.steps.length).padStart(2)} steps  —  ${w.displayName}`;
    })
    .join("\n");
}

function workflowDetail(air: AirDocument, wf: AirDocument["workflows"][number]): string {
  const steps = wf.steps.map((s, i) => {
    const op = air.operations.find((o) => o.id === s.operationId);
    const cmd = op ? op.cli.command : s.operationId;
    return `  ${i + 1}. ${cmd}${s.optional ? " (optional)" : ""}${s.description ? `  —  ${s.description}` : ""}`;
  });
  return [
    `${wf.displayName} — ${wf.id}`,
    wf.description ? `\n${wf.description}` : "",
    wf.humanApproval ? "\n⚠ Requires human approval before running." : "",
    `\nSteps:\n${steps.join("\n") || "  (none)"}`,
    wf.rollbackStrategy ? `\nRollback: ${wf.rollbackStrategy}` : "",
    wf.intentExamples.length
      ? `\nExamples: ${wf.intentExamples.map((e) => `"${e}"`).join("; ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function catalogTable(air: AirDocument): string {
  return air.operations
    .map((op) => {
      const tag = op.effect.kind === "mutation" ? `mutation/${op.effect.risk}` : "read";
      const unsafe = op.confirmation.required ? " ⚠ confirm" : "";
      return `  ${op.cli.command.padEnd(34)} ${tag.padEnd(18)} ${op.state}${unsafe}`;
    })
    .join("\n");
}

function serviceHelp(air: AirDocument): string {
  const svc = air.service.id;
  return [
    `${air.service.displayName ?? svc} — generated by Anvil`,
    `\nUsage: ${svc} <resource> <action> [flags]`,
    `\nDiscovery:`,
    `  ${svc} capabilities            List business capabilities (start here)`,
    `  ${svc} capabilities <name>     Show a capability's operations + workflows`,
    `  ${svc} workflows [<name>]      List workflows, or show one's steps`,
    `  ${svc} catalog                 List all operations`,
    `  ${svc} discover "<intent>"     Find the right operation`,
    `  ${svc} explain <operation>     Show an operation's full contract`,
    `  ${svc} inspect-risk <op>       Show risk/idempotency/retry posture`,
    `\nPer-operation flags:`,
    `  --help --schema --examples --explain --dry-run --json --trace`,
    `  --confirm --idempotency-key <k> --auth-profile <p> --timeout <ms> --no-retries`,
    `  --body '<json>'  (for operations whose body is not a flat object)`,
    `\nCapabilities:`,
    capabilitiesTable(air),
    `\nUnsafe mutations refuse to run without --confirm. That refusal is correct.`,
  ].join("\n");
}
