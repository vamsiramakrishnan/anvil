import type { SdkOperation } from "./plan.js";

/** The generated input type/struct/class name for an operation. */
export function inputTypeName(op: SdkOperation): string {
  return `${op.names.pascal}Input`;
}

/**
 * The call options a caller cannot omit, as source-ish fragments for docs.
 * Derived from the contract, so a README can never promise a call that the
 * safety gate would refuse.
 */
export function requiredCallOptions(op: SdkOperation): string[] {
  const required: string[] = [];
  if (op.confirmation.required) required.push("confirm: true");
  if (op.idempotency.callerKeyRequired) required.push('idempotencyKey: "…"');
  return required;
}

/** A doc comment block in C-style syntax, or "" when there is nothing to say. */
export function docLines(text: string | undefined, indent: string): string {
  const value = (text ?? "").trim();
  if (value.length === 0) return "";
  return `${indent}/** ${value.replace(/\*\//g, "*\\/")} */\n`;
}

/** Wrap prose to a column so generated doc comments stay readable. */
export function wrap(text: string, width = 76): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line.length === 0) line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line.length > 0) lines.push(line);
  return lines.length > 0 ? lines : [""];
}

/**
 * The safety sentences every language repeats verbatim in a method doc. One
 * source for the prose means a Go user and a Java user are told the same thing
 * about the same operation.
 */
export function safetyNotes(op: SdkOperation): string[] {
  const notes = [
    `${op.httpMethod} ${op.path} · operation ${op.id}`,
    `Aligned surfaces: CLI '${op.cliCommand}' · MCP tool '${op.mcpToolName}'`,
    `Effect: ${op.effect}${
      op.effect === "mutation"
        ? ` (risk ${op.risk}, ${op.reversible ? "reversible" : "IRREVERSIBLE"})`
        : ""
    }`,
    `Idempotency: ${op.idempotency.mode} · retry: ${op.retry.mode}`,
  ];
  if (op.confirmation.required) {
    notes.push(
      `Refuses without explicit confirmation${
        op.confirmation.humanApproval ? ", and needs HUMAN approval rather than a self-confirm" : ""
      }${op.confirmation.reason ? ` — ${op.confirmation.reason}` : ""}.`,
    );
  }
  if (op.idempotency.callerKeyRequired) {
    notes.push("Requires a caller-supplied idempotency key; Anvil cannot derive one here.");
  }
  if (op.deprecated) notes.push("Deprecated upstream.");
  return notes;
}
