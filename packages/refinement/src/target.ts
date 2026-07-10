/**
 * A **semantic target** is the precise coordinate a refinement acts on — never a
 * file, never a line of generated Markdown, but the node in AIR whose semantics
 * are deficient. Refinements refine semantics; Anvil re-projects the artifacts.
 * Keeping the target abstract is what lets one patch improve the CLI help, the
 * MCP tool schema, and the skill reference at once instead of drifting apart.
 */
export type SemanticTarget =
  | { kind: "service" }
  | { kind: "capability"; capabilityId: string }
  | { kind: "operation"; operationId: string }
  /** A single input field, addressed by its projection path, e.g. `input.body.reason`. */
  | { kind: "field"; operationId: string; path: string }
  /** An enum-typed field whose values are opaque, addressed like a field. */
  | { kind: "enum"; operationId: string; path: string }
  /** One declared error of an operation, addressed by its Anvil error code. */
  | { kind: "error"; operationId: string; code: string }
  | { kind: "workflow"; workflowId: string };

/**
 * A stable, collision-free key for a target — used to dedupe deficiencies and to
 * sort a plan deterministically. Two detectors that flag the same coordinate
 * produce the same key.
 */
export function targetKey(t: SemanticTarget): string {
  switch (t.kind) {
    case "service":
      return "service";
    case "capability":
      return `capability:${t.capabilityId}`;
    case "operation":
      return `operation:${t.operationId}`;
    case "field":
      return `field:${t.operationId}#${t.path}`;
    case "enum":
      return `enum:${t.operationId}#${t.path}`;
    case "error":
      return `error:${t.operationId}#${t.code}`;
    case "workflow":
      return `workflow:${t.workflowId}`;
  }
}

/** A human-readable coordinate for plan output, e.g. `payments.refunds.create input.body.reason`. */
export function describeTarget(t: SemanticTarget): string {
  switch (t.kind) {
    case "service":
      return "service";
    case "capability":
      return t.capabilityId;
    case "operation":
      return t.operationId;
    case "field":
    case "enum":
      return `${t.operationId} ${t.path}`;
    case "error":
      return `${t.operationId} (${t.code})`;
    case "workflow":
      return t.workflowId;
  }
}

/**
 * The operation a target belongs to, if any — so a plan can report "N deficiencies
 * across M operations" without special-casing each target kind.
 */
export function targetOperationId(t: SemanticTarget): string | undefined {
  switch (t.kind) {
    case "operation":
    case "field":
    case "enum":
    case "error":
      return t.operationId;
    default:
      return undefined;
  }
}
