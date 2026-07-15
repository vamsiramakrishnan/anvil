import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import {
  type AirDocument,
  cliFlag,
  type ErrorCode,
  evidenceConfidence,
  type JsonSchema,
  type Operation,
  operationInputSchema,
  propKey,
} from "@anvil/air";
import { exampleInput, MCP_RESERVED } from "@anvil/generators";
import {
  AnvilError,
  allowedHostsFor,
  type CredentialResolver,
  EnvCredentialResolver,
  type ErrorEnvelope,
  type ExecuteContext,
  execute,
  FetchTransport,
  loadRuntimeConfig,
  resolveLedger,
  type Transport,
  unapprovedOperationError,
} from "@anvil/runtime";
import { discover, explain, riskSummary } from "./explain.js";
import { type CliIO, processIO } from "./io.js";

/*
 * The generated tool CLI keeps its own tiny, dependency-free grammar: --flag
 * value, --flag=value, and boolean --flag. It is deliberately NOT the
 * Commander tree that parses the `anvil` builder commands — a generated CLI's
 * flags come from the AIR operation contract, and `anvil run` forwards them
 * here verbatim.
 */
interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

const BOOLEAN_FLAGS = new Set([
  "confirm",
  "dry-run",
  "json",
  "trace",
  "help",
  "no-retries",
  "all",
  "quiet",
  "allow-degraded-native",
  "allow-uncertified",
  "allow-large",
  // Capability show sections: always boolean so they never swallow a value.
  "operations",
  "auth",
  "evidence",
  // NOTE: the progressive-disclosure views (`--schema`, `--examples`,
  // `--errors`, `--policy`, `--explain`) are deliberately NOT here. A real
  // operation can have a parameter of the same name — Oracle ORDS's
  // `/{schema}/{table}` has a required `schema` param — and forcing the flag
  // boolean makes that parameter unreachable (`--schema example` would trigger
  // the schema view and drop "example"), silently breaking CLI↔MCP wire
  // agreement. Semantics: a BARE flag (`--schema`) is the disclosure view; a
  // VALUED flag (`--schema example`, which `--schema=example` already did) sets
  // the operation parameter. The disclosure short-circuits fire only on
  // `=== true`, so bare-vs-valued disambiguates cleanly.
]);

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else if (
        BOOLEAN_FLAGS.has(body) ||
        i + 1 >= argv.length ||
        (argv[i + 1] as string).startsWith("--")
      ) {
        flags[body] = true;
      } else {
        flags[body] = argv[++i] as string;
      }
    } else {
      positionals.push(token);
    }
  }
  return { positionals, flags };
}

/**
 * The stable exit-code contract for generated CLIs. Scripts and agents branch
 * on these, so the mapping is versioned behavior — extend it, never reshuffle.
 *   0 — success (including --dry-run previews and disclosure views)
 *   1 — usage error: unknown command / operation / capability / workflow
 *   2 — invalid input (validation_error, schema_mismatch)
 *   3 — safety refusal the caller can satisfy with flags
 *       (confirmation_required, idempotency_required; see error.required_flags)
 *   4 — auth failure (auth_required, permission_denied)
 *   5 — policy refusal (policy_denied, unsafe_retry_blocked,
 *       idempotency_ledger_unavailable, unsupported_operation)
 *   6 — upstream state disagrees (not_found, conflict)
 *   7 — upstream availability (rate_limited, upstream_timeout,
 *       upstream_unavailable, unknown_upstream_error)
 */
export const EXIT_CODES: Record<ErrorCode, number> = {
  validation_error: 2,
  schema_mismatch: 2,
  confirmation_required: 3,
  idempotency_required: 3,
  auth_required: 4,
  permission_denied: 4,
  policy_denied: 5,
  unsafe_retry_blocked: 5,
  idempotency_ledger_unavailable: 5,
  unsupported_operation: 5,
  not_found: 6,
  conflict: 6,
  rate_limited: 7,
  upstream_timeout: 7,
  upstream_unavailable: 7,
  unknown_upstream_error: 7,
};

