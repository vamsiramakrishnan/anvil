import type { AirDocument, Operation } from "@anvil/air";
import { stringify as toYaml } from "yaml";

/**
 * The skill package (spec §9 + "Progressive disclosure for skills"). SKILL.md
 * stays small — routing and safety only — and defers detail to reference/*.
 * The skill is the operating manual for agents, not prose decoration.
 */
export function generateSkill(air: AirDocument): Record<string, string> {
  const svc = air.service;
  const exposed = air.operations.filter((op) => op.state === "approved");
  const files: Record<string, string> = {};

  files["SKILL.md"] = skillMd(air, exposed);
  files["manifest.yaml"] = toYaml({
    name: svc.id,
    display_name: svc.displayName,
    version: svc.version,
    owner: svc.owner,
    environment: svc.environment,
    auth: svc.auth,
    operations: exposed.length,
  });
  files["reference/operations.md"] = operationsRef(exposed);
  files["reference/errors.md"] = errorsRef();
  files["reference/idempotency.md"] = idempotencyRef(exposed);
  files["reference/workflows.md"] = workflowsRef(air.service.id, exposed);
  return files;
}

function skillMd(air: AirDocument, ops: Operation[]): string {
  const id = air.service.id;
  const reads = ops.filter((o) => o.effect.kind === "read");
  const writes = ops.filter((o) => o.effect.kind === "mutation");
  return `---
name: ${id}
description: Use this skill to operate the ${air.service.displayName ?? id} safely — ${reads.length} read and ${writes.length} write operations, with typed inputs, structured errors, and enforced confirmation on unsafe mutations.
---

# ${air.service.displayName ?? id}

Aligned CLI, MCP server, and this skill are all generated from one Anvil model,
so an operation means the same thing on every surface.

## Use the CLI first
Run \`${id} --help\` before guessing. Then \`${id} discover "<intent>"\` to find an
operation, and \`${id} explain <operation-id>\` to read its contract.

## Safety rules (read before any write)
- **Never** call a mutation without first reading its help / \`explain\`.
- Unsafe mutations refuse to run without \`--confirm\`. That refusal is correct — supply confirmation only when the user intends the effect.
- When an operation says an idempotency key is required, supply \`--idempotency-key\`. Reusing the same key is safe; a new key is a new operation.
- Prefer \`--dry-run\` to preview the request before executing.
- **Do not** retry a mutation unless the tool reports it as retry-safe. Reads and idempotent writes retry automatically; non-idempotent writes never do.

## What this skill exposes
${ops.length === 0 ? "_No operations are approved yet. Run `anvil approve` to expose operations._" : `${ops.length} approved operation(s). For the full catalog, read \`reference/operations.md\`.`}

## Where to look
- \`reference/operations.md\` — every operation, its inputs, and its safety posture.
- \`reference/idempotency.md\` — the rules for unsafe operations.
- \`reference/errors.md\` — the error taxonomy and how to recover.
- \`reference/workflows.md\` — common multi-step flows.
- \`schemas/\` — input JSON Schemas. \`examples/\` — worked examples. \`evals/\` — behavior checks.
`;
}

function operationsRef(ops: Operation[]): string {
  const rows = ops.map((op) => {
    const flags = [
      op.effect.kind,
      op.effect.kind === "mutation" ? op.effect.risk : null,
      op.confirmation.required ? "confirm-required" : null,
      op.idempotency.mode === "required" ? "idempotency-key-required" : null,
      op.retries.mode === "safe" ? "retry-safe" : "not-retry-safe",
    ]
      .filter(Boolean)
      .join(", ");
    return `### \`${op.cli.command}\`  (id: \`${op.id}\`, tool: \`${op.mcp.toolName}\`)
${op.description || op.displayName}

- Semantics: ${flags}
- Auth: ${op.auth.type}${op.auth.scopes.length ? ` (${op.auth.scopes.join(", ")})` : ""}
- Inputs: ${op.input.params.map((p) => `\`${p.name}\`${p.required ? "*" : ""}`).join(", ") || "none"}
${op.skill.intentExamples.length ? `- Example intents: ${op.skill.intentExamples.map((e) => `"${e}"`).join("; ")}` : ""}`;
  });
  return `# Operations\n\n\`*\` marks a required input.\n\n${rows.join("\n\n")}\n`;
}

function idempotencyRef(ops: Operation[]): string {
  const unsafe = ops.filter((o) => o.effect.kind === "mutation");
  const lines = unsafe.map(
    (op) =>
      `- \`${op.cli.command}\`: ${op.idempotency.mode}${op.idempotency.mode === "required" ? ` (key via ${op.idempotency.key})` : ""}; ${op.retries.mode === "safe" ? "retry-safe" : "not retry-safe"}; ${op.confirmation.required ? "confirmation required" : "no confirmation"}.`,
  );
  return `# Idempotency & unsafe operations

The default posture: reads and idempotent writes are retryable; non-idempotent
writes are never retried automatically. Follow these per-operation rules.

${lines.join("\n") || "_No mutations exposed._"}

If you receive \`confirmation_required\` or \`idempotency_required\`, that is the
tool refusing to act unsafely. Supply the requested flag only when the user
intends the effect; do not retry blindly.
`;
}

function errorsRef(): string {
  return `# Errors & recovery

Every error is a structured envelope:

\`\`\`json
{ "error": { "code": "rate_limited", "message": "...", "retryable": true, "safe_to_retry": true, "operation": "...", "trace_id": "..." } }
\`\`\`

Recovery by code:
- \`validation_error\` — fix the input; check \`details.missing\`. Do not retry unchanged.
- \`auth_required\` / \`permission_denied\` — the auth profile lacks access. Stop and report.
- \`not_found\` — the resource does not exist. Do not retry.
- \`conflict\` — the resource already exists or a request with the same idempotency key is in flight. Do not blindly retry.
- \`confirmation_required\` — re-issue with \`--confirm\` only if the user intends the effect.
- \`idempotency_required\` — supply \`--idempotency-key\`.
- \`rate_limited\` / \`upstream_timeout\` / \`upstream_unavailable\` — transient. Retry **only** if \`safe_to_retry\` is true; the tool already retried what it safely could.
- \`policy_denied\` — a local policy blocked the call. Stop and report.
`;
}

function workflowsRef(serviceId: string, ops: Operation[]): string {
  const read = ops.find((o) => o.effect.kind === "read");
  const write = ops.find((o) => o.effect.kind === "mutation");
  const steps: string[] = [];
  if (read)
    steps.push(`1. Inspect: \`${read.cli.command} --help\` then call it to read current state.`);
  if (write)
    steps.push(
      `2. Preview the write: \`${write.cli.command} ... --dry-run\`.\n3. Execute with confirmation: \`${write.cli.command} ...${write.confirmation.required ? " --confirm" : ""}${write.idempotency.mode === "required" ? " --idempotency-key <key>" : ""}\`.`,
    );
  return `# Common workflows

${steps.join("\n") || `Explore with \`${serviceId} discover "<intent>"\`.`}
`;
}
