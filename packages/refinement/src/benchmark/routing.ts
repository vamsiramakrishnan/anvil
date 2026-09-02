import type { AirDocument, Operation } from "@anvil/air";
import { mcpToolDescription } from "@anvil/air";
import { type AgentProcessRunner, allowlistedEnv } from "../case/process-runner.js";

/**
 * The routing half of the benchmark: given a natural-language task and a tool
 * catalog, does an agent pick the right tool?
 *
 * This is the question the whole product claims to answer — "the agent stopped
 * guessing" — and until now nothing measured it. The measurement is a paired
 * comparison, because a raw score has no baseline: the same intents are routed
 * over the CURATED catalog (the tool names and descriptions the generated MCP
 * server actually serves, via `mcpToolDescription`) and over a BARE catalog
 * (the names the source document itself supplies, with nothing Anvil authored).
 * The gap between the two is the number that says what compilation bought.
 *
 * The router is pluggable. The built-in lexical router is deterministic — CI
 * needs a score that cannot flake — and deliberately dumb: it models an agent
 * that can only read, not reason, which makes it a FLOOR. A real model routes
 * at least as well, and `--agent <command>` swaps one in through the same
 * process-runner seam the enrichment harness already uses.
 */

export interface RoutableTool {
  /** The name the agent sees — curated: mcp.toolName; bare: source-derived. */
  name: string;
  description: string;
  /** The AIR operation this tool reaches, for scoring. */
  operationId: string;
}

export interface TaskRouter {
  readonly name: string;
  route(intent: string, tools: readonly RoutableTool[]): Promise<string | undefined>;
}

/** The surface the generated MCP server serves: curated names, compiled
 *  descriptions, safety sentences and all. What a real agent sees. */
export function curatedCatalog(operations: readonly Operation[]): RoutableTool[] {
  return operations.map((op) => ({
    name: op.mcp.toolName,
    description: mcpToolDescription(op),
    operationId: op.id,
  }));
}

/**
 * The counterfactual surface: what an agent gets from the source document with
 * nothing Anvil authored — the source's own operation id when it declared one,
 * else the raw method and path, and no description at all. Deliberately not a
 * strawman: a declared operationId is often a perfectly good name, and when the
 * bare catalog routes nearly as well as the curated one, that is a real finding
 * about where curation is NOT earning its keep.
 */
export function bareCatalog(operations: readonly Operation[]): RoutableTool[] {
  return operations.map((op) => ({
    name:
      op.sourceRef.operationId ??
      `${(op.sourceRef.method ?? "call").toUpperCase()} ${op.sourceRef.path ?? op.id}`,
    description: "",
    operationId: op.id,
  }));
}

/* ----------------------------- lexical router ----------------------------- */

/**
 * Function words carry no routing signal, and worse than none: IDF makes a
 * word *distinctive* when only one tool's description happens to use it, so an
 * intent containing "the" routed to whichever tool's prose said "the" — which
 * is a router keyed on grammar, not meaning. Verbs stay: get/list/create ARE
 * the action vocabulary.
 */
const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "to",
  "in",
  "on",
  "for",
  "by",
  "with",
  "and",
  "or",
  "at",
  "as",
  "is",
  "are",
  "was",
  "be",
  "been",
  "it",
  "its",
  "this",
  "that",
  "my",
  "your",
  "our",
  "their",
  "me",
  "you",
  "we",
  "they",
  "do",
  "does",
  "did",
  "please",
  "can",
  "could",
  "would",
  "should",
  "will",
  "up",
  "out",
  "from",
]);

/** Split on non-alphanumerics AND case/underscore boundaries, lowercased:
 *  `createPaymentIntent` → create, payment, intent. */
