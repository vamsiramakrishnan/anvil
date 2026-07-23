import { type Diagnostic, type Operation, resolveIdempotencyCarrier } from "@anvil/air";

export interface ValidationResult {
  operations: Operation[];
  diagnostics: Diagnostic[];
}

/**
 * The safety validator (spec §5.4). It checks that the generated tool surface
 * is coherent and safe, emits diagnostics, and escalates any operation it
 * cannot prove safe to `review_required`. The build fails when unsafe behavior
 * would be generated silently.
 */
export function validate(operations: Operation[]): ValidationResult {
  const diagnostics: Diagnostic[] = [];
  const out: Operation[] = [];
  const seenIds = new Set<string>();
  const seenTools = new Set<string>();
  const seenCommands = new Set<string>();

  for (const original of operations) {
    const op = structuredClone(original);
    const notes: string[] = [...op.reviewNotes];
    let mustReview = false;

    const flag = (level: Diagnostic["level"], code: string, message: string) => {
      diagnostics.push({ level, code, message, operationId: op.id });
    };

    // Uniqueness of every generated name (spec §5.4).
    if (seenIds.has(op.id))
      flag("error", "duplicate_operation_id", `Duplicate operation id '${op.id}'.`);
    seenIds.add(op.id);
    if (seenTools.has(op.mcp.toolName))
      flag("error", "duplicate_tool_name", `Duplicate MCP tool name '${op.mcp.toolName}'.`);
    seenTools.add(op.mcp.toolName);
    if (seenCommands.has(op.cli.command))
      flag("error", "duplicate_cli_command", `Duplicate CLI command '${op.cli.command}'.`);
    seenCommands.add(op.cli.command);

    const carrier = resolveIdempotencyCarrier(op);
    if (!carrier.ok) {
      flag(
        "error",
        "unsupported_idempotency_carrier",
        `Operation '${op.id}' cannot prove its upstream idempotency carrier: ${carrier.issue}.`,
      );
      notes.push(
        `Blocked: the declared idempotency key cannot be injected into an exact modeled request coordinate (${carrier.issue}).`,
      );
      op.retries = {
        ...op.retries,
        mode: "none",
        basis: "unproven",
        maxAttempts: 1,
        backoff: "none",
        retryOn: [],
      };
      op.state = "blocked";
    }

    // Every unsafe operation must have a coherent idempotency + retry posture.
    if (op.effect.kind === "mutation") {
      const proven =
        op.idempotency.mode === "natural" ||
        op.idempotency.mode === "client_id" ||
        op.idempotency.mode === "required" ||
        op.idempotency.mode === "key_supported";

      if (!proven && op.retries.mode === "safe") {
        flag(
          "error",
          "unsafe_retry",
          `Operation '${op.id}' is a non-idempotent mutation but has retries enabled.`,
        );
        op.retries = { ...op.retries, mode: "none", maxAttempts: 1, retryOn: [] };
      }

      if (op.idempotency.mode === "none") {
        flag(
          "warning",
          "unproven_idempotency",
          `Operation '${op.id}' is a mutation with no proven idempotency; auto-retry disabled and confirmation required.`,
        );
        notes.push(
          "Idempotency could not be proven from the source spec; supply a manifest policy to approve retries.",
        );
        mustReview = true;
      }

      if (
        !op.confirmation.required &&
        (op.effect.risk === "financial" || op.effect.risk === "destructive")
      ) {
        flag(
          "error",
          "missing_confirmation",
          `High-risk mutation '${op.id}' does not require confirmation.`,
        );
        op.confirmation = { required: true, risk: op.effect.risk };
      }
    }

    // Retry policy must never fire on an empty condition set.
    if (op.retries.mode === "safe" && op.retries.retryOn.length === 0) {
      flag(
        "warning",
        "empty_retry_conditions",
        `Operation '${op.id}' enables retries with no conditions.`,
      );
      op.retries.mode = "none";
    }

    // Auth scopes must be declared for non-public operations.
    if (op.auth.type !== "none" && op.auth.scopes.length === 0 && op.effect.kind === "mutation") {
      flag("info", "no_declared_scopes", `Mutation '${op.id}' declares auth but no scopes.`);
    }

    // Confirmation must have an idempotency requirement it can point at.
    if (op.confirmation.required && op.idempotency.mode === "none") {
      notes.push(
        "Marked confirmation-required; consider requiring an idempotency key for replay protection.",
      );
    }

    op.reviewNotes = notes;
    if (mustReview && op.state === "generated") op.state = "review_required";
    out.push(op);
  }

  return { operations: out, diagnostics };
}

/** Operations exposed by default: approved only (spec §17). */
export function exposedOperations(operations: Operation[]): Operation[] {
  return operations.filter((op) => op.state === "approved");
}