export function exitCodeFor(code: ErrorCode): number {
  return EXIT_CODES[code] ?? 1;
}

export interface ToolCliDeps {
  transport?: Transport;
  credentials?: CredentialResolver;
  /** Override the idempotency ledger (tests inject a durable one). */
  ledger?: ExecuteContext["ledger"];
  io?: CliIO;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  /** Absolute path to this bundle's local `mcp/server.js`, used by `--mcp stdio`.
   *  The generated CLI passes its own sibling; `anvil run <dir>` passes
   *  `<dir>/mcp/server.js`. Absent ⇒ resolved relative to the running script. */
  mcpServerPath?: string;
  /** Test seam: connect an MCP client to a target and return a minimal client. */
  mcpConnect?: (target: string, deps: ToolCliDeps) => Promise<McpToolClient>;
}

/** The slice of the MCP client the CLI uses — a tool call and a close. */
export interface McpToolClient {
  callTool(req: { name: string; arguments: Record<string, unknown> }): Promise<{
    content?: Array<{ type?: string; text?: string }>;
    structuredContent?: unknown;
    isError?: boolean;
  }>;
  close(): Promise<void>;
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
  // The CLI's operation universe is the APPROVED surface — the same projection
  // the MCP server registers and the skill documents (spec §17). air.json
  // carries every compiled operation; only approved ones may be visible here.
  const approved = air.operations.filter((op) => op.state === "approved");
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
      const { hits, confident } = discover(air, intent);
      if (hits.length === 0) {
        io.err(`No operation matches "${intent}". Try \`${svc} catalog\`.`);
        return 1;
      }
      const lines = hits.map((op) => `${op.cli.command}  —  ${op.description || op.displayName}`);
      if (!confident) {
        // A weak best match must never read as a confident answer — hedge and
        // exit non-zero so scripts do not act on a probably-wrong operation.
        io.err(`No close match for "${intent}". Nearest by keyword overlap:`);
        io.err(lines.join("\n"));
        return 1;
      }
      io.out(lines.join("\n"));
      return 0;
    }
    case "explain": {
      const op = findById(approved, positionals[1]);
      if (!op) return hiddenOrNotFound(io, air, positionals[1]);
      io.out(explain(op));
      return 0;
    }
    case "inspect-risk": {
      const op = findById(approved, positionals[1]);
      if (!op) return hiddenOrNotFound(io, air, positionals[1]);
      io.out(riskSummary(op));
      return 0;
    }
    case "validate-input": {
      const op = findById(approved, positionals[1]);
      if (!op) return hiddenOrNotFound(io, air, positionals[1]);
      let input: Record<string, unknown>;
      try {
        input = readInput(flags, deps);
      } catch (err) {
        if (err instanceof JsonFlagError) return jsonFlagRefusal(io, op, err);
        throw err;
      }
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

  // Operation invocation: match the longest command tail against positionals —
  // against the approved surface only.
  const op = matchOperation(approved, positionals);
  if (!op) {
    // An explicitly-typed command for a compiled-but-unapproved operation must
    // explain WHY it is absent and what would expose it (structured refusal,
    // exit 5) — never a misleading "unknown command".
    const hidden = matchOperation(air.operations, positionals);
    if (hidden) return refuseUnapproved(hidden, io);
    // The middle of the help hierarchy: a resource group. A partial command
    // lists the group's operations, so `--help` alone walks root → group →
    // operation without ever needing the catalog.
    const group = groupOperations(approved, positionals);
    if (group.length > 0) {
      io.out(groupHelp(air, positionals, group));
      return flags.help === true ? 0 : 1;
    }
    // A group that exists only below the approval line gets the same why-absent
    // treatment as a single hidden operation.
    const hiddenGroup = groupOperations(air.operations, positionals);
    if (hiddenGroup.length > 0) {
      io.err(
        `No approved operations under \`${positionals.join(" ")}\`. ` +
          `${hiddenGroup.length} operation(s) exist here but are not approved; review with ` +
          "`anvil inspect <bundle>`, then expose with `anvil approve <bundle> <op-id>`.",
      );
      return exitCodeFor("unsupported_operation");
    }
    const suggestion = nearestCommand(approved, positionals);
    io.err(
      `Unknown command: ${positionals.join(" ")}\n` +
        (suggestion ? `Did you mean \`${svc} ${suggestion}\`?\n` : "") +
        `Try \`${svc} --help\` or \`${svc} discover "<intent>"\`.`,
    );
    return 1;
  }

  // Progressive disclosure short-circuits (spec §7). Each view answers one
  // question; the full schema/policy/error detail never prints unrequested.
  if (flags.help === true || flags.explain === true) {
    io.out(explain(op));
    return 0;
  }
  if (flags.schema === true) {
    io.out(JSON.stringify(op.input.schema ?? operationInputSchema(op), null, 2));
    return 0;
  }
  if (flags.examples === true) {
    // One example synthesizer for every surface: the skill's worked examples
    // are built from `exampleInput` (@anvil/generators), so --examples must be
    // the same object — two synthesizers would eventually disagree.
    io.out(JSON.stringify(exampleInput(op), null, 2));
    return 0;
  }
  if (flags.errors === true) {
    io.out(JSON.stringify(errorsView(op), null, 2));
    return 0;
  }
  if (flags.policy === true) {
    io.out(JSON.stringify(policyView(op), null, 2));
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

  // A flag outside the operation's contract is refused, never silently
  // swallowed — a typo on an OPTIONAL flag would otherwise silently change
  // semantics, and a typo on a required one would misreport as "missing input".
  const known = knownFlagsFor(op);
  const unknown = Object.keys(flags).filter((f) => !known.has(f));
  if (unknown.length > 0) {
    const rendered = unknown.map((f) => {
      const hit = nearest(f, known);
      return hit ? `--${f} (did you mean --${hit}?)` : `--${f}`;
    });
    return cliValidationError(
      io,
      op.id,
      `Unknown flag(s): ${rendered.join(", ")}. See \`${op.cli.command} --help\` for the accepted flags.`,
      { unknown_flags: unknown.map((f) => `--${f}`) },
    );
  }

  let input: Record<string, unknown>;
  try {
    input = buildInput(op, flags, deps);
  } catch (err) {
    if (err instanceof JsonFlagError) return jsonFlagRefusal(io, op, err);
    throw err;
  }

  // skill → CLI → MCP: when a target is configured, this invocation is routed
  // through an MCP server (local stdio or remote SSE) instead of executing
  // directly. The server holds the credentials, egress allowlist, and idempotency
  // ledger; the CLI just maps flags → tool args (carrying the safety controls as
  // reserved anvil_* args) and renders the result. Unset ⇒ direct execution.
  const mcpTarget =
    typeof flags.mcp === "string" ? flags.mcp : (deps.env ?? process.env).ANVIL_MCP_TARGET;
  if (typeof mcpTarget === "string" && mcpTarget.length > 0) {
    return invokeViaMcp(
      op,
      input,
      {
        confirm: flags.confirm === true,
        dryRun: flags["dry-run"] === true,
        idempotencyKey: (flags["idempotency-key"] as string) ?? undefined,
      },
      mcpTarget,
      deps,
      io,
    );
  }

  const baseUrl = (flags["base-url"] as string) ?? air.service.servers[0]?.url ?? "";
  const allowedHosts = allowedHostsFor(config.allowedHosts, baseUrl, true);

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
  renderMissingFlags(result.envelope, op);
  io.err(JSON.stringify(result.envelope, null, 2));
  return exitCodeFor(result.envelope.error.code);
}

interface McpSafety {
  confirm: boolean;
  dryRun: boolean;
  idempotencyKey?: string;
}

/**
 * Route one operation call through an MCP server (local stdio or remote SSE)
 * instead of executing it directly. Flags are already mapped to `input`; the
 * safety controls ride as the reserved `anvil_*` args the server understands, so
 * the same dry-run / confirm / idempotency contract holds over the hop. The
 * server's response — success data, a dry-run plan, or a structured error
 * envelope — is rendered exactly as the direct path renders it, and the error
 * envelope's code drives the same exit-code contract.
 */
async function invokeViaMcp(
  op: Operation,
  input: Record<string, unknown>,
  safety: McpSafety,
  target: string,
  deps: ToolCliDeps,
  io: CliIO,
): Promise<number> {
  // Map the CLI's safety flags onto what the MCP tool expects. `confirm` and
  // `idempotency_key` are synthesized INPUT fields (present in the published
  // schema exactly when the op requires them), so they go into the arguments as
  // ordinary input; dry-run rides the reserved anvil_ arg. Only add confirm /
  // idempotency_key when the schema has them, or strict validation would reject
  // an unknown field on a read.
  const args: Record<string, unknown> = { ...input };
  if (safety.dryRun) args[MCP_RESERVED.dryRun] = true;
  if (safety.confirm && op.confirmation.required) args.confirm = true;
  if (safety.idempotencyKey && op.idempotency.mode === "required")
    args.idempotency_key = safety.idempotencyKey;

  let client: McpToolClient;
  try {
    client = deps.mcpConnect
      ? await deps.mcpConnect(target, deps)
      : await connectMcpClient(target, deps);
  } catch (err) {
    io.err(
      JSON.stringify(
        {
          error: {
            code: "upstream_unavailable",
            message: `Could not connect to the MCP server '${target}': ${err instanceof Error ? err.message : String(err)}`,
          },
        },
        null,
        2,
      ),
    );
    return exitCodeFor("upstream_unavailable");
  }

  try {
    const res = await client.callTool({ name: op.mcp.toolName, arguments: args });
    const text =
      res.content?.find((c) => c.type === "text")?.text ??
      JSON.stringify(res.structuredContent ?? res, null, 2);
    if (res.isError) {
      io.err(text);
      return exitCodeFromEnvelopeText(text);
    }
    io.out(text);
    return 0;
  } finally {
    await client.close().catch(() => {});
  }
}

/** Map a server-returned error-envelope JSON back onto the CLI exit-code contract. */
function exitCodeFromEnvelopeText(text: string): number {
  try {
    const code = (JSON.parse(text) as ErrorEnvelope).error?.code;
    if (code) return exitCodeFor(code);
  } catch {
    // not an envelope — fall through
  }
  return exitCodeFor("unknown_upstream_error");
}

/** Connect a real MCP client to `target`: `stdio`/`local` spawns the bundle's
 *  `mcp/server.js`; anything else is treated as an SSE URL (an optional `sse:`
 *  prefix is stripped). Transports are imported lazily so the direct path never
 *  loads the client SDK. */
async function connectMcpClient(target: string, deps: ToolCliDeps): Promise<McpToolClient> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const client = new Client({ name: "anvil-cli", version: "1.0.0" }, { capabilities: {} });
  if (target === "stdio" || target === "local") {
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const serverPath = deps.mcpServerPath ?? defaultLocalServerPath();
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [serverPath],
        env: (deps.env ?? process.env) as Record<string, string>,
      }),
    );
  } else {
    const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
    const url = target.startsWith("sse:") ? target.slice(4) : target;
    await client.connect(new SSEClientTransport(new URL(url)));
  }
  return client as unknown as McpToolClient;
}