function tokens(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * Deterministic IDF-weighted token overlap. A token every tool mentions
 * (`payment` in a payments API) tells the router nothing, so it is weighted by
 * how few tools mention it. Name tokens count double: a name is what a model
 * scans first. Ties break lexicographically by tool name so the score is a
 * pure function of the catalog — a benchmark that can flake is a benchmark
 * nobody trusts on a red day.
 */
export function lexicalRouter(): TaskRouter {
  return {
    name: "lexical",
    route(intent, tools) {
      const docs = tools.map((tool) => ({
        tool,
        name: new Set(tokens(tool.name)),
        all: new Set([...tokens(tool.name), ...tokens(tool.description)]),
      }));
      const df = new Map<string, number>();
      for (const d of docs) {
        for (const t of d.all) df.set(t, (df.get(t) ?? 0) + 1);
      }
      const idf = (t: string) => Math.log(1 + docs.length / (df.get(t) ?? docs.length));

      let best: { name: string; score: number } | undefined;
      for (const d of docs) {
        let score = 0;
        for (const t of new Set(tokens(intent))) {
          if (d.name.has(t)) score += 2 * idf(t);
          else if (d.all.has(t)) score += idf(t);
        }
        if (
          score > 0 &&
          (best === undefined ||
            score > best.score ||
            (score === best.score && d.tool.name < best.name))
        ) {
          best = { name: d.tool.name, score };
        }
      }
      return Promise.resolve(best?.name);
    },
  };
}

/* ------------------------------ agent router ------------------------------ */

/**
 * A real model as the router, through the same process-runner seam the
 * enrichment harness uses (`anvil benchmark --agent claude`). The model is
 * asked for a tool NAME and nothing else, and the answer is validated against
 * the catalog — a name it invented is a failed route, never a new tool. Any
 * runner failure is a failed route too: fail closed, exactly like the LLM
 * enrichment agent.
 */
/**
 * Pull the routing answer out of whatever a model actually printed.
 *
 * The first version of this demanded that the command's entire stdout parse as
 * JSON. Pointed at a real model CLI for the first time, that scored 0/20 on a
 * catalog the model had in fact routed correctly every time: models fence their
 * JSON (```json ... ```) and sometimes say a sentence around it. Refusing those
 * answers is not caution, it is a broken measurement — the reading was wrong
 * about the thing it claimed to measure.
 *
 * So the parse is tolerant and the GATE stays strict: this only finds a
 * candidate name, and the caller still refuses any name the served catalog does
 * not contain. Tolerance about syntax, none about which tools exist.
 */
export function extractRoutedTool(stdout: string): string | undefined {
  const text = stdout.trim();
  if (text === "") return undefined;
  // Fenced first (the common case), then the raw text, then the first embedded
  // object — a model that explains itself still names its choice exactly once.
  const candidates: string[] = [];
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
    const body = match[1]?.trim();
    if (body) candidates.push(body);
  }
  candidates.push(text);
  for (const match of text.matchAll(/\{[^{}]*\}/g)) candidates.push(match[0]);

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (typeof parsed === "object" && parsed !== null && "tool" in parsed) {
      const name = (parsed as { tool: unknown }).tool;
      if (typeof name === "string" && name.trim() !== "") return name.trim();
    }
  }
  return undefined;
}

export function agentRouter(
  runner: AgentProcessRunner,
  command: string,
  args: string[] = [],
  timeoutMs = 60_000,
): TaskRouter {
  return {
    name: `agent:${command}`,
    async route(intent, tools) {
      const catalog = tools
        .map((t) => `- ${t.name}${t.description ? `: ${t.description}` : ""}`)
        .join("\n");
      const prompt =
        `You are routing a task to exactly one tool.\n\nTools:\n${catalog}\n\n` +
        `Task: ${intent}\n\n` +
        `Reply with ONLY a JSON object of the form {"tool": "<name>"} naming the ` +
        `single best tool from the list above. No other text.`;
      try {
        const result = await runner.run({
          command,
          args,
          cwd: process.cwd(),
          input: prompt,
          env: allowlistedEnv([]),
          timeoutMs,
        });
        if (result.timedOut || result.canceled || result.exitCode !== 0) return undefined;
        const name = extractRoutedTool(result.stdout);
        if (name === undefined) return undefined;
        return tools.some((t) => t.name === name) ? name : undefined;
      } catch {
        return undefined;
      }
    },
  };
}

/* -------------------------------- scoring --------------------------------- */

export interface RoutingOutcome {
  routed: string | undefined;
  pass: boolean;
}

/** Route one intent over one catalog and score it against the operation the
 *  intent belongs to. */
export async function routeAndScore(
  router: TaskRouter,
  intent: string,
  catalog: readonly RoutableTool[],
  operationId: string,
): Promise<RoutingOutcome> {
  const routed = await router.route(intent, catalog);
  const target = catalog.find((t) => t.operationId === operationId);
  return { routed, pass: routed !== undefined && routed === target?.name };
}

/** Approved operations only — the benchmark measures the exposed surface,
 *  the same filter every generated artifact applies. */
export function benchmarkOperations(air: AirDocument): Operation[] {
  return air.operations.filter(
    (op) => op.state === "approved" && op.archetype !== "webhook_receiver",
  );
}
