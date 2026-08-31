import { describe, expect, it } from "vitest";
import { Operation, planWorkflowSurface, type Workflow } from "./index.js";

/**
 * The surface planner is consumed by two sides that must never disagree — the
 * MCP runtime serves its plan and the compiler's capability disclosure budget
 * discounts by it — so its own tests live beside it rather than only behind the
 * server. The end-to-end serving behaviour (tool listing, reporting callbacks,
 * call order) stays asserted in packages/mcp-runtime/src/server.supersede.test.ts.
 *
 * What THIS file exists for is the fixed point. A refused suppression puts a
 * tool back on the surface, and that tool's own async contract can name a third
 * operation whose suppression must now be refused too. Judged once against the
 * static proposal — as a single pass used to — the chain stopped after one
 * link: the plan served a submitter whose `anvil/async_status_tool` pointed at
 * a tool that was not listed, the exact half-contract the refusal exists to
 * prevent.
 */

function op(id: string, toolName: string, overrides?: Partial<Operation>): Operation {
  return Operation.parse({
    id,
    canonicalName: toolName,
    displayName: toolName,
    sourceRef: { kind: "openapi", path: `/${toolName}`, method: "get" },
    effect: { kind: "read", action: "get", resource: "thing", risk: "low", reversible: false },
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
    cli: { command: toolName },
    mcp: { toolName },
    skill: { intentExamples: [] },
    state: "approved",
    output: { schema: { type: "object", properties: { id: { type: "string" } } } },
    ...overrides,
  });
}

/** A read that submits nothing but polls: carries a job handle and a status link. */
function chainLink(id: string, toolName: string, statusOperationId: string): Operation {
  return op(id, toolName, {
    asyncContract: {
      statusOperationId,
      jobIdField: "job_id",
      statusJobIdParam: "job_id",
      terminalStates: ["done"],
      pendingStates: [],
    },
    output: { schema: { type: "object", properties: { job_id: { type: "string" } } } },
    input: {
      params: [
        {
          name: "job_id",
          in: "query",
          required: true,
          schema: { type: "string" },
          inferred: false,
        },
      ],
    },
  });
}

function workflow(steps: string[], supersedes: string[]): Workflow {
  return {
    id: "test.workflow.compose",
    capabilityId: "test.capability",
    displayName: "Compose",
    description: "A composite",
    intentExamples: [],
    steps: steps.map((operationId) => ({
      operationId,
      description: "",
      optional: false,
      bindings: {},
    })),
    humanApproval: false,
    state: "approved",
    evidence: { claims: [] },
    supersedes,
  };
}

function plan(workflows: Workflow[], operations: Operation[]) {
  const byId = new Map(operations.map((operation) => [operation.id, operation]));
  return planWorkflowSurface(workflows, byId, byId);
}

describe("async-status refusals reach a fixed point", () => {
  // A submits and polls B; B itself polls C. `terminalStates`/params are the
  // minimum a contract needs to resolve; `job_id` appears in each output and
  // each status operation's params so `resolveAsyncContract` accepts the link.
  const a = chainLink("test.op1", "op1", "test.op2");
  const b = chainLink("test.op2", "op2", "test.op3");
  const c = chainLink("test.op3", "op3", "test.op4");
  const d = op("test.op4", "op4", {
    input: {
      params: [
        {
          name: "job_id",
          in: "query",
          required: true,
          schema: { type: "string" },
          inferred: false,
        },
      ],
    },
  });

  it("a refusal re-opens the question for everything the kept tool names (A→B→C)", () => {
    // Suppression proposed for B and C, in the order that defeats a single
    // left-to-right pass: C is judged first, while B still looks suppressed, so
    // a one-round plan keeps B (A names it) but leaves C suppressed — serving B
    // with poll coordinates pointing at a tool that is not listed.
    const c3 = op("test.op3", "op3", {
      input: {
        params: [
          {
            name: "job_id",
            in: "query",
            required: true,
            schema: { type: "string" },
            inferred: false,
          },
        ],
      },
    });
    const result = plan(
      [workflow(["test.op1", "test.op2", "test.op3"], ["test.op3", "test.op2"])],
      [a, b, c3],
    );

    // The final plan serves B AND C: neither suppression survives.
    expect([...result.superseded.keys()]).toEqual([]);
    expect(result.refused.map((refusal) => refusal.operationId).sort()).toEqual([
      "test.op2",
      "test.op3",
    ]);
    // The workflow itself still registers — refusing its suppressions keeps
    // tools, it never un-registers the composite.
    expect(result.registrations[0]?.skipReason).toBeUndefined();
  });

  it("the cascade runs to any depth (A→B→C→D needs three rounds)", () => {
    // Proposal order D, C, B: each round can only refuse the link whose
    // submitter the previous round put back, so this chain takes three rounds —
    // one round would refuse B alone and serve it pointing at the absent C.
    const result = plan(
      [
        workflow(
          ["test.op1", "test.op2", "test.op3", "test.op4"],
          ["test.op4", "test.op3", "test.op2"],
        ),
      ],
      [a, b, c, d],
    );

    expect([...result.superseded.keys()]).toEqual([]);
    // Refusals land in cascade order: B's keeps B, which forces C's, which
    // forces D's.
    expect(result.refused.map((refusal) => refusal.operationId)).toEqual([
      "test.op2",
      "test.op3",
      "test.op4",
    ]);
    for (const refusal of result.refused) {
      expect(refusal.reason).toContain("async status operation");
    }
  });

  it("does not over-refuse: a submitter leaving the surface takes its coordinates with it", () => {
    // The workflow supersedes BOTH the submitter A and its status operation B.
    // Nothing still served names B, so both suppressions stand — the fixed
    // point only re-opens questions for tools a refusal actually kept.
    const result = plan(
      [workflow(["test.op1", "test.op2"], ["test.op1", "test.op2"])],
      [a, b, op("test.op3", "op3")],
    );
    expect([...result.superseded.keys()].sort()).toEqual(["test.op1", "test.op2"]);
    expect(result.refused).toEqual([]);
  });
});