/** Best-effort local server path when the caller didn't pass one: the generated
 *  CLI lives at `cli/<svc>.mjs`, so its sibling MCP server is `../mcp/server.js`. */
function defaultLocalServerPath(): string {
  const self = process.argv[1] ?? "";
  return resolvePath(dirname(self), "..", "mcp", "server.js");
}

/**
 * The executor reports missing inputs by their machine (snake_case) keys; at
 * the CLI boundary the caller supplies FLAGS, so the human message must name
 * `--kebab-case` flags. The machine field (`details.missing`) stays snake_case;
 * the flag rendering rides alongside it as `details.missing_flags`.
 */
function renderMissingFlags(envelope: ErrorEnvelope, op: Operation): void {
  if (envelope.error.code !== "validation_error") return;
  const details = envelope.error.details as
    | { missing?: unknown; missing_flags?: string[] }
    | undefined;
  if (!details || !Array.isArray(details.missing)) return;
  const flagNames = details.missing.map((k) => cliFlag(String(k)));
  details.missing_flags = flagNames;
  envelope.error.message = `Missing required flag(s): ${flagNames.join(", ")}. See \`${op.cli.command} --examples\` for a complete invocation.`;
}

/* --------------------------------- helpers -------------------------------- */

function matchOperation(ops: Operation[], positionals: string[]): Operation | undefined {
  // op.cli.command === "<svc> <resource> <action>"; strip the service prefix.
  let best: Operation | undefined;
  let bestLen = 0;
  for (const op of ops) {
    const tail = op.cli.command.split(" ").slice(1);
    if (tail.length > positionals.length) continue;
    const matches = tail.every((t, i) => positionals[i] === t);
    if (matches && tail.length > bestLen) {
      best = op;
      bestLen = tail.length;
    }
  }
  return best;
}

