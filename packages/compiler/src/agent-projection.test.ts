import { Operation } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { validate } from "./validate.js";

function operation() {
  return Operation.parse({
    id: "customers.list",
    canonicalName: "list_customers",
    displayName: "List customers",
    description: "Lists customers.",
    sourceRef: { kind: "openapi", path: "/customers", method: "get" },
    effect: { kind: "read", action: "list", resource: "customer" },
    input: { params: [] },
    output: {
      schema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: { customerId: { type: "string" }, displayName: { type: "string" } },
            },
          },
        },
      },
      agentProjection: { include: ["items.nonexistent"] },
    },
    idempotency: { mode: "natural" },
    retries: { mode: "safe", basis: "read_safe" },
    confirmation: { required: false },
    auth: { type: "none" },
    cli: { command: "customers list" },
    mcp: { toolName: "customers_list" },
    skill: { intentExamples: ["List customers"] },
    state: "approved",
  });
}

describe("agent response projection validation", () => {
  it("blocks approved operations whose projection references missing schema paths", () => {
    const result = validate([operation()]);
    expect(result.operations[0]?.state).toBe("blocked");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ level: "error", code: "invalid_agent_projection" }),
    );
  });
});
