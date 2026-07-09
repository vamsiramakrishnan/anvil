import type { EvidenceItem, IdempotencyMode, Operation } from "@anvil/air";
import type { McpSource } from "./mcp-source.js";
import { profileFor } from "./profiles.js";
import type { SourceConfig } from "./sources.js";

/**
 * A structured claim about one operation, extracted from a source. Claims — not
 * free text — are what the reconciler acts on, so an untrusted wiki page can
 * never smuggle instructions into AIR. `direction` says whether the claim makes
 * the operation safer (`tighten`) or riskier (`loosen`).
 */
export type OperationClaim =
  | {
      type: "idempotency";
      mode: IdempotencyMode;
      mechanism?: "header" | "query" | "body" | "path";
      header?: string;
      direction: "loosen" | "tighten";
    }
  | { type: "confirmation"; required: boolean; direction: "loosen" | "tighten" }
  | { type: "deprecated"; value: boolean; direction: "tighten" }
  | { type: "description"; text: string; direction: "tighten" };

export interface HarnessFinding {
  operationId: string;
  sourceId: string;
  evidence: EvidenceItem;
  claim?: OperationClaim;
}

export interface ProbeInput {
  op: Operation;
  source: McpSource;
  config: SourceConfig;
  tools: Array<{ name: string; description?: string }>;
}

/**
 * A harness agent decides which of a source's MCP tools to call and turns the
 * results into findings. It is pluggable so a real LLM agent (Claude Code,
 * Codex) can replace the built-in heuristic without touching orchestration.
 */
export interface HarnessAgent {
  name: string;
  probe(input: ProbeInput): Promise<HarnessFinding[]>;
}

/**
 * Pick the source's search tool: explicit hint first, then the system profile's
 * preferred tools (in order) if the server advertises them, then any tool whose
 * name looks like search.
 */
function searchToolName(input: ProbeInput): string | undefined {
  if (input.config.hints.searchTool) return input.config.hints.searchTool;
  const available = new Set(input.tools.map((t) => t.name));
  const preferred = profileFor(input.config.system).searchTools.find((t) => available.has(t));
  if (preferred) return preferred;
  return input.tools.find((t) => /search|find|query|list/i.test(t.name))?.name;
}

const IDEMPOTENT_KEY = /idempotenc/i;
const NOT_IDEMPOTENT = /\b(not idempotent|do not retry|never retry|non-idempotent)\b/i;
const DEPRECATED = /deprecat/i;
const RATE_LIMIT = /\b(rate[ -]?limit|429|throttl)/i;

/**
 * A deterministic, no-LLM agent: it runs the source's search tool for the
 * operation and extracts conservative claims from the returned text. It only
 * ever proposes *tightening* safety on its own weak (doc-level) evidence;
 * loosening requires stronger evidence, enforced later by the reconciler.
 */
export class HeuristicHarnessAgent implements HarnessAgent {
  readonly name = "heuristic";

  async probe(input: ProbeInput): Promise<HarnessFinding[]> {
    const tool = searchToolName(input);
    if (!tool) return [];
    const scope = input.config.hints.scope.join(" ");
    const query = `${input.op.canonicalName} ${input.op.sourceRef.path ?? ""} ${scope}`.trim();

    let text: string;
    try {
      text = await input.source.call(tool, { query });
    } catch {
      return [];
    }
    if (!text) return [];

    const findings: HarnessFinding[] = [];
    const profile = profileFor(input.config.system);
    const ref = `${input.source.id}:${tool}`;
    const strongHeader = /idempotency-key/i.test(text);
    const base = (note: string, confidence = profile.floor): EvidenceItem => ({
      kind: profile.evidenceKind,
      ref,
      note,
      confidence,
    });
    const finding = (evidence: EvidenceItem, claim?: OperationClaim): HarnessFinding => ({
      operationId: input.op.id,
      sourceId: input.source.id,
      evidence,
      claim,
    });

    if (NOT_IDEMPOTENT.test(text)) {
      findings.push(
        finding(base(`${input.source.id} indicates this operation is not idempotent`), {
          type: "idempotency",
          mode: "none",
          direction: "tighten",
        }),
      );
    } else if (IDEMPOTENT_KEY.test(text) && input.op.effect.kind === "mutation") {
      // A strong signal (the literal Idempotency-Key) gets the profile's `strong`
      // weight; only code hosts set that high enough to clear the loosen bar.
      const confidence = strongHeader ? profile.strong : profile.floor;
      findings.push(
        finding(base(`${input.source.id} references an idempotency key`, confidence), {
          type: "idempotency",
          mode: "required",
          mechanism: strongHeader ? "header" : undefined,
          header: strongHeader ? "Idempotency-Key" : undefined,
          direction: "loosen", // enabling retries reduces safety — must clear the threshold
        }),
      );
    }

    if (DEPRECATED.test(text)) {
      findings.push(
        finding(base(`${input.source.id} mentions deprecation`), {
          type: "deprecated",
          value: true,
          direction: "tighten",
        }),
      );
    }

    if (RATE_LIMIT.test(text) && input.op.errors.every((e) => e.code !== "rate_limited")) {
      findings.push(finding(base(`${input.source.id} documents rate limiting for this operation`)));
    }

    if (findings.length === 0) {
      // Even a bare hit is corroborating evidence for the operation's existence.
      findings.push(finding(base(`${input.source.id} references this operation`)));
    }
    return findings;
  }
}