function findById(ops: Operation[], id?: string): Operation | undefined {
  if (!id) return undefined;
  return ops.find((o) => o.id === id || o.canonicalName === id || o.mcp.toolName === id);
}

/**
 * The structured refusal for an operation that is compiled but not approved.
 * Mirrors the executor's own gate (same code, message, and next action) so an
 * agent learns WHY the command is absent instead of hitting a dead end.
 */
function refuseUnapproved(op: Operation, io: CliIO): number {
  const err = unapprovedOperationError(op, `trace_${randomUUID()}`);
  io.err(JSON.stringify(err.toEnvelope(), null, 2));
  return exitCodeFor("unsupported_operation");
}

/** Lookup miss on explain/inspect-risk/validate-input: unapproved beats unknown. */
function hiddenOrNotFound(io: CliIO, air: AirDocument, id?: string): number {
  const hidden = findById(air.operations, id);
  if (hidden) return refuseUnapproved(hidden, io);
  return notFound(io, air, id);
}

/**
 * Malformed JSON handed to --body / --input must surface as a structured
 * validation_error (exit 2) that names the flag and the parse failure — never
 * a raw SyntaxError stack trace colliding with usage-error exit codes.
 */
class JsonFlagError extends Error {
  constructor(
    readonly flag: string,
    readonly reason: string,
  ) {
    super(`Invalid JSON in ${flag}: ${reason}`);
    this.name = "JsonFlagError";
  }
}

