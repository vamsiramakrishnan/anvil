import type { AirDocument, Operation } from "@anvil/air";
import { cliFlag, evidenceConfidence } from "@anvil/air";

/** Human-readable risk/idempotency/retry summary for one operation (`inspect-risk`). */
export function riskSummary(op: Operation): string {
  const lines = [
    `${op.id}  (${op.cli.command})`,
    `  effect:        ${op.effect.kind} / ${op.effect.action}${op.effect.kind === "mutation" ? ` (${op.effect.risk}, ${op.effect.reversible ? "reversible" : "IRREVERSIBLE"})` : ""}`,
    `  idempotency:   ${op.idempotency.mode}${op.idempotency.key ? ` via ${op.idempotency.key}` : ""}`,
    `  retry-safe:    ${op.retries.mode === "safe" ? `yes (${op.retries.basis}; ${op.retries.maxAttempts} attempts, ${op.retries.backoff})` : "no"}`,
    `  confirmation:  ${op.confirmation.required ? "REQUIRED" : "not required"}`,
    `  auth:          ${op.auth.type}${op.auth.scopes.length ? ` [${op.auth.scopes.join(", ")}]` : ""}`,
    `  acts as:       ${op.auth.principal}${op.auth.audience ? ` (aud: ${op.auth.audience})` : ""}`,
    `  state:         ${op.state}`,
    `  confidence:    ${evidenceConfidence(op.evidence).toFixed(2)}`,
  ];
  return lines.join("\n");
}

/** Full contract for one operation (`explain`). */
export function explain(op: Operation): string {
  const paramLines = op.input.params.map(
    (p) =>
      `  ${cliFlag(p.name)}${p.required ? " (required)" : ""}  [${p.in}]  ${p.description ?? typeName(p.schema)}`,
  );
  const body = op.input.body;
  if (body?.projection === "fields") {
    for (const f of body.fields) {
      paramLines.push(
        `  ${cliFlag(f.name)}${f.required ? " (required)" : ""}  [body]  ${f.description ?? typeName(f.schema)}`,
      );
    }
  } else if (body) {
    paramLines.push(
      `  --body${body.required ? " (required)" : ""}  [body:${body.contentType}]  JSON body — structure preserved from the source schema (see --schema).`,
    );
  }
  const params = paramLines.join("\n");
  const errors = op.errors
    .map((e) => `  ${e.code}${e.upstream?.httpStatus ? ` (${e.upstream.httpStatus})` : ""}`)
    .join("\n");
  const safety: string[] = [];
  if (op.confirmation.required) safety.push("Requires --confirm.");
  if (op.idempotency.mode === "required") safety.push("Requires --idempotency-key.");
  safety.push(
    op.retries.mode === "safe"
      ? "Transient failures are retried automatically."
      : "Not retried automatically.",
  );
  return [
    `${op.displayName} — ${op.id}`,
    op.description ? `\n${op.description}` : "",
    `\nUsage: ${op.cli.command} [flags]`,
    `\nInputs:\n${params || "  (none)"}`,
    op.idempotency.mode === "required" ? "  --idempotency-key (required)" : "",
    op.confirmation.required ? "  --confirm (required)" : "",
    `\nSafety: ${safety.join(" ")}`,
    errors ? `\nErrors:\n${errors}` : "",
    op.skill.intentExamples.length
      ? `\nExamples: ${op.skill.intentExamples.map((e) => `"${e}"`).join("; ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function typeName(schema: Record<string, unknown>): string {
  return typeof schema.type === "string" ? schema.type : "value";
}

export interface DiscoverResult {
  hits: Operation[];
  /**
   * False when the best match cleared only one weak signal — the caller must
   * hedge ("no close match; nearest: …") instead of presenting a confident
   * wrong answer. A confident hit matched at least two independent signals.
   */
  confident: boolean;
}

/**
 * Rank approved operations by relevance to a free-text intent (`discover`).
 * Only the approved surface is searchable — discovery must never point an
 * agent at an operation the other surfaces (MCP, skill) refuse to expose.
 */
export function discover(air: AirDocument, intent: string): DiscoverResult {
  // Terms under 3 chars ("a", "to") substring-match almost any haystack and
  // manufactured false confidence; they carry no intent signal, so drop them.
  const terms = intent
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 3);
  const scored = air.operations
    .filter((op) => op.state === "approved")
    .map((op) => {
      const haystack = [
        op.canonicalName,
        op.id,
        op.description,
        op.cli.command,
        ...op.skill.intentExamples,
      ]
        .join(" ")
        .toLowerCase();
      let score = 0;
      for (const term of terms) if (haystack.includes(term)) score += 1;
      // Boost exact resource/action word hits.
      for (const term of terms) if (op.canonicalName.split("_").includes(term)) score += 1;
      return { op, score };
    });
  const hits = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  const best = hits[0]?.score ?? 0;
  return { hits: hits.map((s) => s.op), confident: best >= 2 };
}
