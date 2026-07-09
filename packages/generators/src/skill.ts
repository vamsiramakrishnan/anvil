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
    capabilities: air.capabilities.length,
    operations: exposed.length,
    workflows: air.workflows.length,
  });
  files["reference/capabilities.md"] = capabilitiesRef(air);
  files["reference/operations.md"] = operationsRef(exposed);
  files["reference/errors.md"] = errorsRef();
  files["reference/idempotency.md"] = idempotencyRef(exposed);
  files["reference/workflows.md"] = workflowsRef(air, exposed);
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

## Start with capabilities
Agents solve business problems, not URLs. Browse capabilities first:
\`${id} capabilities\` lists them; \`${id} capabilities <name>\` shows the operations
and workflows a capability owns; \`${id} workflows <name>\` shows a multi-step flow.

${capabilitiesList(air)}

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
- \`reference/capabilities.md\` — the capabilities and what each one owns.
- \`reference/operations.md\` — every operation, its inputs, and its safety posture.
- \`reference/idempotency.md\` — the rules for unsafe operations.
- \`reference/errors.md\` — the error taxonomy and how to recover.
- \`reference/workflows.md\` — authored multi-step flows.
- \`schemas/\` — input JSON Schemas. \`examples/\` — worked examples. \`evals/\` — behavior checks.
`;
}

/** A compact capability list for SKILL.md — the primary index. */
function capabilitiesList(air: AirDocument): string {
  if (air.capabilities.length === 0) return "";
  const rows = air.capabilities.map((c) => {
    const name = c.id.split(".").slice(1).join(".") || c.id;
    const wf = c.workflowIds.length ? `, ${c.workflowIds.length} workflow(s)` : "";
    return `- **${name}** — ${c.displayName} (${c.operationIds.length} op(s)${wf})`;
  });
  return `Capabilities:\n${rows.join("\n")}`;
}

function capabilitiesRef(air: AirDocument): string {
  if (air.capabilities.length === 0) return "# Capabilities\n\n_No capabilities discovered._\n";
  const sections = air.capabilities.map((cap) => {
    const ops = cap.operationIds
      .map((id) => air.operations.find((o) => o.id === id))
      .filter((o): o is Operation => Boolean(o))
      .map(
        (o) =>
          `- \`${o.cli.command}\` — ${o.effect.kind}${o.confirmation.required ? " (confirm)" : ""}`,
      );
    const wfs = cap.workflowIds
      .map((id) => air.workflows.find((w) => w.id === id))
      .filter((w): w is AirDocument["workflows"][number] => Boolean(w))
      .map((w) => `- \`${w.id.split(".").pop()}\` — ${w.displayName} (${w.steps.length} steps)`);
    return `## ${cap.displayName}  (\`${cap.id}\`)
${cap.description}

_Grouping: ${cap.source} · confidence ${cap.evidence.confidence.toFixed(2)}_

Operations:
${ops.join("\n") || "- (none)"}
${wfs.length ? `\nWorkflows:\n${wfs.join("\n")}` : ""}`;
  });
  return `# Capabilities

The primary abstraction: agents search for a capability, not a URL. Each
capability owns operations and (authored) workflows.

${sections.join("\n\n")}
`;
}

/** One line listing an operation's inputs (params + projected body). */
function inputList(op: Operation): string {
  const parts = op.input.params.map((p) => `\`${p.name}\`${p.required ? "*" : ""}`);
  const body = op.input.body;
  if (body?.projection === "fields") {
    parts.push(...body.fields.map((f) => `\`${f.name}\`${f.required ? "*" : ""}`));
  } else if (body) {
    parts.push(`\`body\`${body.required ? "*" : ""} (JSON)`);
  }
  return parts.join(", ") || "none";
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
- Inputs: ${inputList(op)}
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

function workflowsRef(air: AirDocument, ops: Operation[]): string {
  const serviceId = air.service.id;

  // Authored workflows are first-class — render them as the ordered steps.
  if (air.workflows.length > 0) {
    const sections = air.workflows.map((wf) => {
      const steps = wf.steps.map((s, i) => {
        const op = air.operations.find((o) => o.id === s.operationId);
        const cmd = op ? op.cli.command : s.operationId;
        return `${i + 1}. \`${cmd}\`${s.optional ? " (optional)" : ""}${s.description ? ` — ${s.description}` : ""}`;
      });
      return `## ${wf.displayName}  (\`${serviceId} workflows ${wf.id.split(".").pop()}\`)
${wf.description}${wf.humanApproval ? "\n\n⚠ Requires human approval before running." : ""}

${steps.join("\n") || "_No steps._"}
${wf.rollbackStrategy ? `\nRollback: ${wf.rollbackStrategy}` : ""}`;
    });
    return `# Workflows

Authored multi-step flows — run \`${serviceId} workflows <name>\` to see steps.

${sections.join("\n\n")}
`;
  }

  // No authored workflows: fall back to a generic inspect→preview→execute hint.
  const read = ops.find((o) => o.effect.kind === "read");
  const write = ops.find((o) => o.effect.kind === "mutation");
  const steps: string[] = [];
  if (read)
    steps.push(`1. Inspect: \`${read.cli.command} --help\` then call it to read current state.`);
  if (write)
    steps.push(
      `2. Preview the write: \`${write.cli.command} ... --dry-run\`.\n3. Execute with confirmation: \`${write.cli.command} ...${write.confirmation.required ? " --confirm" : ""}${write.idempotency.mode === "required" ? " --idempotency-key <key>" : ""}\`.`,
    );
  return `# Workflows

_No workflows authored yet — declare them in the Anvil manifest. Generic pattern:_

${steps.join("\n") || `Explore with \`${serviceId} discover "<intent>"\`.`}
`;
}