function parseJsonFlag(text: string, flag: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new JsonFlagError(flag, err instanceof Error ? err.message : String(err));
  }
}

function jsonFlagRefusal(io: CliIO, op: Operation, err: JsonFlagError): number {
  return cliValidationError(
    io,
    op.id,
    `${err.message}. See \`${op.cli.command} --examples\` for a valid input shape.`,
    { flag: err.flag, parse_error: err.reason },
  );
}

/** Emit a CLI-side validation_error envelope (same shape the executor produces). */
function cliValidationError(
  io: CliIO,
  operation: string,
  message: string,
  details: unknown,
): number {
  const err = new AnvilError({
    code: "validation_error",
    message,
    operation,
    traceId: `trace_${randomUUID()}`,
    details,
  });
  io.err(JSON.stringify(err.toEnvelope(), null, 2));
  return exitCodeFor("validation_error");
}

/**
 * Engine-owned flags every operation invocation accepts. Only flags the invoke
 * path actually consumes belong here — anything else is a probable typo and
 * must be refused, not swallowed.
 */
const GLOBAL_OPERATION_FLAGS = [
  "help",
  "explain",
  "schema",
  "examples",
  "errors",
  "policy",
  "json",
  "trace",
  "dry-run",
  "confirm",
  "no-retries",
  "idempotency-key",
  "auth-profile",
  "base-url",
  "timeout",
  "input",
  // Route this invocation THROUGH an MCP server instead of executing directly:
  // `--mcp stdio` (spawn the bundle's local mcp/server.js) or `--mcp <sse-url>`
  // (a remote SSE server). Env ANVIL_MCP_TARGET sets the same. skill → CLI → MCP.
  "mcp",
] as const;

