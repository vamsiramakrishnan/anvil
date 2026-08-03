import type { IdempotencyMode, Operation } from "@anvil/air";
import { type AgentProcessRunner, allowlistedEnv, NodeAgentProcessRunner } from "@anvil/refinement";
import { z } from "zod";
import type { HarnessAgent, HarnessFinding, OperationClaim, ProbeInput } from "./agent.js";
import { pickSearchTool } from "./agent.js";
import { profileFor } from "./profiles.js";

/**
 * Schema for a single finding emitted by the LLM: a structured claim about one
 * operation, extracted from source text.
 */
const LlmFinding = z.object({
  predicate: z.enum(["idempotency.mode", "deprecated", "errors.rate_limited", "description"]),
  value: z.unknown().optional(),
  direction: z.enum(["tighten", "loosen"]),
  // Non-empty: `text.includes("")` is vacuously true, so an empty quote would
  // bypass the grounding check entirely.
  quote: z.string().min(1),
});

const LlmFindingsArray = z.array(LlmFinding);

type LlmFinding = z.infer<typeof LlmFinding>;

/**
 * An LLM-driven harness agent: it runs Claude via the CLI to extract structured
 * claims from source text, then validates and converts them to findings. Unlike
 * the heuristic agent, the LLM widens recall (finding more claims), but trust
 * still comes from the source profile — its confidence/reliability never comes
 * from the model's own numbers.
 */
export class AgentCliHarnessAgent implements HarnessAgent {
  readonly name = "agent-cli";

  private readonly runner: AgentProcessRunner;
  private readonly command: string;
  private readonly args: string[];
  private readonly timeoutMs: number;

  constructor(
    options: {
      runner?: AgentProcessRunner;
      command?: string;
      args?: string[];
      timeoutMs?: number;
    } = {},
  ) {
    this.runner = options.runner ?? new NodeAgentProcessRunner();
    this.command = options.command ?? "claude";
    this.args = options.args ?? ["-p"];
    this.timeoutMs = options.timeoutMs ?? 30000;
  }

  async probe(input: ProbeInput): Promise<HarnessFinding[]> {
    const tool = pickSearchTool(input.tools, input.config);
    if (!tool) return [];

    const scope = input.config.hints.scope.join(" ");
    const seed = input.question
      ? input.question.queries.join(" ")
      : `${input.op.canonicalName} ${input.op.sourceRef.path ?? ""}`;
    const query = `${seed} ${scope}`.trim();

    let text: string;
    try {
      text = await input.source.call(tool, { query });
    } catch {
      return [];
    }
    if (!text) return [];

    const prompt = buildPrompt(input.op, text);

    const result = await this.runner.run({
      command: this.command,
      args: this.args,
      cwd: process.cwd(),
      input: prompt,
      env: allowlistedEnv([]),
      timeoutMs: this.timeoutMs,
    });

    // Fail closed: any runner issue → no findings.
    if (result.timedOut || result.canceled || result.exitCode !== 0) {
      return [];
    }

    let llmFindings: LlmFinding[];
    try {
      const parsed = JSON.parse(result.stdout);
      llmFindings = LlmFindingsArray.parse(parsed);
    } catch {
      // Malformed JSON or schema mismatch → no findings.
      return [];
    }

    // Validate quotes and convert to HarnessFinding[].
    const findings: HarnessFinding[] = [];
    const profile = profileFor(input.config.system);
    const ref = `${input.source.id}:${tool}`;
    const strongHeader = /idempotency-key/i.test(text);

    for (const finding of llmFindings) {
      // Discard mechanically if quote is not a literal substring of source text.
      if (!text.includes(finding.quote)) {
        continue;
      }

      const claim = buildClaim(finding, input.op);
      const evidence = buildEvidence(finding, claim, input.op, profile, ref, strongHeader);

      findings.push({
        operationId: input.op.id,
        sourceId: input.source.id,
        evidence,
        claim,
      });
    }

    return findings;
  }
}

function buildPrompt(op: Operation, sourceText: string): string {
  const effectKind = op.effect.kind === "mutation" ? "mutation" : "read";
  const summary = `Operation: ${op.canonicalName}
ID: ${op.id}
Method & Path: ${op.sourceRef.method ?? "?"} ${op.sourceRef.path ?? "?"}
Effect: ${effectKind}
`;

  return `You are extracting structured claims about an API operation from source text.

${summary}

Source text:
---
${sourceText}
---

Analyze the source text and emit ONLY a JSON array (no other text) of findings. Each finding has:
- predicate: one of "idempotency.mode", "deprecated", "errors.rate_limited", "description"
- value: the value (optional; required for idempotency.mode and description)
- direction: "tighten" or "loosen"
- quote: a VERBATIM substring from the source text supporting this claim

For idempotency.mode, value must be one of: "none", "required", "natural", "key_supported", "client_id"
For deprecated, value is a boolean
For description, value is a string
For errors.rate_limited, value is a boolean

Only emit findings that are clearly supported by the source text. Do not invent claims.
If you find no valid claims, emit an empty array [].

JSON output:`;
}

/**
 * Direction is derived from the claim's own semantics, NEVER from the model's
 * `direction` field. The source text is untrusted external content — trusting a
 * model-asserted direction would let a wiki page talk the model into labeling a
 * retry-enabling mode as "tighten" and sail past the loosen threshold. Mirrors
 * how `HeuristicHarnessAgent` hardcodes direction per claim shape.
 */
function buildClaim(finding: LlmFinding, op: Operation): OperationClaim | undefined {
  switch (finding.predicate) {
    case "idempotency.mode": {
      if (op.effect.kind !== "mutation") return undefined;
      const mode = finding.value as string | undefined;
      if (!["none", "required", "natural", "key_supported", "client_id"].includes(mode ?? "")) {
        return undefined;
      }
      const header =
        mode === "required" && /idempotency-key/i.test(finding.quote)
          ? "Idempotency-Key"
          : undefined;
      return {
        type: "idempotency",
        mode: mode as IdempotencyMode,
        mechanism: header ? "header" : undefined,
        header,
        // mode "none" refuses retries (tighten); every other mode enables them
        // (loosen) and must clear the high-reliability bar in reconcile.
        direction: mode === "none" ? "tighten" : "loosen",
      };
    }
    case "deprecated":
      if (finding.value !== true) return undefined;
      return {
        type: "deprecated",
        value: true,
        direction: "tighten",
      };
    case "description":
      if (typeof finding.value !== "string" || finding.value.trim().length === 0) return undefined;
      return {
        type: "description",
        text: finding.value,
        direction: "tighten",
      };
    case "errors.rate_limited":
      // rate_limited findings produce evidence but no claim (like the heuristic).
      return undefined;
    default:
      return undefined;
  }
}

function buildEvidence(
  finding: LlmFinding,
  claim: OperationClaim | undefined,
  op: Operation,
  profile: ReturnType<typeof profileFor>,
  ref: string,
  strongHeader: boolean,
) {
  let confidence = profile.floor;
  const value: unknown = finding.value;

  // Only the profile's strong marker (Idempotency-Key in the source text) can
  // grant strong confidence — keyed on the DERIVED claim direction, never the
  // model-asserted one, for the same reason buildClaim derives it.
  if (claim?.type === "idempotency" && claim.direction === "loosen" && strongHeader) {
    confidence = profile.strong;
  }

  return {
    subject: op.id,
    predicate: finding.predicate,
    value,
    source: profile.evidenceKind,
    sourceRef: ref,
    method: "doc_scan" as const,
    confidence,
    reliability: confidence,
    note: `${ref} indicates: ${finding.quote}`,
  };
}
