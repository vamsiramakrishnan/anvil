import { Operation } from "@anvil/air";
import { describe, expect, it } from "vitest";
import {
  applyProjection,
  MCP_PROJECTION,
  projectionShape,
  takeProjectionArg,
  validateProjection,
} from "./projection.js";

function createOperation(): Operation {
  return Operation.parse({
    id: "test.operation.list",
    canonicalName: "test_list",
    displayName: "Test List",
    sourceRef: { kind: "openapi", path: "/test", method: "get" },
    effect: { kind: "read", action: "list", resource: "test", risk: "low", reversible: false },
    input: { params: [] },
    idempotency: {
      mode: "none",
      mechanism: "header",
      key: "Idempotency-Key",
      keyDerivation: "client_supplied",
    },
    retries: { mode: "safe", maxAttempts: 3, backoff: "exponential", retryOn: ["timeout"] },
    confirmation: { required: false },
    auth: { type: "none", scopes: [] },
    cli: { command: "test list" },
    mcp: { toolName: "test_list" },
    skill: { intentExamples: [] },
    state: "approved",
  });
}

const TRACE = "trace_test";

const page = {
  items: [
    { id: "a", name: "Alpha", description: "x".repeat(200), owner: { email: "a@example.com" } },
    { id: "b", name: "Beta", description: "y".repeat(200), owner: { email: "b@example.com" } },
  ],
  next_page_token: "tok",
};

describe("projection control surface", () => {
  it("publishes the reserved anvil_ namespaced input", () => {
    const shape = projectionShape();
    expect(Object.keys(shape)).toEqual([MCP_PROJECTION]);
    expect(MCP_PROJECTION).toBe("anvil_projection");
  });

  it("peels the control off input so it never reaches the wire request", () => {
    const input: Record<string, unknown> = { limit: 10, [MCP_PROJECTION]: "items[].id" };
    expect(takeProjectionArg(input)).toBe("items[].id");
    expect(MCP_PROJECTION in input).toBe(false);
    expect(input).toEqual({ limit: 10 });
  });

  it("treats a blank or non-string control as absent", () => {
    expect(takeProjectionArg({ [MCP_PROJECTION]: "   " })).toBeUndefined();
    expect(takeProjectionArg({ [MCP_PROJECTION]: 42 })).toBeUndefined();
    expect(takeProjectionArg({})).toBeUndefined();
  });
});

describe("applyProjection", () => {
  it("narrows a page to the selected fields", () => {
    const op = createOperation();
    const result = applyProjection(page, "items[].{id: id, name: name}", op, TRACE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual([
      { id: "a", name: "Alpha" },
      { id: "b", name: "Beta" },
    ]);
  });

  it("shrinks the serialized payload it is asked to shrink", () => {
    const op = createOperation();
    const result = applyProjection(page, "items[].id", op, TRACE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(result.data).length).toBeLessThan(JSON.stringify(page).length / 5);
  });

  it("supports filters, the reason JMESPath was chosen over field lists", () => {
    const op = createOperation();
    const result = applyProjection(page, "items[?id=='b'].name", op, TRACE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual(["Beta"]);
  });
});

describe("applyProjection - fails safe", () => {
  it("returns a normalized validation_error for a malformed expression", () => {
    const op = createOperation();
    const result = applyProjection(page, "items[].{", op, TRACE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.envelope.error.code).toBe("validation_error");
    expect(result.envelope.error.retryable).toBe(false);
    expect(result.envelope.error.operation).toBe(op.id);
    expect(result.envelope.error.trace_id).toBe(TRACE);
  });

  it("never returns the unprojected payload on failure", () => {
    const op = createOperation();
    const result = applyProjection(page, "items[].{", op, TRACE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The whole point: an agent that asked for two fields must not silently
    // receive all of them.
    expect(JSON.stringify(result.envelope)).not.toContain("x".repeat(200));
  });

  it("echoes the caller's expression back so it can repair its own selector", () => {
    const op = createOperation();
    const result = applyProjection(page, "items[].{", op, TRACE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.envelope.error.details).toMatchObject({
      parameter: MCP_PROJECTION,
      expression: "items[].{",
      syntax: "jmespath",
    });
  });

  it("does not throw on any malformed input", () => {
    const op = createOperation();
    for (const expr of ["[", "}{", "a[", "@ | ", "foo(", '"unterminated', "&&&", "items[?]"]) {
      expect(() => applyProjection(page, expr, op, TRACE)).not.toThrow();
      expect(applyProjection(page, expr, op, TRACE).ok).toBe(false);
    }
  });

  it("refuses an expression long enough to be a denial-of-service", () => {
    const op = createOperation();
    const result = applyProjection(page, `items[].${"a.".repeat(600)}id`, op, TRACE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.envelope.error.message).toContain("limit is 1000");
  });
});

describe("applyProjection - never expands disclosure", () => {
  it("refuses a projection that duplicates the response", () => {
    const op = createOperation();
    const result = applyProjection(page, "{a: @, b: @}", op, TRACE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.envelope.error.message).toContain("expanded the response");
  });

  it("refuses a multiselect that repeats a large subtree", () => {
    const op = createOperation();
    const result = applyProjection(page, "[items, items, items]", op, TRACE);
    expect(result.ok).toBe(false);
  });

  it("allows an identity projection", () => {
    const op = createOperation();
    const result = applyProjection(page, "@", op, TRACE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual(page);
  });

  it("allows a rename that costs a few characters more on a tiny payload", () => {
    const op = createOperation();
    const result = applyProjection({ id: "x" }, "{identifier: id}", op, TRACE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({ identifier: "x" });
  });

  it("normalizes a non-match to null rather than a hole", () => {
    const op = createOperation();
    const result = applyProjection({}, "missing", op, TRACE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toBeNull();
  });

  it("leaves the source data unmutated", () => {
    const op = createOperation();
    const before = JSON.stringify(page);
    applyProjection(page, "items[].{id: id}", op, TRACE);
    expect(JSON.stringify(page)).toBe(before);
  });
});

describe("validateProjection", () => {
  it("passes a well-formed expression without evaluating anything", () => {
    const op = createOperation();
    expect(validateProjection("items[].id", op, TRACE)).toBeUndefined();
  });

  it("catches a malformed expression before the upstream call", () => {
    const op = createOperation();
    const result = validateProjection("items[].{", op, TRACE);
    expect(result?.ok).toBe(false);
  });
});