function knownFlagsFor(op: Operation): Set<string> {
  const known = new Set<string>(GLOBAL_OPERATION_FLAGS);
  for (const p of op.input.params) known.add(cliFlag(p.name).slice(2));
  const body = op.input.body;
  if (body?.projection === "fields") {
    // `fields` bodies are supplied per-field; --body would be silently ignored,
    // so it is deliberately NOT known here and gets refused with a suggestion.
    for (const f of body.fields) known.add(cliFlag(f.name).slice(2));
  } else if (body) {
    known.add("body");
  }
  return known;
}

/** Levenshtein distance — inputs are short flag/command names, O(n·m) is fine. */
function editDistance(a: string, b: string): number {
  const prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0] as number;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j] as number;
      prev[j] = Math.min(
        tmp + 1,
        (prev[j - 1] as number) + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diag = tmp;
    }
  }
  return prev[b.length] as number;
}

/** Nearest candidate within a plausible-typo distance, or undefined. */
function nearest(typed: string, candidates: Iterable<string>): string | undefined {
  let best: { candidate: string; distance: number } | undefined;
  for (const candidate of candidates) {
    const distance = editDistance(typed, candidate);
    if (!best || distance < best.distance) best = { candidate, distance };
  }
  if (!best) return undefined;
  // A "suggestion" further than ~a third of the candidate is noise, not a typo.
  return best.distance <= Math.max(2, Math.ceil(best.candidate.length / 3))
    ? best.candidate
    : undefined;
}

