import type { AirDocument, Operation, ParamLocation } from "@anvil/air";
import {
  cliFlag,
  evidenceConfidence,
  idempotencyModeUsesCarrier,
  operationBusinessInputCliFlag,
  operationSafetyInputKeys,
  propKey,
} from "@anvil/air";

/**
 * `required` describes the operation's idempotency contract, not necessarily a
 * caller-required flag. A request-fingerprint policy can derive the key from
 * the validated request; client_supplied/none cannot.
 */
export function requiresExplicitIdempotencyKey(op: Operation): boolean {
  return (
    op.idempotency.mode === "required" && op.idempotency.keyDerivation !== "request_fingerprint"
  );
}

export function recommendsExplicitIdempotencyKey(op: Operation): boolean {
  return op.idempotency.mode === "required" || op.idempotency.mode === "key_supported";
}

/**
 * CLI coordinate for a real source input. Engine safety keeps the familiar
 * `--confirm` / `--idempotency-key`; a business field with either spelling is
 * made reachable through a deterministic `--input-*` flag.
 */
export function businessInputCliFlag(
  op: Operation,
  location: ParamLocation,
  name: string,
): string | undefined {
  return operationBusinessInputCliFlag(op, location, name);
}

/** Convert a public JSON input property back to the flag a CLI user can type. */
export function cliFlagForInputKey(op: Operation, key: string): string {
  const safety = operationSafetyInputKeys(op);
  if (op.confirmation.required && key === safety.confirm) return "--confirm";
  if (idempotencyModeUsesCarrier(op.idempotency.mode) && key === safety.idempotencyKey) {
    return "--idempotency-key";
  }
  for (const parameter of op.input.params) {
    if (propKey(parameter.name) === key) {
      const flag = businessInputCliFlag(op, parameter.in, parameter.name);
      if (flag) return flag;
    }
  }
  if (op.input.body?.projection === "fields") {
    for (const field of op.input.body.fields) {
      if (propKey(field.name) === key) {
        const flag = businessInputCliFlag(op, "body", field.name);
        if (flag) return flag;
      }
    }
  }
  return key === "body" ? "--body" : cliFlag(key);
}

/** Human-readable risk/idempotency/retry summary for one operation (`inspect-risk`). */
export function riskSummary(op: Operation): string {
  const idempotencyDetail =
    recommendsExplicitIdempotencyKey(op) && op.idempotency.keyDerivation === "request_fingerprint"
      ? " (request fingerprint fallback; explicit key recommended)"
      : "";
  const lines = [
    `${op.id}  (${op.cli.command})`,
    `  effect:        ${op.effect.kind} / ${op.effect.action}${op.effect.kind === "mutation" ? ` (${op.effect.risk}, ${op.effect.reversible ? "reversible" : "IRREVERSIBLE"})` : ""}`,
    `  idempotency:   ${op.idempotency.mode}${op.idempotency.key ? ` via ${op.idempotency.key}` : ""}${idempotencyDetail}`,
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
  const paramLines = op.input.params.flatMap((p) => {
    const flag = businessInputCliFlag(op, p.in, p.name);
    return flag
      ? [
          `  ${flag}${p.required ? " (required)" : ""}  [${p.in}]  ${p.description ?? typeName(p.schema)}`,
        ]
      : [];
  });
  const body = op.input.body;
  if (body?.projection === "fields") {
    for (const f of body.fields) {
      const flag = businessInputCliFlag(op, "body", f.name);
      if (flag) {
        paramLines.push(
          `  ${flag}${f.required ? " (required)" : ""}  [body]  ${f.description ?? typeName(f.schema)}`,
        );
      }
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
  if (requiresExplicitIdempotencyKey(op)) {
    safety.push("Requires --idempotency-key.");
  } else if (
    recommendsExplicitIdempotencyKey(op) &&
    op.idempotency.keyDerivation === "request_fingerprint"
  ) {
    safety.push(
      "Derives a request-fingerprint key when omitted; an explicit --idempotency-key is recommended for stable audit/retry correlation.",
    );
  }
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
    requiresExplicitIdempotencyKey(op)
      ? "  --idempotency-key (required)"
      : recommendsExplicitIdempotencyKey(op)
        ? "  --idempotency-key (recommended; deterministic request-fingerprint fallback)"
        : "",
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