/** Nearest approved command tail for an unknown command ("did you mean …?"). */
function nearestCommand(ops: Operation[], positionals: string[]): string | undefined {
  return nearest(
    positionals.join(" "),
    ops.map((op) => op.cli.command.split(" ").slice(1).join(" ")),
  );
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
    base.body = parseJsonFlag(flags.body, "--body");
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
  return parseJsonFlag(readFileSync(file, "utf8"), "--input") as Record<string, unknown>;
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

/** Operations whose command tail begins with the given positionals (a resource group). */
function groupOperations(ops: Operation[], positionals: string[]): Operation[] {
  if (positionals.length === 0) return [];
  return ops.filter((op) => {
    const tail = op.cli.command.split(" ").slice(1);
    return positionals.length < tail.length && positionals.every((p, i) => tail[i] === p);
  });
}

function groupHelp(air: AirDocument, prefix: string[], ops: Operation[]): string {
  const svc = air.service.id;
  const lines = ops.map((op) => {
    const tag = op.effect.kind === "mutation" ? `mutation/${op.effect.risk}` : "read";
    const confirm = op.confirmation.required ? "  (requires --confirm)" : "";
    return `  ${op.cli.command.padEnd(34)} ${tag.padEnd(18)} ${op.displayName}${confirm}`;
  });
  return [
    `${svc} ${prefix.join(" ")} — operations`,
    "",
    ...lines,
    "",
    `Run \`${svc} <resource> <action> --help\` for one operation's contract.`,
  ].join("\n");
}

/**
 * The `--errors` view: the operation's declared failure taxonomy plus the full
 * stable exit-code table, so a caller can branch on outcomes without any
 * out-of-band documentation.
 */
function errorsView(op: Operation) {
  return {
    operation: op.id,
    errors: op.errors.map((e) => ({
      code: e.code,
      upstream_status: e.upstream?.httpStatus,
      message: e.message,
      exit_code: exitCodeFor(e.code),
    })),
    exit_codes: EXIT_CODES,
  };
}

/** The `--policy` view: the safety posture an agent must respect before invoking. */
function policyView(op: Operation) {
  const requiredFlags: string[] = [];
  if (op.confirmation.required) requiredFlags.push("--confirm");
  if (op.idempotency.mode === "required") requiredFlags.push("--idempotency-key");
  return {
    operation: op.id,
    state: op.state,
    deprecated: op.deprecated,
    effect: {
      kind: op.effect.kind,
      action: op.effect.action,
      risk: op.effect.risk,
      reversible: op.effect.reversible,
    },
    idempotency: { mode: op.idempotency.mode, key: op.idempotency.key },
    retries: {
      mode: op.retries.mode,
      basis: op.retries.basis,
      max_attempts: op.retries.maxAttempts,
    },
    confirmation: { required: op.confirmation.required, reason: op.confirmation.reason },
    auth: { type: op.auth.type, scopes: op.auth.scopes, principal: op.auth.principal },
    required_flags: requiredFlags,
  };
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

/** Operation ids on the approved surface (all listing views project onto this). */
function approvedIds(air: AirDocument): Set<string> {
  return new Set(air.operations.filter((op) => op.state === "approved").map((op) => op.id));
}

function catalog(air: AirDocument) {
  const exposed = approvedIds(air);
  return {
    capabilities: air.capabilities.map((c) => ({
      id: c.id,
      displayName: c.displayName,
      operations: c.operationIds.filter((id) => exposed.has(id)).length,
      workflows: c.workflowIds.length,
      state: c.state,
    })),
    operations: air.operations
      .filter((op) => exposed.has(op.id))
      .map((op) => ({
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
  const exposed = approvedIds(air);
  return air.capabilities
    .map((c) => {
      const name = c.id.split(".").slice(1).join(".") || c.id;
      const wf = c.workflowIds.length ? `, ${c.workflowIds.length} workflow(s)` : "";
      const count = c.operationIds.filter((id) => exposed.has(id)).length;
      return `  ${name.padEnd(20)} ${String(count).padStart(2)} op(s)${wf}  —  ${c.displayName}`;
    })
    .join("\n");
}

function capabilityDetail(air: AirDocument, cap: AirDocument["capabilities"][number]): string {
  const ops = cap.operationIds
    .map((id) => air.operations.find((o) => o.id === id))
    .filter((o): o is Operation => Boolean(o) && o?.state === "approved")
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
    `\nGrouping: ${cap.source} (confidence ${evidenceConfidence(cap.evidence).toFixed(2)})`,
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
    .filter((op) => op.state === "approved")
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
    `  ${svc} <resource> --help       List one resource group's operations`,
    `  ${svc} workflows [<name>]      List workflows, or show one's steps`,
    `  ${svc} catalog                 List all operations`,
    `  ${svc} discover "<intent>"     Find the right operation`,
    `  ${svc} explain <operation>     Show an operation's full contract`,
    `  ${svc} inspect-risk <op>       Show risk/idempotency/retry posture`,
    `\nPer-operation flags:`,
    `  --help --schema --examples --errors --policy --explain --dry-run --json --trace`,
    `  --confirm --idempotency-key <k> --auth-profile <p> --timeout <ms> --no-retries`,
    `  --body '<json>'  (for operations whose body is not a flat object)`,
    `  --mcp stdio | <sse-url>  (route this call through a local or remote MCP server)`,
    `\nCapabilities:`,
    capabilitiesTable(air),
    `\nUnsafe mutations refuse to run without --confirm. That refusal is correct.`,
  ].join("\n");
}
